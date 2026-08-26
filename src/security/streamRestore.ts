import type { Sanitizer } from './sanitizer.js';

/**
 * 流式占位符还原器（迁移路线 A 的前置件，见 docs/research-pi-harness-migration.md §3 L1'）。
 *
 * 问题：现在 pith 全程 `stream: false`，响应是完整 JSON，`Sanitizer.restore()` 一次替换就行。
 * 一旦换成流式（pi-agent-core 是流式优先），`[PHONE_1]` 这种占位符会被切在两个 delta 之间：
 *
 *     delta1 = "号码是 [PHO"      delta2 = "NE_1]，记好了"
 *
 * 逐 chunk 直接 restore 两边都匹配不到，占位符原样漏进 UI —— 用户看到的是 `[PHONE_1]`
 * 而不是真号码，而这层的全部意义就是「敏感数据不出机器、本地看到的仍是原文」。
 *
 * 做法：**保留可能是半个占位符的尾巴**（hold-back）。
 *   - 缓冲区里能完整匹配的占位符立刻还原并吐出；
 *   - 尾部若存在一个未闭合的 `[`，且从它到末尾仍可能长成合法占位符（全大写/数字/下划线，
 *     长度未超上限），就把这段扣住不吐，等下一个 chunk 拼上再判；
 *   - `flush()` 在流结束时把扣住的尾巴原样吐出（那确实不是占位符）。
 *
 * 不变量：`push()` 拼接 + `flush()` 的输出，等于把整段文本一次性 restore 的结果
 * （单测用随机切片位置对拍这一点）。
 */

/** 占位符体的合法字符：大写字母 / 数字 / 下划线。`[` 之后只允许这些，否则不可能是占位符。 */
const BODY_CHAR = /[A-Z0-9_]/;

/**
 * 扣留尾巴的最大长度。占位符形如 `[LABEL_123]`；真实 label 由规则名/preset 名生成，
 * 不会很长。给一个宽松上限，避免遇到一段全大写正文（如 `[TODO` 之类）时无限扣留。
 */
const MAX_HOLD = 64;

export interface StreamRestorer {
  /** 喂入一个 delta，返回**可以安全交给下游**的已还原文本（可能是空串）。 */
  push(chunk: string): string;
  /** 流结束：吐出仍被扣住的尾巴（原样，不还原——它不是完整占位符）。 */
  flush(): string;
  /** 累计遇到的、映射表里查不到的占位符个数（与 restore 的 leftover 语义一致）。 */
  readonly leftover: number;
}

/**
 * 从 buf 尾部找出「必须扣留」的起点。找不到 → 返回 buf.length（全部可吐）。
 *
 * 判定：从后往前找最后一个 `[`。若它之后全是占位符体字符（没有 `]`、没有空格等），
 * 说明它有可能在下个 chunk 里闭合 → 从这里开始扣留。超过 MAX_HOLD 就放弃扣留
 * （不可能是占位符，别把正文卡在缓冲区里）。
 */
function holdFrom(buf: string): number {
  const idx = buf.lastIndexOf('[');
  if (idx === -1) return buf.length;
  const tail = buf.slice(idx + 1);
  if (tail.length > MAX_HOLD) return buf.length;
  for (const ch of tail) {
    if (!BODY_CHAR.test(ch)) return buf.length; // 尾巴里已出现不可能的字符
  }
  return idx;
}

/**
 * 造一个流式还原器。`jsonEscape` 与 `Sanitizer.restore` 同义（JSON 承载的文本用转义形式）。
 *
 * 注意：JSON 模式下按 chunk 还原本身是有风险的（还原后的值可能带引号/换行，破坏
 * 下游正在增量解析的 JSON），调用方要么整段解析完再还原，要么明确接受 jsonEscape 语义。
 * 这里提供参数是为了让 tool_calls 的参数流也能走同一条路。
 */
export function createStreamRestorer(
  sanitizer: Sanitizer,
  opts: { jsonEscape?: boolean } = {},
): StreamRestorer {
  let buf = '';
  let leftover = 0;

  const restoreReady = (text: string): string => {
    if (!text) return '';
    const r = sanitizer.restore(text, opts);
    leftover += r.leftover;
    return r.text;
  };

  return {
    push(chunk: string): string {
      if (!chunk) return '';
      buf += chunk;
      const cut = holdFrom(buf);
      const ready = buf.slice(0, cut);
      buf = buf.slice(cut);
      return restoreReady(ready);
    },
    flush(): string {
      const rest = buf;
      buf = '';
      // 扣住的尾巴不可能是完整占位符（否则早就吐了），但仍走一遍 restore 保持语义统一。
      return restoreReady(rest);
    },
    get leftover(): number {
      return leftover;
    },
  };
}
