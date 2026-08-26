import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

/**
 * pith 内部的 LLM 传输接口。
 *
 * 故意与 OpenAI SDK 的 `chat.completions.create` **同形**（而不是另设一套领域模型），
 * 换来三件事：
 *   1. 现成的 `OpenAI` 实例天然满足这个接口，零适配；
 *   2. 安全过滤层（`src/security/wrap.ts`）的请求/响应处理逻辑一行不用改——它本来就
 *      按这个形状读写 `messages` / `content` / `tool_calls[].arguments`；
 *   3. Agent / HydrationService / ToolContext 只改类型标注，不动调用点。
 *
 * 于是「换传输层」变成「换一个实现了 ChatClient 的对象」：
 *   - `openai`（默认）：OpenAI SDK 直连 OpenAI 兼容端点
 *   - `pi-ai`：经 @earendil-works/pi-ai 走它的 provider 生态（见 piAiTransport.ts）
 *
 * 代价（明说）：pi-ai 侧的能力如果不能表达成这个形状（如原生流式增量、跨 provider
 * 交接、compaction），在 B 阶段就拿不到——那些属于路线 A（换掉 agent loop 本身）。
 */
export interface ChatClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion>;
    };
  };
}

/** 传输实现的选择键。config.transport / PITH_WIKI_TRANSPORT。 */
export type TransportKind = 'openai' | 'pi-ai';

/**
 * 传输层用途。决定「能不能用 pi-ai」：
 *   - chat      ：REPL / 桌面对话，可走 pi-ai
 *   - hydration ：水合 / digest / 队列，**必须** JSON 模式（`response_format:
 *                 json_object`），而 pi-ai 没有对等能力 → 永远走 openai SDK
 * 见 docs/research-pi-harness-migration.md §3 L7。
 */
export type TransportPurpose = 'chat' | 'hydration';
