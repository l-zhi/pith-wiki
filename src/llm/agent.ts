import OpenAI from 'openai';
import PQueue from 'p-queue';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { ALL_TOOLS, ToolContext, toolsForOpenAI, type AnyToolDef } from '../tools/index.js';

/**
 * 中性默认 system prompt——同时适用于 CLI 和嵌入用例。
 *
 * CLI 在 App.tsx 里追加一段 "你正运行在终端里" 的小后缀；嵌入应用按需
 * 通过 `AgentOptions.systemPrompt` 完整替换。
 */
export const defaultSystemPrompt = `You are pith-wiki, an assistant that helps the user manage a Karpathy-style Markdown knowledge base.

Available tools:
  File (sandboxed): read_file, write_file, list_dir
  Wiki retrieval:   wiki_query, wiki_list, wiki_get, wiki_read_source
  Wiki write:       wiki_ingest, wiki_queue_add, wiki_queue_status

Workflow for knowledge questions (in order; stop as soon as you have enough):

1. wiki_query — keyword scoring over title/tags/summary/content + 1-hop forward
   links. NOT semantic search. For Chinese, the matcher uses bigrams (every two
   adjacent CJK chars), so a multi-character noun usually hits; broader queries
   (3-6 char fragments) often work better than full sentences. The returned
   "context" is a COMPRESSED digest (~30-50% of source) — good for orientation,
   may miss specifics. The returned "references" array gives each entry's source
   path, telling you whether an original file exists.

2. wiki_list — fallback when wiki_query returns nothing or feels too noisy.
   Browses the in-memory index by metadata (id/title/summary/tags/source) WITHOUT
   content. Use filters: collection, tags, contains. Pick candidate ids by
   reading summaries semantically.

3. wiki_get(id) — full hydrated entry (frontmatter + body) when you need the
   complete digest of one specific entry.

4. wiki_read_source(id) — reads the ORIGINAL raw file referenced by the entry's
   source.value (only when source.type === 'file'). Use when the hydrated digest
   is too compressed for the user's question.

Be concise; output Markdown. Cite which entries informed your answer when relevant.

When the user shares new material worth saving, suggest wiki_ingest (one-shot)
or wiki_queue_add (bulk / async).`;

export interface AgentOptions {
  /** 完整替换默认 system prompt。默认 `defaultSystemPrompt`。 */
  systemPrompt?: string;
  /** tool loop 最大轮数。默认 12。 */
  maxSteps?: number;
  /** 宿主追加的工具——会被并入内置 10 个工具一起喂给 OpenAI 和 dispatch 表。 */
  extraTools?: AnyToolDef[];
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentEvents {
  /**
   * 一轮产生的"思考过程"。统一两个来源：
   *   - source='field'：provider 的 reasoning_content / thinking 扩展字段
   *   - source='tag'  ：模型写在 content 里的 `<think>…</think>`
   * 没有思考内容的轮次不触发。
   */
  onThinking?: (e: { text: string; source: 'field' | 'tag' }) => void;
  /**
   * assistant 正文（已剥离 `<think>`）。
   *   - final=true ：最后一轮的正式答案
   *   - final=false：中间轮（带 tool_calls）的叙述，如"我去查一下…"
   * 空串不触发。
   */
  onAssistantText?: (e: { text: string; final: boolean }) => void;
  /** 一次 tool 调用 + 其结果，合并成一个事件。preview 是结果 JSON 的截断预览。 */
  onToolRound?: (e: { name: string; args: unknown; ok: boolean; preview: string }) => void;
  onUsage?: (delta: UsageDelta) => void;
}

/**
 * 把一条 assistant content 拆成 { body, thinking }。
 *
 * 规则（仅处理 `<think>` 标签来源；字段来源由调用方优先处理）：
 *   - 抽取所有成对的 `<think>…</think>`，拼接成 thinking，从正文移除。
 *   - 未闭合的 `<think>`（模型截断 / 仍在思考）：开标签之后全部算 thinking，
 *     之前的算正文。
 *   - 没有 think 标签：thinking=null，body=原文。
 * 大小写不敏感；body 末尾 trim。
 */
export function splitThinking(content: string): { body: string; thinking: string | null } {
  if (!/<think/i.test(content)) return { body: content.trim(), thinking: null };
  const thinks: string[] = [];
  // 成对标签
  let body = content.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    thinks.push(inner.trim());
    return '';
  });
  // 残留的未闭合开标签：之后全部归入 thinking
  const openIdx = body.search(/<think\b[^>]*>/i);
  if (openIdx !== -1) {
    const tail = body.slice(openIdx).replace(/<think\b[^>]*>/i, '');
    thinks.push(tail.trim());
    body = body.slice(0, openIdx);
  }
  const thinking = thinks.filter(Boolean).join('\n\n').trim();
  return { body: body.trim(), thinking: thinking.length ? thinking : null };
}

export interface RunOptions {
  signal?: AbortSignal;
  events?: AgentEvents;
}

export class Agent {
  private messages: ChatCompletionMessageParam[];
  private queue = new PQueue({ concurrency: 1 });
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly toolRegistry: Map<string, AnyToolDef>;
  private readonly toolsPayload: ReturnType<typeof toolsForOpenAI>;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly toolCtx: ToolContext,
    options: AgentOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.maxSteps = options.maxSteps ?? 12;
    this.messages = [{ role: 'system', content: this.systemPrompt }];

    const tools: AnyToolDef[] = [...ALL_TOOLS, ...(options.extraTools ?? [])];
    this.toolRegistry = new Map(tools.map((t) => [t.name, t]));
    this.toolsPayload = toolsForOpenAI(tools);
  }

  reset(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  /**
   * 当前是否有可摘要的对话内容。
   * 仅 system prompt（reset 后的初始状态）→ false；至少有一轮 user/assistant → true。
   */
  hasContent(): boolean {
    return this.messages.some((m) => m.role !== 'system');
  }

  /**
   * 把当前对话（自上次 reset 起）格式化成 markdown，供 `/digest` 喂给 hydrator。
   *
   * 包含：user 提问、assistant 回复、tool_calls 的名字 + 参数（让 digest 知道
   * LLM 查阅过哪些资料）。tool 角色的原始返回值 byte-blob 不带——通常太长、且
   * 关键结论已经在下一条 assistant 消息里被复述。
   */
  snapshot(): string {
    const lines: string[] = [];
    for (const m of this.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        lines.push('## User');
        lines.push('');
        lines.push(content.trim());
        lines.push('');
      } else if (m.role === 'assistant') {
        const content = typeof m.content === 'string' ? m.content : '';
        if (content.trim()) {
          lines.push('## Assistant');
          lines.push('');
          lines.push(content.trim());
          lines.push('');
        }
        const toolCalls = (m as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls;
        if (toolCalls && toolCalls.length) {
          for (const tc of toolCalls) {
            lines.push(`### Tool: ${tc.function.name}`);
            lines.push('```json');
            // arguments 已经是 JSON 字符串，不强行 re-parse 防止格式被破坏
            lines.push(tc.function.arguments);
            lines.push('```');
            lines.push('');
          }
        }
      }
      // tool 角色原始返回值不引入：assistant 后续消息通常已经总结过
    }
    return lines.join('\n').trim();
  }

  async send(userMessage: string, opts: RunOptions = {}): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });
    const events = opts.events ?? {};
    const tools = this.toolsPayload;

    let finalText = '';
    let safety = 0;
    while (safety++ < this.maxSteps) {
      let completion: ChatCompletion;
      try {
        completion = await this.client.chat.completions.create(
          {
            model: this.model,
            messages: this.messages,
            tools,
            tool_choice: 'auto',
            stream: false,
          },
          { signal: opts.signal },
        );
      } catch (err) {
        const e = err as { status?: number; message?: string; name?: string };
        if (e.name === 'AbortError') throw err;
        throw new AgentError(classifyError(e), e.message ?? 'LLM request failed');
      }

      const choice = completion.choices[0];
      if (!choice) throw new AgentError('model_error', 'No choice returned by model');

      if (completion.usage) {
        events.onUsage?.({
          inputTokens: completion.usage.prompt_tokens ?? 0,
          outputTokens: completion.usage.completion_tokens ?? 0,
        });
      }

      const msg = choice.message;
      const toolCalls = msg.tool_calls ?? [];

      // thinking-mode 模型的回传协议：上一轮如果产生了"思考过程"，下一轮请求里
      // 这条 assistant 消息必须把它原样带回，否则 provider 直接 400。
      //   - reasoning_content: DeepSeek（v4-pro / r1 系列）扩展字段
      //   - thinking: Anthropic Claude 4 extended thinking（OpenAI-compatible
      //     代理透传时也用这个名字；不同 proxy 实现可能略有差异，best-effort）
      // 这两个字段都不在 OpenAI SDK 的 ChatCompletionMessage 类型里——但 SDK
      // 用 JSON.stringify 直传 messages，多塞的字段会原样进 request body。
      // 对 non-thinking 模型（deepseek-chat / glm / qwen 等）字段就是 undefined，
      // 不会带出去，零副作用。
      const m = msg as unknown as Record<string, unknown>;
      const extras: Record<string, unknown> = {};
      if (typeof m.reasoning_content === 'string') extras.reasoning_content = m.reasoning_content;
      if (m.thinking !== undefined) extras.thinking = m.thinking;

      // API 历史保留原始 content（含 <think>，不动回合制语义）；UI/transcript 走拆分后的视图。
      const rawContent = msg.content ?? '';
      this.messages.push({
        role: 'assistant',
        content: rawContent,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...extras,
      } as ChatCompletionMessageParam);

      // thinking 来源优先级：结构化字段 > content 内的 <think> 标签。
      const fieldReasoning =
        typeof m.reasoning_content === 'string'
          ? m.reasoning_content
          : typeof m.thinking === 'string'
            ? m.thinking
            : null;
      const split = splitThinking(rawContent);
      // 字段来源时 content 通常不含 <think>，正文取原文；标签来源时取剥离后的 body。
      const body = fieldReasoning ? rawContent.trim() : split.body;
      const thinking = fieldReasoning ?? split.thinking;
      if (thinking) {
        events.onThinking?.({ text: thinking, source: fieldReasoning ? 'field' : 'tag' });
      }

      if (toolCalls.length === 0) {
        finalText = body;
        if (body) events.onAssistantText?.({ text: body, final: true });
        break;
      }

      // 中间轮叙述（"我去查…"）：终端默认不显，但事件仍发出，供 transcript 记录。
      if (body) events.onAssistantText?.({ text: body, final: false });

      for (const call of toolCalls) {
        await this.queue.add(() => this.runToolCall(call, events));
      }
    }

    return finalText;
  }

  private async runToolCall(
    call: ChatCompletionMessageToolCall,
    events: AgentEvents,
  ): Promise<void> {
    const tool = this.toolRegistry.get(call.function.name);
    if (!tool) {
      const err = { ok: false, error: `Unknown tool: ${call.function.name}` };
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(err),
      });
      events.onToolRound?.({
        name: call.function.name,
        args: undefined,
        ok: false,
        preview: err.error,
      });
      return;
    }

    let parsed: unknown;
    try {
      const raw = call.function.arguments || '{}';
      const argsObj = JSON.parse(raw);
      parsed = tool.parameters.parse(argsObj);
    } catch (err) {
      const message = (err as Error).message;
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: `Invalid arguments: ${message}` }),
      });
      events.onToolRound?.({
        name: tool.name,
        args: call.function.arguments,
        ok: false,
        preview: `Invalid arguments: ${message}`,
      });
      return;
    }

    let result: unknown;
    try {
      result = await tool.handler(parsed as never, this.toolCtx);
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    const json = JSON.stringify(result);
    const preview = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    const ok =
      typeof result === 'object' && result !== null && (result as { ok?: boolean }).ok !== false;
    events.onToolRound?.({ name: tool.name, args: parsed, ok, preview });

    this.messages.push({ role: 'tool', tool_call_id: call.id, content: json });
  }
}

export type AgentErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'model_error'
  | 'tool_error'
  | 'unknown';

export class AgentError extends Error {
  constructor(
    public readonly kind: AgentErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

function classifyError(err: { status?: number; name?: string; message?: string }): AgentErrorKind {
  if (err.status === 401 || err.status === 403) return 'auth';
  if (err.status === 429) return 'rate_limit';
  if (err.status && err.status >= 500) return 'network';
  if (err.name === 'AbortError') return 'network';
  if (err.message?.toLowerCase().includes('econn') || err.message?.toLowerCase().includes('fetch'))
    return 'network';
  return 'model_error';
}
