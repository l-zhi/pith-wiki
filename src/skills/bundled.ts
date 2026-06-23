import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/**
 * 内置（捆绑）skill：随 npm 包分发的一批可选 skill，放在包根的 `bundled-skills/`。
 *
 * 关键：bundled-skills **不在** config.skillDirs 里 —— 所以 buildSkillRegistry
 * 不会发现它们，不进 catalog、不挂工具、不暴露 slash 命令。也就是说：装之前
 * 它们对每次对话的上下文零成本（不污染）。用户 `skill add <name>` 时才从这里
 * 复制到生效的 skillDirs[0]，零下载、离线可用。
 *
 * 定位：从本模块所在目录向上查找含 `bundled-skills` 的祖先目录。兼容多种布局：
 *   - CLI 源码：`<pkg>/src/skills/bundled.ts` → 上溯命中 `<pkg>/bundled-skills`
 *   - 发布包：`<pkg>/dist/skills/bundled.js` → 同上
 *   - 桌面端打包：@core 被 electron-vite 内联进 `desktop/out/main/chunks/*.js`，
 *     运行时 import.meta.url 指向该 chunk → 上溯命中仓库根 `bundled-skills`
 * 固定「上两级」在桌面端布局下会落到 `out/` 而失配，故改为上溯搜索。
 * package.json 的 files 必须带上 "bundled-skills" 才会进发布包。
 */

const SKILL_FILE = 'SKILL.md';

/** 从模块目录向上查找含 bundled-skills 的祖先；找不到回退到「上两级」规则。 */
function findBundledSkillsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'bundled-skills');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到达文件系统根
    dir = parent;
  }
  return path.resolve(moduleDir, '..', '..', 'bundled-skills');
}

/** 包根下的 bundled-skills 目录绝对路径。 */
export const BUNDLED_SKILLS_DIR = findBundledSkillsDir();

export interface BundledSkillInfo {
  name: string;
  description: string;
  /** 捆绑源目录（只读分发，skill add 时复制到 skillDirs[0]）。 */
  dir: string;
}

/**
 * 列出捆绑目录里的 skill（name + description）。只读 frontmatter，解析失败的跳过。
 * baseDir 可注入便于测试；缺省用 BUNDLED_SKILLS_DIR。
 */
export function listBundledSkills(baseDir: string = BUNDLED_SKILLS_DIR): BundledSkillInfo[] {
  if (!fs.existsSync(baseDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BundledSkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(baseDir, e.name);
    const file = path.join(dir, SKILL_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      const fm = matter(fs.readFileSync(file, 'utf8')).data as Record<string, unknown>;
      const name = typeof fm.name === 'string' ? fm.name : e.name;
      const description = typeof fm.description === 'string' ? fm.description : '';
      out.push({ name, description, dir });
    } catch {
      // 坏 frontmatter 的捆绑 skill 直接忽略（不致命）
    }
  }
  return out;
}

/**
 * 按名字解析一个内置 skill 的源目录。命中返回目录路径，否则 null。
 * 先按 frontmatter name 匹配（与 install 落地名一致），再退回目录名匹配。
 */
export function resolveBundledSkill(
  name: string,
  baseDir: string = BUNDLED_SKILLS_DIR,
): string | null {
  const byName = listBundledSkills(baseDir).find((s) => s.name === name);
  if (byName) return byName.dir;
  // 目录名兜底（frontmatter name 与目录名通常一致）
  const dir = path.join(baseDir, name);
  if (path.dirname(dir) === path.resolve(baseDir) && fs.existsSync(path.join(dir, SKILL_FILE))) {
    return dir;
  }
  return null;
}
