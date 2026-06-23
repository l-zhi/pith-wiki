/**
 * 极简 5 字段 cron 求值器（分 时 日 月 周）。
 *
 * 为什么自己写：项目离线、依赖极简（连 zodToJsonSchema 都是手搓的），而定时
 * 任务只需要两件事——「校验表达式」和「给定时刻求下一次触发」。标准 5 字段
 * 语法（`*` / 列表 `,` / 范围 `-` / 步长 `*​/n`）足够覆盖个人知识库的周期需求，
 * 没必要为此拉一个 cron 库。
 *
 * 语义对齐 Vixie cron：
 *   - 字段范围：分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-6（0=周日，7 也接受为周日）
 *   - day-of-month 与 day-of-week 都被限制（非 `*`）时取 **并集**（OR），与 crontab 一致
 *   - 求值在**本机本地时区**进行（v1：tz 字段仅作元数据展示，不做跨时区换算——
 *     无依赖下做对 DST 太脆，留作后续）
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** day-of-month 字段是否为 `*`（决定 dom/dow 的 OR 语义）。 */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const SPECS: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', FieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

/** 把单个字段（可能含 `,` 列表）解析成允许值集合。`*` → 整个范围。 */
function parseField(raw: string, spec: FieldSpec, normalize?: (n: number) => number): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`empty cron field segment in "${raw}"`);
    // 步长 a/b 或 */b
    let stepStr: string | undefined;
    let rangeStr = token;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      rangeStr = token.slice(0, slash);
      stepStr = token.slice(slash + 1);
    }
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`invalid cron step "${stepStr}" in "${raw}"`);

    let lo: number;
    let hi: number;
    if (rangeStr === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      const dash = rangeStr.indexOf('-');
      if (dash === -1) {
        lo = hi = parseNum(rangeStr, raw);
      } else {
        lo = parseNum(rangeStr.slice(0, dash), raw);
        hi = parseNum(rangeStr.slice(dash + 1), raw);
      }
    }
    // dow 允许输入到 7（=周日），其余字段输入上限即 spec.max
    const inputMax = normalize ? 7 : spec.max;
    for (let n = lo; n <= hi; n += step) {
      if (n < spec.min || n > inputMax) {
        throw new Error(`cron value ${n} out of range [${spec.min},${inputMax}] in "${raw}"`);
      }
      out.add(normalize ? normalize(n) : n);
    }
  }
  return out;
}

function parseNum(s: string, ctx: string): number {
  const n = Number(s.trim());
  if (!Number.isInteger(n)) throw new Error(`invalid cron number "${s}" in "${ctx}"`);
  return n;
}

/** 解析 5 字段 cron 表达式；非法时抛 Error（供创建时校验）。 */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields, got ${parts.length}: "${expr}"`);
  }
  const [mi, ho, dm, mo, dw] = parts;
  return {
    minute: parseField(mi, SPECS.minute),
    hour: parseField(ho, SPECS.hour),
    dom: parseField(dm, SPECS.dom),
    month: parseField(mo, SPECS.month),
    // 周：7 归一成 0（周日）
    dow: parseField(dw, SPECS.dow, (n) => (n === 7 ? 0 : n)),
    domRestricted: dm.trim() !== '*',
    dowRestricted: dw.trim() !== '*',
  };
}

/** 表达式是否合法（不抛，给 UI/工具做软校验）。 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function matches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  // crontab 语义：两者都受限 → OR；只受限一个 → 用受限那个；都不限 → 都过
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/** 366 天上限：cron 几乎总在数天内触发，超过即视为「实际不会触发」返回 null。 */
const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60;

/**
 * 求严格晚于 `after` 的下一次触发时刻（按本地时区，秒/毫秒清零）。
 * 找不到（如不可能的 2-30）→ null。
 */
export function nextFireAfter(expr: string, after: Date): Date | null {
  const f = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 严格大于
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    if (matches(f, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** 枚举 `[after, until]` 窗口内的所有触发点（日历用，封顶 cap 条防失控）。 */
export function fireTimesBetween(expr: string, after: Date, until: Date, cap = 500): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < cap) {
    const next = nextFireAfter(expr, cursor);
    if (!next || next.getTime() > until.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
