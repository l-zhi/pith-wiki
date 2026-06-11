import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SkillRegistry } from './registry.js';
import { type Skill, SkillFrontmatterSchema } from './types.js';

export { SkillRegistry } from './registry.js';
export {
  type Skill,
  type SkillFrontmatter,
  type SkillRequirement,
  type HttpAllowRule,
  SkillFrontmatterSchema,
  SKILL_NAME_RE,
  COMMAND_BIN_RE,
  HTTP_HOST_RE,
} from './types.js';

const SKILL_FILE = 'SKILL.md';

export interface BuildSkillRegistryOptions {
  /** 发现目录列表(绝对路径),按顺序扫描;后面的目录同名覆盖前面的。 */
  skillDirs: string[];
  /** 非致命问题(malformed skill)的回调。 */
  onWarn?: (msg: string) => void;
}

/**
 * 扫 skillDirs,建出 SkillRegistry。
 *
 * - 每个目录扫一层子目录,含 SKILL.md 的即一个 skill;跳过 dotdir(与 library.scanAll 一致)。
 * - frontmatter 解析 / 校验失败 → 跳过 + warn,绝不致命(与 library 容错策略一致)。
 * - 同名后扫到的覆盖先扫到的(skillDirs 顺序即优先级,project-local 在后 → 胜出)。
 *
 * 保持 async 签名,与转换器流水线同构(REPL / 子命令在 buildContext 前 await 它)。
 */
export async function buildSkillRegistry(
  opts: BuildSkillRegistryOptions,
): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const warn = opts.onWarn ?? (() => {});

  for (const dir of opts.skillDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const skillDir = path.join(dir, e.name);
      if (!fs.existsSync(path.join(skillDir, SKILL_FILE))) continue;
      try {
        registry.register(loadSkill(skillDir));
      } catch (err) {
        warn(`Skipping skill at ${skillDir}: ${(err as Error).message}`);
      }
    }
  }

  return registry;
}

/**
 * 从一个 skill 目录加载出 Skill。校验失败抛错(由调用方决定跳过 / 报错)。
 * 也被 `skill add` 子命令复用来在拷贝前验证源目录。
 */
export function loadSkill(skillDir: string): Skill {
  const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf8');
  const parsed = matter(raw);
  const fm = SkillFrontmatterSchema.parse(parsed.data);
  const body = parsed.content.trim();
  if (!body) throw new Error('skill has an empty body');
  return {
    name: fm.name,
    description: fm.description,
    body,
    dir: skillDir,
    commands: fm.commands,
    requires: fm.requires,
    httpAllow: fm.http_allow,
  };
}
