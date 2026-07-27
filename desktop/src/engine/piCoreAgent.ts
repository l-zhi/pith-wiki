import { Agent as PiAgentCore, type AgentTool } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  Context as PiContext,
  Model as PiModel,
  Models,
  TSchema,
} from '@earendil-works/pi-ai';
import { fromPiMessages, piBlocksText, toPiMessages } from '@core/llm/piMessageMap.js';
import type { AgentLike } from './sessionManager.js';
import type { ScopeDTO } from '../shared/protocol.js';

/**
 * PiCoreAgent —— 用 `@earendil-works/pi-agent-core` 的 agent loop 跑 pith 的工具与会话
 * （迁移路线 **A** 的 tracer bullet，见 docs/research-pi-harness-migration.md §5）。
 *
 * 与路线 B（只换传输层）的区别：B 保留 pith 手写的 tool loop，只把出站 HTTP 换成 pi-ai；
 * A 把 loop 本身交给 pi-agent-core，于是拿到它的流式事件、并行工具执行、steering/follow-up
 * 这些能力（compaction / 树形会话属于 pi-coding-agent 那一层，不在本文件范围）。
 *
 * 设计约束（刻意的，让这个文件可以脱离 Electron 与真实 provider 测试）：
 *   - **依赖注入**：models/model/tools/security 全部由宿主传入。工具是 `PiCoreToolSpec`
 *     （name + JSON Schema + execute），宿主负责把 pith 的 zod 工具与 ToolContext 适配过来。
 *   - **对外仍是 AgentLike**：SessionManager 眼里与内置 Agent / 三个委托 CLI agent 可互换。
 *   - **历史仍是 OpenAI 形状**：`exportHistory()` 用 `fromPiMessages` 翻回来，既有的
 *     JSONL 持久化、`deriveDisplay` UI 回放、transcript 一行都不用改。这是让 A 可以
 *     增量落地（而不是一次性大爆炸）的关键。
 *
 * 已知取舍 / 待办（都是 A 全面落地前必须解决的，写在这里当活文档）：
 *   1. **安全过滤不再是「一个 monkey-patch 收口」**。pi-agent-core 不经 `chat.completions.create`，
 *      所以脱敏改在 `streamFn` 包装里做（出站 Context 逐字段 mask），还原分两处：
 *      流式 UI 事件用 spike 3 的流式还原器、`exportHistory()` 落盘前整体还原。
 *      **代价**：pi 内部持有的 `AgentMessage[]` 里存的是**脱敏后**的值（pith 现有实现是
 *      原地还原成原文），所以「pi 的会话对象」与「pith 落盘的历史」在脱敏场景下不再逐字相同。
 *   2. maxSteps 语义靠 `beforeToolCall` 阻断实现（达到上限后拒绝工具、逼模型作答），
 *      对齐 pith 的 `forceFinalAnswer`，但没有 pith 那条「预算告警」提前提醒。
 *   3. thinking 无签名（见 piMessageMap 的说明）。
 */

/** pith 工具的最小描述：JSON Schema + 一个「返回任意 JSON」的 execute。 */
export interface PiCoreToolSpec {
  name: string;
  description: string;
  /** JSON Schema（pith 侧由 `toolsForOpenAI` 从 zod 产出）。 */
  parameters: Record<string, unknown>;
  /**
   * pith 的工具语义：**返回**任意 JSON（失败也返回 `{ok:false,error}` 而不是抛）。
   * 这里保持 pith 语义，由本文件负责翻成 pi 的 `{content:[{type:'text'}]}`。
   */
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** 安全层钩子（由宿主用 Sanitizer + createStreamRestorer 组装；不传 = 不脱敏）。 */
export interface PiCoreSecurity {
  /** 出站：把一段文本脱敏成占位符形式。 */
  maskText(text: string): string;
  /** 入站（整段）：把占位符还原成原文。 */
  restoreText(text: string): string;
  /** 入站（流式）：造一个跨 chunk 的还原器（占位符可能被切在两个 delta 之间）。 */
  createRestorer(): { push(chunk: string): string; flush(): string };
}

export interface PiCoreAgentOptions {
  models: Models;
  model: PiModel<Api>;
  systemPrompt: string;
  tools: PiCoreToolSpec[];
  /** 工具轮数上限（对齐 pith 的 maxSteps）。达到后拒绝新工具调用，逼模型基于已有信息作答。 */
  maxToolTurns?: number;
  security?: PiCoreSecurity;
  /**
   * `@`-mention 范围钉死：把本轮 scope 预算成一段上下文，作为前置 user 消息压在问题前
   * （即使模型这轮不调 wiki_query，@文件/@目录 的内容也已在眼前）。返回空串 → 不注入。
   * 由宿主提供（需要 ContextAssembler，属于核心层）。
   */
  buildScopePreamble?: (question: string, scope: ScopeDTO) => string;
}

export type StreamEvents = {
  onThinking?: (e: { text: string; source: string }) => void;
  onAssistantText?: (e: { text: string; final: boolean }) => void;
  onToolRound?: (e: { name: string; args: unknown; ok: boolean; preview: string }) => void;
  onUsage?: (d: { inputTokens: number; outputTokens: number }) => void;
};

function truncatePreview(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** pith 工具 → pi AgentTool。JSON Schema 原样当 parameters（C 阶段实测 pi 接受）。 */
function toAgentTool(spec: PiCoreToolSpec): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as unknown as TSchema,
    // pith 的工具是共享服务上的串行操作（LibraryService 的内存索引 + index.json 写入），
    // 沿用 pith 的 p-queue(concurrency=1) 语义，不启用 pi 的并行执行。
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      const result = await spec.execute(params, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      };
    },
  } as AgentTool;
}

/** 出站脱敏：对 Context 里所有承载文本的字段做 mask（pi 不经 chat.completions，只能在这里收口）。 */
function maskContext(context: PiContext, security: PiCoreSecurity): PiContext {
  const maskBlocks = (content: unknown): unknown => {
    if (typeof content === 'string') return security.maskText(content);
    if (!Array.isArray(content)) return content;
    return content.map((raw) => {
      const b = raw as { type?: string; text?: string; thinking?: string; arguments?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        return { ...b, text: security.maskText(b.text) };
      }
      if (b.type === 'thinking' && typeof b.thinking === 'string') {
        return { ...b, thinking: security.maskText(b.thinking) };
      }
      if (b.type === 'toolCall') {
        // 工具参数恒为结构化对象；序列化后脱敏再 parse 回来，覆盖嵌套字段。
        try {
          return { ...b, arguments: JSON.parse(security.maskText(JSON.stringify(b.arguments ?? {}))) };
        } catch {
          return b;
        }
      }
      return b;
    });
  };
  return {
    ...context,
    ...(context.systemPrompt ? { systemPrompt: security.maskText(context.systemPrompt) } : {}),
    messages: context.messages.map((m) => ({ ...m, content: maskBlocks(m.content) })) as PiContext['messages'],
  };
}

export class PiCoreAgent implements AgentLike {
  private readonly agent: PiAgentCore;
  private turnsThisRun = 0;

  constructor(private readonly opts: PiCoreAgentOptions) {
    const security = opts.security;
    const base = opts.models.streamSimple.bind(opts.models);
    this.agent = new PiAgentCore({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        tools: opts.tools.map(toAgentTool),
        messages: [],
      },
      // 出站脱敏的唯一收口点（对应 pith 现有实现里的 client wrap）。
      streamFn: (model, context, options) =>
        base(model, security ? maskContext(context, security) : context, options),
      toolExecution: 'sequential',
      // maxSteps 语义：轮数触顶后拒绝工具调用（reason 会作为工具错误回给模型，逼它作答）。
      beforeToolCall: async () => {
        const cap = opts.maxToolTurns ?? 0;
        if (cap > 0 && this.turnsThisRun >= cap) {
          return {
            block: true,
            reason:
              `已达到工具调用轮数上限（${cap} 轮）。不要再调用任何工具，` +
              `直接基于已经收集到的信息给出最佳回答；信息不足就说明已知部分与还缺什么。`,
          };
        }
        return undefined;
      },
    });
  }

  async send(
    text: string,
    opts: {
      signal?: AbortSignal;
      /** `@`-mention 范围：经 buildScopePreamble 变成前置上下文消息（见下）。 */
      scope?: ScopeDTO;
      events?: StreamEvents;
    } = {},
  ): Promise<string> {
    const events = opts.events ?? {};
    const security = this.opts.security;
    this.turnsThisRun = 0;

    // @-mention：先把范围内的上下文作为一条前置 user 消息压进历史（与 pith 内置 Agent 同语义）。
    if (opts.scope && this.opts.buildScopePreamble) {
      const preamble = this.opts.buildScopePreamble(text, opts.scope);
      if (preamble.trim()) {
        this.agent.state.messages = [
          ...this.agent.state.messages,
          { role: 'user', content: preamble, timestamp: 0 },
        ] as never;
      }
    }

    /** 已完成轮次的正文（流式回放时拼前缀） + 当前轮的增量。 */
    const completed: string[] = [];
    let restorer = security?.createRestorer();
    let streaming = '';
    const pending = new Map<string, { name: string; args: unknown }>();

    const emitStreamed = () => {
      const all = [...completed, streaming].filter((t) => t.trim()).join('\n\n');
      if (all) events.onAssistantText?.({ text: all, final: false });
    };

    const unsubscribe = this.agent.subscribe((event) => {
      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta' && inner.delta) {
            // 占位符可能被切在两个 delta 之间 → 走跨 chunk 还原器（见 src/security/streamRestore.ts）
            streaming += restorer ? restorer.push(inner.delta) : inner.delta;
            emitStreamed();
          }
          break;
        }
        case 'message_end': {
          const msg = event.message as unknown as AssistantMessage & { role?: string };
          if (msg.role !== 'assistant') break;
          if (restorer) {
            streaming += restorer.flush();
            restorer = security?.createRestorer();
          }
          if (msg.usage) {
            events.onUsage?.({ inputTokens: msg.usage.input ?? 0, outputTokens: msg.usage.output ?? 0 });
          }
          const thinking = piBlocksText(msg.content, 'thinking');
          if (thinking) {
            events.onThinking?.({
              text: security ? security.restoreText(thinking) : thinking,
              source: 'pi-core',
            });
          }
          // 权威正文取完整消息的 text 块（流式增量可能被 provider 重传）
          const raw = piBlocksText(msg.content, 'text');
          const body = security ? security.restoreText(raw) : raw;
          streaming = '';
          if (body) completed.push(body);
          break;
        }
        case 'turn_end':
          this.turnsThisRun += 1;
          break;
        case 'tool_execution_start':
          pending.set(event.toolCallId, { name: event.toolName, args: event.args });
          break;
        case 'tool_execution_end': {
          const call = pending.get(event.toolCallId);
          pending.delete(event.toolCallId);
          const resultText = piBlocksText(
            (event.result as { content?: unknown } | undefined)?.content,
            'text',
          );
          events.onToolRound?.({
            name: call?.name ?? event.toolName,
            // pi 的 tool_execution_end 不带 args（只有 start 带）→ 靠 toolCallId 配对拿回
            args: call?.args,
            ok: !event.isError,
            preview: truncatePreview(security ? security.restoreText(resultText) : resultText),
          });
          break;
        }
        default:
          break;
      }
    });

    const onAbort = () => this.agent.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      await this.agent.prompt(text);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    }

    const errorMessage = this.agent.state.errorMessage;
    const finalText = completed.length ? completed[completed.length - 1] : '';
    if (!finalText && errorMessage) throw new Error(errorMessage);
    if (finalText) events.onAssistantText?.({ text: finalText, final: true });
    return finalText;
  }

  /**
   * 导出成 OpenAI 形状（pith 的内部标准）。脱敏开启时 pi 内部持有的是占位符形式，
   * 这里还原成原文 —— 与 pith 现有语义一致：**敏感数据不出机器，但本地落盘是原文**。
   */
  exportHistory(): unknown[] {
    const security = this.opts.security;
    const messages = fromPiMessages(this.agent.state.messages as unknown as unknown[]);
    if (!security) return messages;
    return messages.map((m) => {
      const copy = { ...m } as Record<string, unknown>;
      if (typeof copy.content === 'string') copy.content = security.restoreText(copy.content);
      if (typeof copy.reasoning_content === 'string') {
        copy.reasoning_content = security.restoreText(copy.reasoning_content);
      }
      if (Array.isArray(copy.tool_calls)) {
        copy.tool_calls = (copy.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (!fn || typeof fn.arguments !== 'string') return tc;
          return { ...tc, function: { ...fn, arguments: security.restoreText(fn.arguments) } };
        });
      }
      return copy;
    });
  }

  restoreHistory(messages: unknown[]): void {
    const { messages: pi } = toPiMessages(
      messages as Parameters<typeof toPiMessages>[0],
      this.opts.model.id,
    );
    // system 不回放：systemPrompt 由 Agent 配置自持（与 pith 内置 Agent 同语义）。
    this.agent.state.messages = pi as never;
  }

  reset(): void {
    this.agent.reset();
    this.agent.state.systemPrompt = this.opts.systemPrompt;
  }

  snapshot(): string {
    return this.exportHistory()
      .map((raw) => {
        const m = raw as { role?: string; content?: unknown };
        if (m.role === 'system' || typeof m.content !== 'string' || !m.content.trim()) return '';
        return `**${m.role}**: ${m.content}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
}
