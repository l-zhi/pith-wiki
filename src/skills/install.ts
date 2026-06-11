import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureSkillsDir, type Config } from '../config.js';
import { loadSkill } from './index.js';
import type { Skill, SkillRequirement } from './types.js';

/**
 * Skill 安装/卸载的核心逻辑 —— 纯逻辑,返回结构化结果或抛错,不碰 console /
 * process.exitCode。CLI 子命令(skillCommands.ts)与 REPL(/skill add|remove)
 * 共用同一份实现,各自负责自己的输出层。
 */

/**
 * 识别 `skill add` 的来源是不是 git。支持:
 *   - 完整 URL:https:// / git@ / 以 .git 结尾
 *   - GitHub 短名:owner/repo(两段均以字母数字开头,排除 ./ ../ 这类本地路径;
 *     本地存在同名路径时让位给本地)
 * 返回可直接喂给 `git clone` 的 URL,非 git 源返回 null。
 */
export function resolveGitSource(src: string): string | null {
  if (/^(https?|git|ssh):\/\//.test(src) || /^git@/.test(src) || src.endsWith('.git')) {
    return src;
  }
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(src) && !fs.existsSync(path.resolve(src))) {
    return `https://github.com/${src}.git`;
  }
  return null;
}

/** git clone --depth 1 到一个临时目录,返回该目录。失败抛错。 */
function cloneToTemp(url: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-skill-'));
  const res = spawnSync('git', ['clone', '--depth', '1', url, tmp], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const stderr = (res.stderr || '').trim();
    throw new Error(`git clone failed${stderr ? `: ${stderr}` : ''}`);
  }
  return tmp;
}

/**
 * 检测 skill 声明的 requires,返回 PATH 上找不到的那些(不代装)。
 * 用 shell 内建 `command -v` 探测(比 spawn 目标 bin --version 稳健)。
 */
export function checkRequirements(skill: Skill): SkillRequirement[] {
  return skill.requires.filter((r) => {
    const res = spawnSync('command', ['-v', r.bin], { shell: true, stdio: 'ignore' });
    return res.status !== 0;
  });
}

export interface InstallResult {
  skill: Skill;
  /** 最终落地目录(skillDirs[0]/<name>)。 */
  dest: string;
  /** 来源是否为 git(用于输出层措辞)。 */
  fromGit: boolean;
  gitUrl?: string;
  /** PATH 上缺失的依赖二进制(调用方决定怎么提示)。 */
  missingRequires: SkillRequirement[];
}

export class SkillExistsError extends Error {
  constructor(public readonly name: string, public readonly dest: string) {
    super(`Skill "${name}" already exists at ${dest}`);
    this.name = 'SkillExistsError';
  }
}

/**
 * 从本地目录 / git URL / owner-repo 短名安装一个 skill。
 *
 * 流程:(git 源)clone 到临时目录 → loadSkill 校验 → 复制进 skillDirs[0](剥离
 * .git)。已存在同名且未 force → 抛 SkillExistsError。任何校验失败抛普通 Error。
 * 临时目录在 finally 清理。
 */
export function installSkillFromSource(
  source: string,
  config: Config,
  opts: { force?: boolean } = {},
): InstallResult {
  const gitUrl = resolveGitSource(source);
  let srcDir: string;
  let cleanup: (() => void) | null = null;

  if (gitUrl) {
    srcDir = cloneToTemp(gitUrl);
    cleanup = () => fs.rmSync(srcDir, { recursive: true, force: true });
  } else {
    srcDir = path.resolve(source);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      throw new Error(`Not a directory: ${srcDir}`);
    }
  }

  try {
    const skill = loadSkill(srcDir); // frontmatter + 非空正文校验，失败抛错

    ensureSkillsDir(config);
    const destRoot = config.skillDirs[0];
    if (!destRoot) throw new Error('No skillDirs configured to install into.');

    const dest = path.join(destRoot, skill.name);
    if (fs.existsSync(dest)) {
      if (!opts.force) throw new SkillExistsError(skill.name, dest);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    // skill 是纯内容，版本控制元数据无意义 —— 复制时剥掉 .git。
    fs.cpSync(srcDir, dest, { recursive: true, filter: (s) => path.basename(s) !== '.git' });

    // dest 上重新 loadSkill 一次，确保返回的 dir 指向已安装位置。
    const installed = loadSkill(dest);
    return {
      skill: installed,
      dest,
      fromGit: !!gitUrl,
      ...(gitUrl ? { gitUrl } : {}),
      missingRequires: checkRequirements(installed),
    };
  } finally {
    cleanup?.();
  }
}

export interface RemoveResult {
  name: string;
  dir: string;
}

/**
 * 按 name 卸载已安装 skill(删目录)。在 skillDirs 里逐个找;找不到返回 null。
 * 只删落在某个 skillDir 直接子目录的 skill —— 防止 name 含路径片段时越界删除。
 */
export function removeSkillByName(name: string, config: Config): RemoveResult | null {
  for (const root of config.skillDirs) {
    const dir = path.join(root, name);
    // path.join 会归一化 `../`，确保结果仍是 root 的直接子目录
    if (path.dirname(dir) !== path.resolve(root)) continue;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { name, dir };
    }
  }
  return null;
}
