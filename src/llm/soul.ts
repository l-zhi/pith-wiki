import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pithWikiHome } from '../paths.js';

/**
 * SOUL.md 加载器。
 *
 * 设计意图：让用户能用一份 markdown 给 REPL 对话注入"灵魂"——tone、persona、
 * 偏好、回答风格。类似 Claude Code 的 CLAUDE.md / OpenCode 的 AGENTS.md，但
 * 仅作用于 **REPL 对话** 的 system prompt，不动 hydration 那条 JSON 输出链路
 * （结构化生成里掺个性容易破坏 schema）。
 *
 * 查找顺序（首条命中即用作 explicit override；否则走默认双层叠加）：
 *
 *   1. 显式：`soulFile` 配置字段 / `PITH_WIKI_SOUL` 环境变量
 *      → 只读这一份，找不到不退化
 *
 *   2. 默认双层叠加：
 *      a. `~/.pith-wiki/SOUL.md`        — 跨工作区的"我的风格"
 *      b. `<workspaceRoot>/SOUL.md`    — 当前项目的覆盖/扩展
 *      存在哪份就拼哪份；两份都存在则前者在前、后者在后。
 *
 * 拼接形式：在 base system prompt 之后追加 `## Voice and style\n\n<content>`。
 * 找不到任何 SOUL.md → 返回空字符串，调用方按需跳过追加。
 *
 * 沙箱：SOUL.md 内容直接进 system prompt——是用户自愿声明的，不做内容审查。
 * 但只读固定位置（home + workspaceRoot + 显式 path），不会被 LLM 工具调用诱导加载。
 */

export interface SoulLookupOptions {
  /** 显式 override：CLI `--soul <path>` 或配置文件里的 `soulFile`。 */
  soulFile?: string;
  /** workspaceRoot：用于解析 `<workspaceRoot>/SOUL.md` 默认位置。 */
  workspaceRoot: string;
}

export interface LoadedSoul {
  /**
   * 拼装后的 markdown 文本（trimmed）。空字符串 = 没找到任何 SOUL.md，
   * 此时调用方不应往 system prompt 里加 "## Voice and style" 头。
   */
  content: string;
  /**
   * 实际读到的文件绝对路径列表，顺序与拼装顺序一致。
   * 给 `/soul` slash 命令和 dashboard 显示用，不影响 prompt 内容。
   */
  sources: string[];
}

/** `<pithWikiHome>/SOUL.md` 绝对路径。懒求值，便于测试 monkey-patch env / homedir。 */
function userDefaultPath(): string {
  return path.join(pithWikiHome(), 'SOUL.md');
}

export const SOUL_PROMPT_HEADER = '## Voice and style';

export function loadSoul(opts: SoulLookupOptions): LoadedSoul {
  // 1. 显式 override：CLI flag > env > 都没有 → 落到默认双层
  const explicit = opts.soulFile ?? process.env.PITH_WIKI_SOUL;
  if (explicit && explicit.trim()) {
    const abs = path.resolve(expandHome(explicit.trim()));
    if (!fs.existsSync(abs)) return { content: '', sources: [] };
    const text = readSafe(abs);
    if (!text.trim()) return { content: '', sources: [] };
    return { content: text.trim(), sources: [abs] };
  }

  // 2. 默认双层叠加：user-global → project-local
  const projectDefault = path.join(opts.workspaceRoot, 'SOUL.md');
  const sources: string[] = [];
  const parts: string[] = [];
  const seen = new Set<string>();
  // user-global 在前：相当于"我的风格基线"
  // project-local 在后：当前项目可以追加或覆盖（LLM 会更重视后出现的内容）
  // 去重：桌面端 workspaceRoot === pithWikiHome，两条路径会指向同一文件——
  // 不 dedupe 就会把同一份 SOUL 拼两遍。按 realpath 判重。
  for (const p of [userDefaultPath(), projectDefault]) {
    if (!fs.existsSync(p)) continue;
    let key = path.resolve(p);
    try {
      key = fs.realpathSync(key);
    } catch {
      /* 读不到 realpath 就用 resolve 后的路径判重 */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readSafe(p);
    if (text.trim()) {
      sources.push(p);
      parts.push(text.trim());
    }
  }
  return { content: parts.join('\n\n'), sources };
}

/**
 * 把 SOUL.md 内容追加到 base system prompt 末尾。
 *
 * soul.content 为空时直接返回 basePrompt，不留空段头。
 */
export function composeSystemPrompt(basePrompt: string, soul: LoadedSoul): string {
  if (!soul.content.trim()) return basePrompt;
  return `${basePrompt}\n\n${SOUL_PROMPT_HEADER}\n\n${soul.content.trim()}`;
}

function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
