/**
 * cron 的「结构化 ↔ 表达式」互转 + 人话描述。
 *
 * 给 Schedule 表单的友好编辑器用：普通用户在 每天/每周/每月 之间选，配个时间/星期/
 * 日期，这里生成底层 cron；反过来编辑已有任务时把 cron 解析回结构化档位（解析不出
 * 常见形态就让 UI 回落到「自定义」手写）。底层只存 cron 字符串，与 core 模型一致。
 *
 * 纯函数、无 React，便于单测（desktop/tests/cronText.test.ts）。
 */

export type CronParts =
  | { freq: 'daily'; hour: number; minute: number }
  | { freq: 'weekly'; hour: number; minute: number; days: number[] } // days: 0=周日..6=周六
  | { freq: 'monthly'; hour: number; minute: number; dom: number }; // dom: 1..31

const pad = (n: number) => String(n).padStart(2, '0');

/** 结构化档位 → 5 字段 cron。 */
export function buildCron(p: CronParts): string {
  const m = p.minute;
  const h = p.hour;
  if (p.freq === 'daily') return `${m} ${h} * * *`;
  if (p.freq === 'weekly') {
    const days = [...new Set(p.days)].sort((a, b) => a - b);
    return `${m} ${h} * * ${days.length ? days.join(',') : '*'}`;
  }
  return `${m} ${h} ${p.dom} * *`;
}

function intOrNull(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * 把常见 cron 反解析成结构化档位；解析不出（含列表/范围/步长等高级写法）→ null，
 * UI 据此回落到「自定义」。仅认 分/时 为单一整数的简单日程。
 */
export function parseCron(expr: string): CronParts | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, ho, dm, mo, dw] = parts;
  const minute = intOrNull(mi);
  const hour = intOrNull(ho);
  if (minute === null || hour === null || minute > 59 || hour > 23) return null;
  if (mo !== '*') return null; // 跨月份的高级写法交给自定义

  // daily：日/月/周全 *
  if (dm === '*' && dw === '*') return { freq: 'daily', hour, minute };

  // weekly：日 *，周是单值或逗号列表（0-7，7→0）
  if (dm === '*' && dw !== '*') {
    const tokens = dw.split(',');
    const days: number[] = [];
    for (const tk of tokens) {
      const n = intOrNull(tk);
      if (n === null || n > 7) return null;
      days.push(n === 7 ? 0 : n);
    }
    return { freq: 'weekly', hour, minute, days: [...new Set(days)].sort((a, b) => a - b) };
  }

  // monthly：日为单值，周 *
  if (dw === '*') {
    const dom = intOrNull(dm);
    if (dom === null || dom < 1 || dom > 31) return null;
    return { freq: 'monthly', hour, minute, dom };
  }
  return null;
}

/** 某个 dow（0=周日）的本地化短名（用一个已知是周日的参考日 2024-06-02 起算）。 */
export function weekdayShort(dow: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2024, 5, 2 + dow));
}

/**
 * cron → 人话（列表摘要 + 表单预览共用）。解析不出常见形态就原样回显表达式。
 * 中英按 lang 前缀切换。
 */
export function describeCron(expr: string, lang: string): string {
  const p = parseCron(expr);
  if (!p) return expr;
  const zh = lang.startsWith('zh');
  const hm = `${pad(p.hour)}:${pad(p.minute)}`;
  if (p.freq === 'daily') return zh ? `每天 ${hm}` : `Daily at ${hm}`;
  if (p.freq === 'weekly') {
    const list = (p.days.length ? p.days : [0]).map((d) => weekdayShort(d, lang));
    const joined = zh ? list.join('、') : list.join(', ');
    return zh ? `每周 ${joined} ${hm}` : `Weekly on ${joined} at ${hm}`;
  }
  return zh ? `每月 ${p.dom} 号 ${hm}` : `Monthly on day ${p.dom} at ${hm}`;
}

/** "HH:mm" → {hour,minute}，非法回 09:00。 */
export function parseTime(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return { hour: 9, minute: 0 };
  const hour = Math.min(23, Number(m[1]));
  const minute = Math.min(59, Number(m[2]));
  return { hour, minute };
}

export const timeString = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
