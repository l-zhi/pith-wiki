import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AssistantMessage,
  type Context as PiContext,
  type Message as PiMessage,
  type Model as PiModel,
  type Models,
  type TSchema,
  type Tool as PiTool,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Config } from '../config.js';
import type { ChatClient } from './transport.js';

/**
 * pi-ai 传输实现 —— 把 pith 的 `chat.completions.create` 调用翻译到
 * `@earendil-works/pi-ai` 的 `Models.completeSimple()`，再把结果翻回 OpenAI 形状。
 *
 * 为什么值得做（见 docs/research-pi-harness-migration.md §5）：一次换来 pi-ai 的
 * provider 生态（Anthropic / Google / Mistral / Bedrock 原生 API、OAuth 订阅、模型目录、
 * 成本核算、统一 thinking 等级），而 pith 自己的 agent loop / 工具 / 沙箱 / 安全过滤
 * **一行不改**。
 *
 * 两种 provider 装配：
 *   1. `piProvider` 未设 → 用 config.baseURL/apiKey/model 现造一个 openai-completions
 *      自定义 provider（DeepSeek / GLM / Qwen / 本地 vLLM 都走这条，行为等价于现状）。
 *      API 实现走 `.lazy` 入口：只有真的发请求时才 import，避免把 openai SDK 提前拉进
 *      启动路径。
 *   2. `piProvider` 设了（如 'anthropic' / 'google'）→ 动态 import pi-ai 的内建 provider
 *      全集，按 `getModel(piProvider, model)` 取模型，鉴权走 pi-ai 的解析链（env var /
 *      credential store）。**动态** import 是刻意的：内建全集会牵进 Anthropic/Google/
 *      Mistral/Bedrock 四个 SDK，不用就不该付这个启动与体积成本。
 *
 * 已知取舍（v1）：
 *   - **无 JSON 模式**：pi-ai 没有 `response_format: json_object` 的对等物。带这个字段的
 *     请求（= 水合链路）直接抛错，由 createClient 保证水合永远走 openai SDK。
 *   - **thinking 签名不保真**：pith 的历史是 OpenAI 形状，thinking 只有文本没有 provider
 *     签名（Anthropic 的 thinkingSignature 在这一层无处存放）。回放时按纯文本 thinking 块
 *     还原——对 DeepSeek/GLM 这类 `reasoning_content` 语义无损；要用 Anthropic 原生
 *     extended thinking 请走委托型 provider（PRD-pi-integration.md）或等路线 A。
 *   - **非流式**：pith 的 agent loop 目前是 `stream: false`，这里用 completeSimple 对齐。
 *     流式是路线 A 的收益，不在 B 的范围内。
 */

/** pith 用不到 pi-ai 的成本目录，给自定义 provider 一份零成本占位。 */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export interface PiAiClientOptions {
  /** 覆盖模型解析（测试注入 faux provider 用）。 */
  models?: Models;
  /** 覆盖模型查找（测试注入 faux model 用）。 */
  model?: PiModel<never> | PiModel<'openai-completions'>;
}

/** 从 pith config 造一个 openai-completions 自定义 provider（把 baseURL/apiKey 折进去）。 */
function customProviderModels(config: Config): {
  models: Models;
  model: PiModel<'openai-completions'>;
} {
  const providerId = 'pith-endpoint';
  const model: PiModel<'openai-completions'> = {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: config.baseURL,
    // reasoning=true 只是允许上层传 thinking 等级；non-thinking 模型忽略即可。
    reasoning: true,
    input: ['text'],
    cost: ZERO_COST,
    // pith 不做 context window 管理（agent loop 自己有 maxSteps + 预算告警），给宽松值。
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const provider = createProvider<'openai-completions'>({
    id: providerId,
    name: 'pith endpoint',
    baseUrl: config.baseURL,
    // key 每次请求由 options.apiKey 显式传入（pith 的真源是 config），env 兜底保留。
    auth: { apiKey: envApiKeyAuth('pith endpoint API key', ['PITH_WIKI_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

/** 用 pi-ai 内建 provider 全集解析 `piProvider/model`。动态 import：不用就不付体积成本。 */
async function builtinProviderModels(
  config: Config,
): Promise<{ models: Models; model: PiModel<never> }> {
  const providerId = config.piProvider;
  if (!providerId) throw new Error('piProvider is required for the builtin provider path');
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  const models = builtinModels();
  const model = models.getModel(providerId, config.model);
  if (!model) {
    throw new Error(
      `pi-ai: model "${config.model}" not found in provider "${providerId}". ` +
        `Check the model id, or unset piProvider to use the OpenAI-compatible endpoint path.`,
    );
  }
  return { models, model: model as PiModel<never> };
}

/** OpenAI 的 tool 声明（JSON Schema）→ pi-ai Tool。C 阶段已实测 TypeBox 接受普通 JSON Schema。 */
function toPiTools(tools: ChatCompletionTool[] | undefined): PiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as unknown as TSchema,
  }));
}

function textOf(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  // pith 只产纯文本 content；数组形态兜底拼接 text 片段。
  return content
    .map((part) => (typeof part === 'string' ? part : 'text' in part ? (part.text ?? '') : ''))
    .join('');
}

/**
 * OpenAI 形状的历史 → pi-ai Context。
 *
 * 细节：
 *   - 所有 system 消息拼成 `systemPrompt`（pith 只有一条，位置固定在头部）
 *   - assistant 的 `reasoning_content` / `thinking` 还原成 thinking 块（无签名，见类注释）
 *   - assistant 的 `tool_calls` → toolCall 块（arguments 从 JSON 字符串 parse 回对象）
 *   - tool 消息 → toolResult；`toolName` 由前面 assistant 的 tool_calls 按 id 反查
 *     （pi-ai 的 ToolResultMessage 要求 toolName，OpenAI 形状里没有这个字段）
 */
export function toPiContext(body: ChatCompletionCreateParamsNonStreaming): PiContext {
  const systemParts: string[] = [];
  const messages: PiMessage[] = [];
  const toolNameById = new Map<string, string>();
  const ts = 0; // 确定性时间戳：pith 不用它做排序，固定值让请求可比对（测试友好）

  for (const raw of body.messages) {
    const m = raw as ChatCompletionMessageParam & {
      reasoning_content?: unknown;
      thinking?: unknown;
      tool_calls?: ChatCompletionMessageToolCall[];
      tool_call_id?: string;
    };
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'user') {
      messages.push({ role: 'user', content: textOf(m.content), timestamp: ts });
      continue;
    }
    if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      const thinking =
        typeof m.reasoning_content === 'string'
          ? m.reasoning_content
          : typeof m.thinking === 'string'
            ? m.thinking
            : '';
      if (thinking.trim()) content.push({ type: 'thinking', thinking });
      const text = textOf(m.content);
      if (text.trim()) content.push({ type: 'text', text });
      for (const call of m.tool_calls ?? []) {
        toolNameById.set(call.id, call.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          // 参数不是合法 JSON（模型抽风）：原样塞进一个字段，别让整轮请求崩掉
          args = { _raw: call.function.arguments };
        }
        content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
      }
      messages.push({
        role: 'assistant',
        content,
        // 下面这些字段是 pi-ai 的响应元数据；回放历史时不参与请求构造，给最小合法值。
        api: 'openai-completions',
        provider: 'pith-endpoint',
        model: body.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: ts,
      });
      continue;
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      messages.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: toolNameById.get(id) ?? 'tool',
        content: [{ type: 'text', text: textOf(m.content) }],
        isError: false,
        timestamp: ts,
      });
      continue;
    }
  }

  const tools = toPiTools(body.tools as ChatCompletionTool[] | undefined);
  return {
    ...(systemParts.length ? { systemPrompt: systemParts.join('\n\n') } : {}),
    messages,
    ...(tools ? { tools } : {}),
  };
}

/** pi-ai 的 stopReason → OpenAI 的 finish_reason。 */
function toFinishReason(
  stop: AssistantMessage['stopReason'],
): ChatCompletion.Choice['finish_reason'] {
  switch (stop) {
    case 'toolUse':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'stop';
  }
}

/**
 * pi-ai AssistantMessage → OpenAI ChatCompletion 形状。
 * thinking 走 `reasoning_content`（pith 的 Agent 正好优先读这个字段发 onThinking 事件）。
 */
export function toChatCompletion(msg: AssistantMessage, model: string): ChatCompletion {
  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'thinking') thinkings.push(block.thinking);
    else if (block.type === 'toolCall') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      });
    }
  }
  const message = {
    role: 'assistant' as const,
    content: texts.join('\n'),
    refusal: null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(thinkings.length ? { reasoning_content: thinkings.join('\n\n') } : {}),
  };
  return {
    id: msg.responseId ?? 'pi-ai',
    object: 'chat.completion',
    created: Math.floor((msg.timestamp || 0) / 1000),
    model: msg.responseModel ?? msg.model ?? model,
    choices: [
      {
        index: 0,
        message: message as unknown as ChatCompletion.Choice['message'],
        finish_reason: toFinishReason(msg.stopReason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: msg.usage?.input ?? 0,
      completion_tokens: msg.usage?.output ?? 0,
      total_tokens: msg.usage?.totalTokens ?? 0,
    },
  };
}

/** pi-ai 用「stopReason=error 的消息」表达失败；pith 的 Agent 期望抛错，这里转换。 */
class PiAiRequestError extends Error {
  constructor(
    message: string,
    /** 让 Agent 的 classifyError 能把鉴权/限流分类出来（best-effort，从文案里嗅探）。 */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PiAiRequestError';
  }
}

/** 从 pi-ai 的错误文案里嗅出 HTTP 状态码，喂给 Agent 的 classifyError。 */
function sniffStatus(message: string): number | undefined {
  const m = /\b(4\d{2}|5\d{2})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * 造一个走 pi-ai 的 ChatClient。
 *
 * 惰性装配：provider/model 在**首次请求**时解析（内建 provider 路径要 await 动态 import），
 * 之后缓存。这样 createClient 保持同步签名，且不用的时候零成本。
 */
export function createPiAiChatClient(config: Config, opts: PiAiClientOptions = {}): ChatClient {
  let resolved: Promise<{ models: Models; model: PiModel<never> }> | null = null;
  const resolve = (): Promise<{ models: Models; model: PiModel<never> }> => {
    if (opts.models && opts.model) {
      return Promise.resolve({ models: opts.models, model: opts.model as PiModel<never> });
    }
    if (!resolved) {
      resolved = config.piProvider
        ? builtinProviderModels(config)
        : Promise.resolve(
            customProviderModels(config) as unknown as { models: Models; model: PiModel<never> },
          );
    }
    return resolved;
  };

  return {
    chat: {
      completions: {
        async create(body, options) {
          if (body.response_format) {
            // 水合链路专用（json_object）。pi-ai 没有对等能力 —— 显式报错胜过静默降级。
            throw new PiAiRequestError(
              'pi-ai transport does not support response_format (JSON mode). ' +
                'Hydration must use the openai transport; see docs/research-pi-harness-migration.md §3 L7.',
            );
          }
          const { models, model } = await resolve();
          const context = toPiContext(body);
          const msg = await models.completeSimple(model, context, {
            signal: options?.signal,
            timeoutMs: config.requestTimeoutMs,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          });
          if (msg.stopReason === 'aborted') {
            // 与 OpenAI SDK 的 abort 行为对齐：Agent 靠 err.name === 'AbortError' 透传中断。
            const err = new Error(msg.errorMessage ?? 'request aborted');
            err.name = 'AbortError';
            throw err;
          }
          if (msg.stopReason === 'error') {
            const text = msg.errorMessage ?? 'pi-ai request failed';
            throw new PiAiRequestError(text, sniffStatus(text));
          }
          return toChatCompletion(msg, config.model);
        },
      },
    },
  };
}
