import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AssistantMessage,
  type Model as PiModel,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type {
  ChatCompletion,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { Config } from '../config.js';
import { toPiContext } from './piMessageMap.js';
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
    // 保守兼容：pi-ai 会按 baseUrl 猜端点能力，猜错就会往 body 里多塞字段（实测见到过
    // `store` / `prompt_cache_key` / `prompt_cache_retention`）。pith 的用户端点五花八门
    // （火山 Ark、自建 vLLM、各家兼容层），有的对未知字段直接 400。`store` pith 从不需要，
    // 显式关掉；若日后遇到别的字段被拒，OpenAICompletionsCompat 还有一组同类开关可加。
    compat: { supportsStore: false },
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


/**
 * pi-ai 会往 openai-completions 的 body 里塞一些 OpenAI 专有字段（实测：`store`、
 * `prompt_cache_key`、`prompt_cache_retention`；后两个对非 api.openai.com 也无条件下发，
 * `compat` 与 `cacheRetention:'none'` 都关不掉）。pith 的用户端点五花八门（火山 Ark、
 * 自建 vLLM、各家兼容层），有的对未知字段直接 400 —— 而 pith 现有实现只发最小必要字段，
 * 换传输不该引入这种回归。
 *
 * 所以自定义端点路径上用 `onPayload` 把这些字段剥掉（pi-ai 的官方扩展点，返回新 payload
 * 即生效）。内建 provider 路径不动：那里 pi-ai 知道端点支持什么。
 */
const NON_STANDARD_FIELDS = ['store', 'prompt_cache_key', 'prompt_cache_retention'] as const;

export function stripNonStandardFields(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  const hit = NON_STANDARD_FIELDS.some((f) => f in body);
  if (!hit) return undefined; // 无需改写：按 pi-ai 约定返回 undefined
  const clean = { ...body };
  for (const f of NON_STANDARD_FIELDS) delete clean[f];
  return clean;
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
  type Resolved = { models: Models; model: PiModel<never>; custom: boolean };
  let resolved: Promise<Resolved> | null = null;
  const resolve = (): Promise<Resolved> => {
    if (opts.models && opts.model) {
      // 注入路径（测试）：按自定义端点处理，保持与生产同一条 payload 清理逻辑。
      return Promise.resolve({
        models: opts.models,
        model: opts.model as PiModel<never>,
        custom: true,
      });
    }
    if (!resolved) {
      resolved = config.piProvider
        ? builtinProviderModels(config).then((r) => ({ ...r, custom: false }))
        : Promise.resolve({
            ...(customProviderModels(config) as unknown as {
              models: Models;
              model: PiModel<never>;
            }),
            custom: true,
          });
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
          const { models, model, custom } = await resolve();
          const context = toPiContext(body);
          const msg = await models.completeSimple(model, context, {
            signal: options?.signal,
            timeoutMs: config.requestTimeoutMs,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            // 自定义端点路径才清理 payload：pi-ai 对内建 provider 知道该发什么，别乱动。
            ...(custom ? { onPayload: stripNonStandardFields } : {}),
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
