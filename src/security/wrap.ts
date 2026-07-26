import { SecurityBlockError, type Sanitizer } from './sanitizer.js';
import type { ChatClient } from '../llm/transport.js';
import type { BlockHit } from './types.js';

/**
 * client 层统一拦截：monkey-patch `chat.completions.create`，对所有 LLM 出站
 * 请求做 块断/脱敏，对响应做占位符还原。Agent / Hydration / queue worker 共用
 * 这一个收口点，没有第二条出站路径。
 *
 * 拦截的是 `ChatClient`（见 src/llm/transport.ts）而不是具体的 OpenAI 实例 ——
 * 所以 openai SDK 与 pi-ai 两种传输都被同一层覆盖，逻辑零分叉。
 *
 * 出站（请求前）：
 *   - 逐条扫描 messages 的 content / tool_calls.arguments / reasoning 字段
 *   - block 命中 → 抛 SecurityBlockError，请求不发出
 *   - mask 命中 → 替换占位符；本请求发生过替换时，给 system 消息追加一段
 *     "占位符必须原样保留"的指令（集中在这里注入，agent/hydration 的 prompt
 *     都不用各自改）
 *
 * 入站（响应后，原地改写 completion）：
 *   - message.content：还原。请求带 response_format=json_object 时用 JSON
 *     转义形式替换（原文含引号/换行不破坏 JSON 结构）
 *   - tool_calls[].function.arguments：恒为 JSON，按 jsonEscape 还原 ——
 *     模型在工具参数里引用 [PHONE_1] 时，工具拿到的是真实值
 *   - reasoning_content / thinking：还原（纯文本）
 *
 * 还原后的真实值会经 agent 的历史回到下一轮请求，再被本层确定性 re-mask
 * （Sanitizer 映射表跨请求稳定），所以"还原入历史"不构成泄露路径。
 */

const MASK_NOTE =
  'Privacy note: some values in this conversation have been replaced with placeholders ' +
  'like [PHONE_1] or [KEYWORD_2]. Treat them as opaque literal values: copy them verbatim ' +
  'wherever the underlying value is needed, never alter/translate/expand them, and never ' +
  'use them inside slug ids or tags.';

/**
 * 通知分级：UI 按级别决定是否打扰用户。
 *   - masked:  常规脱敏计数。设计上对用户透明（对话里看到的始终是原文），
 *              REPL 默认不显示，verbose 模式才出现；CLI 仍打 stderr 留痕。
 *   - warning: 需要注意的异常（占位符还原失败残留、流式跳过还原）。
 *   - info:    一次性信息（如首次生成规则文件）。
 */
export type SecurityNoticeKind = 'masked' | 'warning' | 'info';

export interface WrapOptions {
  /** 脱敏/异常的人类可读提示。REPL 接到 UI，CLI 缺省打 stderr。 */
  onNotice?: (message: string, kind: SecurityNoticeKind) => void;
}

type AnyRecord = Record<string, unknown>;

export function wrapClientWithSecurity(
  client: ChatClient,
  sanitizer: Sanitizer,
  opts: WrapOptions = {},
): ChatClient {
  if (!sanitizer.hasRules) return client;
  const onNotice = opts.onNotice ?? ((msg) => process.stderr.write(`[security] ${msg}\n`));
  const original = client.chat.completions.create.bind(client.chat.completions);

  const wrapped = async (params: AnyRecord, requestOpts?: unknown) => {
    const { clean, blocked, newLabels } = sanitizeParams(params, sanitizer);
    if (blocked.length > 0) throw new SecurityBlockError(blocked);
    if (newLabels.length > 0) onNotice(formatMaskNotice(newLabels), 'masked');

    // eslint 风格的窄化没必要：SDK 的 create 是重载签名，这里按运行时实际用法直传
    const completion = (await original(
      clean as never,
      requestOpts as never,
    )) as unknown as AnyRecord;

    if (params.stream) {
      // 现有调用全部 stream:false。真出现流式调用时只保证出站安全，不做增量还原。
      onNotice('security: streaming response — placeholder restore skipped', 'warning');
      return completion;
    }

    const jsonMode = (params.response_format as AnyRecord | undefined)?.type === 'json_object';
    const leftover = restoreCompletion(completion, sanitizer, jsonMode);
    if (leftover > 0) {
      onNotice(
        `security: ${leftover} placeholder(s) in the response had no mapping — ` +
          'the model may have altered them; left as-is',
        'warning',
      );
    }
    return completion;
  };

  client.chat.completions.create = wrapped as unknown as typeof client.chat.completions.create;
  return client;
}

interface SanitizedParams {
  clean: AnyRecord;
  blocked: BlockHit[];
  /** 本请求新分配的占位符 label（首次见到的敏感值），供 UI 提示去噪。 */
  newLabels: string[];
}

function sanitizeParams(params: AnyRecord, sanitizer: Sanitizer): SanitizedParams {
  const blocked: BlockHit[] = [];
  const newLabels: string[] = [];
  let anyMasked = false;

  const scrub = (text: string): string => {
    const r = sanitizer.sanitize(text);
    blocked.push(...r.blocked);
    newLabels.push(...r.newLabels);
    if (r.maskedLabels.length > 0) anyMasked = true;
    return r.text;
  };

  const messages = Array.isArray(params.messages) ? (params.messages as AnyRecord[]) : [];
  const cleanMessages = messages.map((msg) => {
    const copy: AnyRecord = { ...msg };
    if (typeof copy.content === 'string') {
      copy.content = scrub(copy.content);
    } else if (Array.isArray(copy.content)) {
      // multimodal parts（当前代码库未用到，防御性覆盖）
      copy.content = copy.content.map((part) =>
        part && typeof (part as AnyRecord).text === 'string'
          ? { ...(part as AnyRecord), text: scrub((part as AnyRecord).text as string) }
          : part,
      );
    }
    for (const key of ['reasoning_content', 'thinking'] as const) {
      if (typeof copy[key] === 'string') copy[key] = scrub(copy[key] as string);
    }
    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = (copy.tool_calls as AnyRecord[]).map((tc) => {
        const fn = tc.function as AnyRecord | undefined;
        if (!fn || typeof fn.arguments !== 'string') return tc;
        return { ...tc, function: { ...fn, arguments: scrub(fn.arguments) } };
      });
    }
    return copy;
  });

  // 本请求里出现过占位符（新换的或历史 re-mask 的）→ 注入"原样保留"指令。
  // 追加到第一条 system 消息末尾；没有 system 消息时补一条在最前。
  if (anyMasked) {
    const sysIdx = cleanMessages.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0 && typeof cleanMessages[sysIdx].content === 'string') {
      cleanMessages[sysIdx] = {
        ...cleanMessages[sysIdx],
        content: `${cleanMessages[sysIdx].content}\n\n${MASK_NOTE}`,
      };
    } else {
      cleanMessages.unshift({ role: 'system', content: MASK_NOTE });
    }
  }

  return { clean: { ...params, messages: cleanMessages }, blocked, newLabels };
}

/** 原地还原 completion 的所有文本承载字段，返回残留占位符总数。 */
function restoreCompletion(completion: AnyRecord, sanitizer: Sanitizer, jsonMode: boolean): number {
  let leftover = 0;
  const choices = Array.isArray(completion.choices) ? (completion.choices as AnyRecord[]) : [];
  for (const choice of choices) {
    const msg = choice?.message as AnyRecord | undefined;
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      const r = sanitizer.restore(msg.content, { jsonEscape: jsonMode });
      msg.content = r.text;
      leftover += r.leftover;
    }
    for (const key of ['reasoning_content', 'thinking'] as const) {
      if (typeof msg[key] === 'string') {
        const r = sanitizer.restore(msg[key] as string);
        msg[key] = r.text;
        leftover += r.leftover;
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as AnyRecord[]) {
        const fn = tc.function as AnyRecord | undefined;
        if (!fn || typeof fn.arguments !== 'string') continue;
        const r = sanitizer.restore(fn.arguments, { jsonEscape: true });
        fn.arguments = r.text;
        leftover += r.leftover;
      }
    }
  }
  return leftover;
}

function formatMaskNotice(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const parts = [...counts.entries()].map(([label, n]) => `${label}×${n}`);
  return `已脱敏 ${labels.length} 处: ${parts.join(', ')}`;
}
