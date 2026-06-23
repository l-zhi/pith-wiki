/**
 * 定时任务输入里的**日期占位符**解析。
 *
 * 痛点：任务文案写「昨天」「今天」时，agent 靠自己推断日期不可靠（曾把昨天算成别的日子）。
 * 改为在**触发时**把占位符替换成确定日期再喂给 agent —— 模型拿到的是写死的 `2026-06-17`，
 * 不再需要日期感。
 *
 * 语法：`${<格式> [偏移]}`
 *   - 格式 token：`yyyy`(四位年) `yy`(两位年) `mm`(两位月) `m`(月) `dd`(两位日) `d`(日)；
 *     token 之间的字符（`-` `/` `年月日` `.` 空格等）原样保留。
 *   - 偏移（可选，前面要有空格）：`[+-]N[dwmy]?`，单位 d=天(默认)/w=周/m=月/y=年。
 *   - 例：`${yyyy-mm-dd}`=今天，`${yyyy-mm-dd -1}`=昨天，`${yyyy/mm/dd +7}`=七天后，
 *     `${yyyy年mm月dd日}`，`${yyyy-mm -1m}`=上个月。
 *
 * 安全：只有**包含年 token（yyyy/yy）**的 `${...}` 才当日期占位符解析，其余 `${...}`
 * 原样保留 —— 避免把任意 `${FOO}`（恰好含 m/d 字母）误改。解析失败也原样保留，绝不破坏输入。
 */

const DATE_TOKEN = /yyyy|yy|mm|dd|m|d/g; // 注意顺序：长 token 在前，正则交替左优先

function formatDate(fmt: string, d: Date): string {
  const Y = d.getFullYear();
  const M = d.getMonth() + 1;
  const D = d.getDate();
  return fmt.replace(DATE_TOKEN, (t) => {
    switch (t) {
      case 'yyyy':
        return String(Y);
      case 'yy':
        return String(Y).slice(-2);
      case 'mm':
        return String(M).padStart(2, '0');
      case 'm':
        return String(M);
      case 'dd':
        return String(D).padStart(2, '0');
      case 'd':
        return String(D);
      default:
        return t;
    }
  });
}

function applyOffset(base: Date, off: string): Date {
  const m = /^([+-]\d+)([dwmy]?)$/.exec(off);
  if (!m) return base;
  const n = parseInt(m[1], 10);
  const unit = m[2] || 'd';
  const d = new Date(base.getTime());
  if (unit === 'd') d.setDate(d.getDate() + n);
  else if (unit === 'w') d.setDate(d.getDate() + n * 7);
  else if (unit === 'm') d.setMonth(d.getMonth() + n);
  else if (unit === 'y') d.setFullYear(d.getFullYear() + n);
  return d;
}

/** 把 text 里的日期占位符按 base 解析；非日期 / 解析失败的 `${...}` 原样保留。 */
export function resolveDatePlaceholders(text: string, base: Date): string {
  return text.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    const trimmed = inner.trim();
    // 尾部可选偏移（前面必须有空格，以免和格式里的内部 `-` 混淆）
    const offMatch = /\s([+-]\d+[dwmy]?)\s*$/.exec(trimmed);
    const fmt = offMatch ? trimmed.slice(0, offMatch.index).trim() : trimmed;
    // 只有含年 token 才当日期占位符，避免误伤任意 ${...}
    if (!/(yyyy|yy)/.test(fmt)) return whole;
    const d = offMatch ? applyOffset(base, offMatch[1]) : base;
    return formatDate(fmt, d);
  });
}

/** 输入是否含日期占位符（UI 据此决定要不要显示实时预览）。 */
export function hasDatePlaceholder(text: string): boolean {
  return /\$\{[^}]*(?:yyyy|yy)[^}]*\}/.test(text);
}
