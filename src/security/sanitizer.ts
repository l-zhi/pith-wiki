import { PLACEHOLDER_RE, type BlockHit, type CompiledRule } from './types.js';

/**
 * Sanitizer：可还原脱敏的核心状态机。
 *
 * 映射表（原文 ↔ 占位符）挂在实例上，生命周期 = client 生命周期：
 * 同一会话内同一个手机号永远映射到同一个 [PHONE_1]。Agent 每轮重发完整
 * messages 历史时 re-mask 结果因此是确定的；还原（restore）也始终查得到。
 *
 * 占位符格式 [LABEL_N]：纯 ASCII、JSON 字符串安全、LLM 保真度高。注意它含
 * 大写字母和下划线，天然违反 entry 的 ID_RE —— 即使模型违规把占位符塞进
 * id，EntrySchema 也会把它拦下来（hydration 现有失败路径）。
 */

const BLOCK_SAMPLE_MAX = 24;

export class SecurityBlockError extends Error {
  readonly hits: BlockHit[];

  constructor(hits: BlockHit[]) {
    const desc = hits
      .map((h) => `${h.label} (${h.source}): "${h.sample}"`)
      .join('; ');
    super(`Request blocked by security rule(s): ${desc}`);
    this.name = 'SecurityBlockError';
    this.hits = hits;
  }
}

export interface SanitizeResult {
  text: string;
  /** block 级命中（不为空时调用方应拒发整个请求）。 */
  blocked: BlockHit[];
  /** 每发生一次 mask 替换记一个 label（同一值复现也计数），供调用方聚合提示。 */
  maskedLabels: string[];
  /** 仅首次见到的敏感值（本次新分配占位符）。agent 历史 re-mask 不会出现在这里。 */
  newLabels: string[];
}

export interface RestoreResult {
  text: string;
  /** 映射表里查不到的占位符个数（模型篡改/编造时 > 0，调用方应告警）。 */
  leftover: number;
}

export class Sanitizer {
  private readonly byOriginal = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly rules: CompiledRule[]) {}

  get hasRules(): boolean {
    return this.rules.length > 0;
  }

  /**
   * 出站扫描。block 规则只检测不替换（命中即拒发，替换无意义）；
   * mask 规则按编译顺序逐个全局替换。占位符自身不会被后续规则二次命中
   * （PII 预设都要求长数字串/特定形态，[LABEL_N] 不满足）。
   */
  sanitize(text: string): SanitizeResult {
    const blocked: BlockHit[] = [];
    const maskedLabels: string[] = [];
    const newLabels: string[] = [];
    let result = text;

    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0;
      if (rule.action === 'block') {
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(text)) !== null) {
          if (rule.validate && !rule.validate(m[0])) continue;
          blocked.push({ label: rule.label, source: rule.source, sample: truncateSample(m[0]) });
          // 同一规则报一次就够了——报错是给人看的，不需要全量枚举
          break;
        }
      } else {
        result = result.replace(rule.pattern, (match) => {
          if (rule.validate && !rule.validate(match)) return match;
          maskedLabels.push(rule.label);
          const isNew = !this.byOriginal.has(match);
          if (isNew) newLabels.push(rule.label);
          return this.placeholderFor(rule.label, match);
        });
      }
    }

    return { text: result, blocked, maskedLabels, newLabels };
  }

  /**
   * 入站还原。jsonEscape=true 时（JSON mode 响应 / tool_calls.arguments）用
   * JSON 转义形式替换，原文含引号/换行也不会破坏外层 JSON 结构。
   */
  restore(text: string, opts: { jsonEscape?: boolean } = {}): RestoreResult {
    let leftover = 0;
    const restored = text.replace(PLACEHOLDER_RE, (placeholder) => {
      const original = this.byPlaceholder.get(placeholder);
      if (original === undefined) {
        leftover++;
        return placeholder;
      }
      return opts.jsonEscape ? JSON.stringify(original).slice(1, -1) : original;
    });
    return { text: restored, leftover };
  }

  private placeholderFor(label: string, original: string): string {
    const existing = this.byOriginal.get(original);
    if (existing) return existing;
    const n = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, n);
    const placeholder = `[${label}_${n}]`;
    this.byOriginal.set(original, placeholder);
    this.byPlaceholder.set(placeholder, original);
    return placeholder;
  }
}

function truncateSample(s: string): string {
  return s.length <= BLOCK_SAMPLE_MAX ? s : `${s.slice(0, BLOCK_SAMPLE_MAX)}…`;
}
