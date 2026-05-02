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
export const defaultSystemPrompt = `You are llm-wiki, an assistant that helps the user manage a Karpathy-style Markdown knowledge base.

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
  onAssistantText?: (delta: string) => void;
  onToolCall?: (call: { name: string; args: unknown }) => void;
  onToolResult?: (result: { name: string; ok: boolean; preview: string }) => void;
  onUsage?: (delta: UsageDelta) => void;
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

      this.messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        finalText = msg.content ?? '';
        if (finalText) events.onAssistantText?.(finalText);
        break;
      }

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
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.function.name}` }),
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
      return;
    }

    events.onToolCall?.({ name: tool.name, args: parsed });

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
    events.onToolResult?.({ name: tool.name, ok, preview });

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
  constructor(public readonly kind: AgentErrorKind, message: string) {
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
