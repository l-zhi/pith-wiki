/**
 * 终端 UI 的共享调色板（design palette → ink color）。
 *
 * ink 在 truecolor 终端用 hex，否则自动降到 16 色近似。
 * Dashboard、Markdown 正文渲染等都引用这一份，避免色值分散。
 *
 * 语义口径：green=done/ready · cyan=watch/system · amber=running/exts ·
 * pink=dead/强调 · purple=brand。
 */
export const C = {
  green: '#34d399',
  cyan: '#67e8f9',
  amber: '#fbbf24',
  pink: '#f472b6',
  purple: '#a78bfa',
} as const;
