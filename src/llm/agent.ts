import PQueue from 'p-queue';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { ALL_TOOLS, ToolContext, toolsForOpenAI, type AnyToolDef } from '../tools/index.js';
import type { ChatClient } from './transport.js';
import { SecurityBlockError } from '../security/index.js';
import type { QueryScope } from '../wiki/assembler.js';

/**
 * tool loop 触顶前预留的"收尾轮数"。剩余轮数 ≤ 此值时注入一次预算告警，
 * 促使模型趁 tools 还在时完成关键写入，而不是被 maxSteps 硬截断后只能描述步骤。
 */
const LOW_BUDGET_RESERVE = 3;

/**
 * 中性默认 system prompt——同时适用于 CLI 和嵌入用例。
 *
 * CLI 在 App.tsx 里追加一段 "你正运行在终端里" 的小后缀；嵌入应用按需
 * 通过 `AgentOptions.systemPrompt` 完整替换。
 */
export const defaultSystemPrompt = `You are pith-wiki, an assistant that helps the user manage a Karpathy-style Markdown knowledge base.

Available tools:
  File (sandboxed): read_file, write_file, list_dir
  Wiki retrieval:   wiki_query, wiki_grep, wiki_list, wiki_get, wiki_read_source
  Wiki write:       wiki_ingest, wiki_queue_add, wiki_queue_status

Choosing a retrieval tool — match the tool to the question:
  - Fuzzy / conceptual / "what do my notes say about X" → wiki_query (scored, tolerant)
  - Exact literal: an identifier, a verbatim phrase, a URL, an error string → wiki_grep
  - "ALL entries that mention X" (a census) → wiki_grep
  - wiki_query came back empty or missed a specific you KNOW is written → wiki_grep
    (it may have been dropped by wiki_query's compression / top-5 truncation)

Workflow for knowledge questions (stop as soon as you have enough):

1. wiki_query — keyword scoring over title/tags/summary/content + 1-hop forward
   links. NOT semantic search. For Chinese, the matcher uses bigrams (every two
   adjacent CJK chars), so a multi-character noun usually hits; broader queries
   (3-6 char fragments) often work better than full sentences. The returned
   "context" is a COMPRESSED digest (~30-50% of source) — good for orientation,
   may miss specifics. The returned "references" array gives each entry's source
   path, telling you whether an original file exists.

1b. wiki_grep — EXACT substring/regex search. By DEFAULT it greps each entry's
   ORIGINAL source (the raw .md, or the converted .md sidecar for PDF/EML/HTML),
   so it finds verbatim words even when wiki_query's digest compressed them out.
   patterns is OR-combined: for a fixed value with multiple surface forms (dates,
   ids, abbreviations) list ALL forms in ONE call — e.g.
   ["2026-06-04","2026/06/04","2026年6月4日"] — or pass one covering regex with
   regex:true. Do NOT grep the same thing repeatedly across rounds. Each hit's
   "searched" field says whether the original source or the compressed body matched.

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
  /**
   * 本轮检索范围（REPL `@`-mention）。非空时：
   *   1. 预先用 scope-aware query 算一段上下文，作为临时消息压在问题前（确保 @文件 钉死生效，
   *      即使模型本轮不调 wiki_query）；
   *   2. 本轮 tool 调用经 turnCtx 携带 scope，使后续 wiki_query 持续收窄。
   */
  scope?: QueryScope;
}

export class Agent {
  private messages: ChatCompletionMessageParam[];
  private queue = new PQueue({ concurrency: 1 });
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly toolRegistry: Map<string, AnyToolDef>;
  private readonly toolsPayload: ReturnType<typeof toolsForOpenAI>;
  /** 当前轮的检索范围（@-mention）。send() 入口设、finally 清。tool dispatch 据此构 turnCtx。 */
  private currentScope: QueryScope | null = null;

  constructor(
    private readonly client: ChatClient,
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
   * 导出当前对话历史的深拷贝（含 system）。桌面端 SessionManager 据此做
   * 会话持久化（增量 append 到 JSONL）；拷贝保证外部持有者不会污染内部状态。
   */
  exportHistory(): ChatCompletionMessageParam[] {
    return structuredClone(this.messages);
  }

  /**
   * 用持久化历史重建对话（会话恢复）。传入序列中的 system 消息被丢弃——
   * system prompt 永远由当前 Agent 配置自持（skill catalog / SOUL 可能已更新，
   * 旧 prompt 不应复活）。
   */
  restoreHistory(messages: ChatCompletionMessageParam[]): void {
    const rest = messages.filter((m) => m.role !== 'system');
    this.messages = [{ role: 'system', content: this.systemPrompt }, ...structuredClone(rest)];
  }

  /**
   * 把一段上下文（典型：用户用 `/skill <name>` 手动调出的 skill 指令）作为一条
   * 前置 user 消息压入历史，但 **不** 触发 LLM 请求。下一次 send() 时模型才会
   * 看到它——等价于用户在提问前先粘了一段说明。空串 no-op。
   */
  injectContext(text: string): void {
    if (text.trim()) this.messages.push({ role: 'user', content: text });
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
    const scope = normalizeScope(opts.scope);
    this.currentScope = scope;

    // 安全阻断的回滚点：SecurityBlockError 时把本轮压入的所有消息（scope preamble、
    // user 提问、中间 assistant/tool 轮）整体弹掉。否则违禁内容驻留历史，
    // 之后每一轮请求都会再次命中 block，会话被永久卡死。
    const historyMark = this.messages.length;

    // @-mention 钉死保证：本轮范围非空时，先用 scope-aware query 预算一段上下文，
    // 作为一条临时 user 消息压在真实问题前——即使模型本轮不调 wiki_query，
    // @文件 / @目录 的内容也已经在模型眼前。集合 scope 同时靠 currentScope 持续收窄。
    if (scope) {
      const preamble = this.buildScopePreamble(userMessage, scope);
      if (preamble) this.messages.push({ role: 'user', content: preamble });
    }
    this.messages.push({ role: 'user', content: userMessage });
    const events = opts.events ?? {};
    const tools = this.toolsPayload;

    try {
      let finalText = '';
      let answered = false;
      let warnedLowBudget = false;
      let safety = 0;
      while (safety++ < this.maxSteps) {
        // 预算告警：在触顶前若干轮注入一次提醒，让模型趁 tools 还在时优先完成关键的
        // 副作用操作（write_file / wiki_ingest），而不是把它留到最后被截断。否则跑满
        // maxSteps 后 forceFinalAnswer 会摘掉 tools，模型只能"描述如何写"却写不进去——
        // 定时日报"生成了却没落盘"正是这个失败模式。reserve=3 是经验值。
        const remaining = this.maxSteps - safety;
        if (!warnedLowBudget && remaining <= LOW_BUDGET_RESERVE && remaining > 0) {
          warnedLowBudget = true;
          this.messages.push({
            role: 'user',
            content:
              `[工具调用即将达到上限（还剩约 ${remaining} 轮）。如果你还有未完成的关键操作——` +
              `尤其是把结果写入文件（write_file）或入库（wiki_ingest）——请立即在接下来 1-2 轮内` +
              `真正执行完成，不要只描述步骤或给出手动命令。完成后再给出最终答复。]`,
          });
        }

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
          if (err instanceof SecurityBlockError) {
            this.messages.splice(historyMark);
            throw err;
          }
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
          answered = true;
          if (body) events.onAssistantText?.({ text: body, final: true });
          break;
        }

        // 中间轮叙述（"我去查…"）：终端默认不显，但事件仍发出，供 transcript 记录。
        if (body) events.onAssistantText?.({ text: body, final: false });

        for (const call of toolCalls) {
          await this.queue.add(() => this.runToolCall(call, events));
        }
      }

      // 跑满 maxSteps 仍未给出"不带 tool_call 的正式答案"：模型还想继续调工具，但被上限拦下。
      // 不能静默返回空串（用户只会看到 spinner 停下、没有任何回答，像卡死）。
      // 强制收尾一轮：不再提供 tools，让模型基于已收集到的信息直接作答。
      if (!answered) {
        finalText = await this.forceFinalAnswer(events, opts.signal);
      }

      return finalText;
    } finally {
      this.currentScope = null;
    }
  }

  /**
   * tool loop 触顶后的兜底收尾：追加一条系统提示要求"别再调工具、直接作答"，
   * 然后发一次**不带 tools** 的请求拿到正式答案。即便如此仍空，则抛 AgentError，
   * 绝不让 send() 返回空串（无声失败是最差的体验）。
   */
  private async forceFinalAnswer(events: AgentEvents, signal?: AbortSignal): Promise<string> {
    this.messages.push({
      role: 'user',
      content:
        `[已达到工具调用轮数上限（${this.maxSteps} 轮）。请不要再调用任何工具，` +
        `直接基于目前已经收集到的信息给出你能给出的最佳回答；` +
        `若信息确实不足，简要说明已知部分以及还缺什么。]`,
    });

    let completion: ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: this.messages,
          // 关键：不传 tools，模型无从再发起 tool_call，必然产出文本（或空）。
          stream: false,
        },
        { signal },
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
    const m = msg as unknown as Record<string, unknown>;
    const fieldReasoning =
      typeof m.reasoning_content === 'string'
        ? m.reasoning_content
        : typeof m.thinking === 'string'
          ? m.thinking
          : null;
    const rawContent = msg.content ?? '';
    this.messages.push({ role: 'assistant', content: rawContent });

    const split = splitThinking(rawContent);
    const thinking = fieldReasoning ?? split.thinking;
    if (thinking) events.onThinking?.({ text: thinking, source: fieldReasoning ? 'field' : 'tag' });
    const body = fieldReasoning ? rawContent.trim() : split.body;

    if (body) {
      events.onAssistantText?.({ text: body, final: true });
      return body;
    }
    throw new AgentError(
      'model_error',
      `Reached the ${this.maxSteps}-step tool-call limit without a final answer. ` +
        `Try rephrasing or narrowing the question, or raise maxSteps.`,
    );
  }

  /**
   * 用本轮 scope 预算一段上下文，渲染成一条说明性的 user preamble。
   * 返回空串 → 不注入（例如范围里啥也没召回到）。
   */
  private buildScopePreamble(userMessage: string, scope: QueryScope): string {
    const result = this.toolCtx.assembler.query(userMessage, 4000, scope);
    if (!result.context) return '';
    const hints: string[] = [];
    if (scope.collections?.length) hints.push(`collections: ${scope.collections.join(', ')}`);
    if (scope.folders?.length)
      hints.push(`folders: ${scope.folders.map((f) => `${f.collection}/${f.subpath}`).join(', ')}`);
    if (scope.entryIds?.length) hints.push(`pinned entries: ${scope.entryIds.join(', ')}`);
    return (
      `[Scoped context for this question — ${hints.join(' · ')}. ` +
      `Answer primarily from the entries below; use wiki_query (already scoped) only if you need more.]\n\n` +
      result.context
    );
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

    // 本轮有 @-mention scope 时，spread 一份带 scope 的 ctx 副本（共享底层 services），
    // 让 wiki_query 等工具按范围收窄；无 scope 则直接用基础 ctx（零开销）。
    const turnCtx: ToolContext = this.currentScope
      ? { ...this.toolCtx, scope: this.currentScope }
      : this.toolCtx;

    let result: unknown;
    try {
      result = await tool.handler(parsed as never, turnCtx);
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

/** 把 RunOptions.scope 收敛成"有内容才返回对象，否则 null"，统一空判断。 */
function normalizeScope(scope: QueryScope | undefined): QueryScope | null {
  if (!scope) return null;
  const collections = scope.collections ?? [];
  const folders = scope.folders ?? [];
  const entryIds = scope.entryIds ?? [];
  if (collections.length === 0 && folders.length === 0 && entryIds.length === 0) return null;
  return { collections, folders, entryIds };
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
