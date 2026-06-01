/**
 * Slash 命令注册表。
 *
 * 单一真相：InputBox 的实时提示、Tab 补全、App.tsx 的 dispatch、`/help` 的展示
 * 都从这里读，避免三个地方各写一份命令名稳上漂。
 *
 * 新增命令时改这里就够了；分发逻辑见 App.tsx 的 handleSlashCommand。
 */

export interface SlashCommand {
  /** 含 `/` 前缀。 */
  name: string;
  /** 一行说明，提示框 + /help 共用。 */
  description: string;
  /**
   * 该命令是否接收参数。
   * true → Tab 补全后追加一个空格，提示用户继续输入参数（例：`/digest <collection>`）。
   */
  takesArg?: boolean;
  /** 等价别名（`/exit` 与 `/quit`），主条目放 `name`，别名放这里。 */
  aliases?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands and tools.' },
  { name: '/clear', description: 'Clear the on-screen messages (does not reset agent memory).' },
  { name: '/reset', description: 'Reset the agent conversation (forget context).' },
  { name: '/transcript', description: 'Print the path of the current session transcript file.' },
  {
    name: '/digest',
    description: 'Distill current conversation into a wiki entry (optional collection arg).',
    takesArg: true,
  },
  {
    name: '/provider',
    description: 'Show or switch active LLM provider (use without arg to list configured ones).',
    takesArg: true,
  },
  {
    name: '/converters',
    description: 'List registered file → text converters (with extensions and priorities).',
  },
  {
    name: '/dashboard',
    description: 'Re-render the startup dashboard (collections, watchers, queue summary).',
  },
  {
    name: '/queue',
    description:
      'Inspect / manage the ingest queue. Subcommands: (none|dead) list dead jobs · status · retry <id> · retry-all · clear-dead',
    takesArg: true,
  },
  {
    name: '/verbose',
    description: 'Toggle inline think / tool detail (default off). Affects subsequent turns only.',
  },
  {
    name: '/soul',
    description:
      'Show the active SOUL.md (voice/style overrides). Edit the file + restart REPL to apply.',
  },
  { name: '/exit', description: 'Exit the REPL.', aliases: ['/quit'] },
];

/** 按前缀过滤命令（含别名匹配）。空前缀（"/"）返回全部主条目。 */
export function filterCommands(prefix: string): SlashCommand[] {
  if (!prefix.startsWith('/')) return [];
  // 取第一个空格之前的部分作为命令前缀；空格之后是参数，不参与过滤。
  const head = prefix.split(/\s/, 1)[0];
  return SLASH_COMMANDS.filter((c) => {
    if (c.name.startsWith(head)) return true;
    return c.aliases?.some((a) => a.startsWith(head)) ?? false;
  });
}

/**
 * 给定当前输入和匹配列表，计算 Tab 补全后的新输入。
 *
 * 规则：
 *   - 0 个匹配 → 不变
 *   - 1 个匹配 → 替换为该命令名（takesArg 时追加一个空格）
 *   - 多个匹配 → 替换为它们的最长公共前缀（让用户继续多打几个字符再 Tab）
 *
 * 已经包含参数（含空格）时不补全，让用户自由编辑参数部分。
 */
export function completeOnTab(input: string, matches: SlashCommand[]): string {
  if (!input.startsWith('/')) return input;
  if (input.includes(' ')) return input; // 已进入参数区
  if (matches.length === 0) return input;
  if (matches.length === 1) {
    const c = matches[0];
    return c.takesArg ? `${c.name} ` : c.name;
  }
  const lcp = longestCommonPrefix(matches.map((c) => c.name));
  return lcp.length > input.length ? lcp : input;
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let i = 0;
  const first = strs[0];
  while (i < first.length && strs.every((s) => s[i] === first[i])) i += 1;
  return first.slice(0, i);
}
