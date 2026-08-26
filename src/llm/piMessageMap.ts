import type {
  AssistantMessage,
  Context as PiContext,
  Message as PiMessage,
  TSchema,
  Tool as PiTool,
} from '@earendil-works/pi-ai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

/**
 * pith 的 OpenAI 形状消息 ↔ pi-ai 消息 的双向映射。
 *
 * 为什么这层单独存在：pith 的**内部标准**是 OpenAI 形状（历史、桌面端 JSONL 持久化、
 * `deriveDisplay` 的 UI 回放、transcript 都按这个形状读写）。要用 pi 生态（传输层 pi-ai =
 * 路线 B，agent loop pi-agent-core = 路线 A）就必须在边界上翻译，而**两个方向都需要**：
 *   - 去程（toPiMessages）：把历史喂给 pi
 *   - 回程（fromPiMessages）：把 pi 的会话还原成 pith 形状，才能落既有 JSONL、走既有回放
 *
 * 语义损耗（明说）：thinking 只带文本、不带 provider 签名（OpenAI 形状里无处存放），
 * 所以 Anthropic 原生 extended thinking 的多轮签名链在这层会断。DeepSeek/GLM 的
 * `reasoning_content` 语义无损。
 */

/** OpenAI 的 tool 声明（JSON Schema）→ pi-ai Tool。实测 pi 侧接受普通 JSON Schema。 */
export function toPiTools(tools: ChatCompletionTool[] | undefined): PiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as unknown as TSchema,
  }));
}

export function textOf(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  // pith 只产纯文本 content；数组形态兜底拼接 text 片段。
  return content
    .map((part) => (typeof part === 'string' ? part : 'text' in part ? (part.text ?? '') : ''))
    .join('');
}

/** 回放历史时给 pi 的 assistant 消息补齐响应元数据（不参与请求构造，给最小合法值）。 */
function replayMeta(model: string): Omit<AssistantMessage, 'role' | 'content' | 'stopReason' | 'timestamp'> {
  return {
    api: 'openai-completions',
    provider: 'pith-endpoint',
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export interface ToPiResult {
  systemPrompt?: string;
  messages: PiMessage[];
}

/**
 * OpenAI 形状历史 → pi-ai 消息序列 + systemPrompt。
 *
 * 细节：
 *   - 所有 system/developer 消息拼成 systemPrompt（pith 只有一条，位置固定在头部）
 *   - assistant 的 `reasoning_content` / `thinking` → thinking 块（无签名）
 *   - assistant 的 `tool_calls` → toolCall 块（arguments 从 JSON 字符串 parse 回对象；
 *     parse 失败兜底成 `{_raw}`，不让整轮请求崩掉）
 *   - tool 消息 → toolResult；`toolName` 由前面 assistant 的 tool_calls 按 id 反查
 *     （pi-ai 的 ToolResultMessage 要求 toolName，OpenAI 形状里没这个字段）
 */
export function toPiMessages(
  messages: ChatCompletionMessageParam[],
  model = 'unknown',
): ToPiResult {
  const systemParts: string[] = [];
  const out: PiMessage[] = [];
  const toolNameById = new Map<string, string>();
  const ts = 0; // 确定性时间戳：pith 不用它排序，固定值让请求可比对（测试友好）

  for (const raw of messages) {
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
      out.push({ role: 'user', content: textOf(m.content), timestamp: ts });
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
          args = { _raw: call.function.arguments };
        }
        content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
      }
      out.push({
        role: 'assistant',
        content,
        ...replayMeta(model),
        stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: ts,
      });
      continue;
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      out.push({
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
  return { ...(systemParts.length ? { systemPrompt: systemParts.join('\n\n') } : {}), messages: out };
}

/** OpenAI 形状的完整请求 → pi-ai Context（含 tools）。传输层（路线 B）用。 */
export function toPiContext(body: ChatCompletionCreateParamsNonStreaming): PiContext {
  const { systemPrompt, messages } = toPiMessages(body.messages, body.model);
  const tools = toPiTools(body.tools as ChatCompletionTool[] | undefined);
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
    ...(tools ? { tools } : {}),
  };
}

/**
 * pi-ai 消息序列 → OpenAI 形状历史（去程的逆）。
 *
 * 用于路线 A：pi-agent-core 持有 `AgentMessage[]`，但 pith 的持久化 / UI 回放 / transcript
 * 全按 OpenAI 形状读写，所以 `exportHistory()` 必须翻回来。
 *
 * 映射：
 *   - user → `{role:'user', content}`
 *   - assistant → `{role:'assistant', content: text 块拼接, reasoning_content: thinking 块拼接,
 *     tool_calls: toolCall 块（arguments JSON.stringify）}`
 *   - toolResult → `{role:'tool', tool_call_id, content: text 块拼接}`
 *   - pi 的自定义消息角色（bashExecution / compactionSummary 等）不是 LLM 消息，跳过
 *     —— 它们在 pith 的形状里没有对应物，落盘会污染回放。
 */
export function fromPiMessages(messages: readonly unknown[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
    };
    if (m.role === 'user') {
      out.push({ role: 'user', content: piBlocksText(m.content, 'text') });
      continue;
    }
    if (m.role === 'assistant') {
      const text = piBlocksText(m.content, 'text');
      const thinking = piBlocksText(m.content, 'thinking');
      const calls = piToolCalls(m.content);
      out.push({
        role: 'assistant',
        content: text,
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      } as ChatCompletionMessageParam);
      continue;
    }
    if (m.role === 'toolResult') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: piBlocksText(m.content, 'text'),
      });
      continue;
    }
    // 其它角色（pi 的 UI-only / 自定义消息）不落 pith 历史
  }
  return out;
}

/** 从 pi 的 content（块数组或字符串）里取某类块的文本。 */
export function piBlocksText(content: unknown, kind: 'text' | 'thinking'): string {
  if (typeof content === 'string') return kind === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => (b as { type?: string })?.type === kind)
    .map((b) =>
      kind === 'text'
        ? ((b as { text?: string }).text ?? '')
        : ((b as { thinking?: string }).thinking ?? ''),
    )
    .join('\n')
    .trim();
}

/** 从 pi 的 content 里取 toolCall 块，翻成 OpenAI 的 tool_calls。 */
export function piToolCalls(content: unknown): ChatCompletionMessageToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => (b as { type?: string })?.type === 'toolCall')
    .map((b) => {
      const call = b as { id?: string; name?: string; arguments?: unknown };
      return {
        id: call.id ?? '',
        type: 'function' as const,
        function: {
          name: call.name ?? 'tool',
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      };
    });
}
