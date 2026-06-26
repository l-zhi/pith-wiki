import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AgentLike } from './sessionManager.js';

/**
 * ClaudeCodeAgent —— 把一次问答委托给本机 `claude` CLI（headless），让 Claude Code
 * 作为 agent 通过 pith 的 MCP server（mcp__pith__*）检索知识库后作答。实现 AgentLike，
 * 与 pith 内置 Agent 在 SessionManager 眼里可互换（按 provider.kind 分流）。
 *
 * 复用订阅额度：spawn 时注入 CLAUDE_CODE_OAUTH_TOKEN（见 opts.env），且不设
 * ANTHROPIC_API_KEY —— 则 headless 调用走 Pro/Max 订阅、不计 API 费。
 *
 * 多轮：首轮无 --resume，从 result 拿 session_id；后续 --resume 复用。pith 重启后
 * exportHistory/restoreHistory 仍保留对话本体供 UI 回放，但 CC 侧 session 续不上
 * （v1 限制：重开历史会话会丢 CC 端上下文，新会话不受影响）。
 */
export interface ClaudeCodeAgentOptions {
  /** claude 可执行文件（绝对路径或 PATH 中的名字）。 */
  binary: string;
  /** 模型别名或 id：sonnet / opus / claude-sonnet-4-6 … */
  model: string;
  /** 追加到 Claude Code 默认 system prompt 的 pith 检索人设。 */
  systemPrompt: string;
  /** 指向 pith-mcp 的 --mcp-config 文件路径。 */
  mcpConfigPath: string;
  /** spawn 环境（含 CLAUDE_CODE_OAUTH_TOKEN，且应剔除 ANTHROPIC_API_KEY）。 */
  env: NodeJS.ProcessEnv;
  /** 允许的工具白名单，默认只放行 pith 的 MCP 工具。 */
  allowedTools?: string;
}

export type StreamEvents = {
  onThinking?: (e: { text: string; source: string }) => void;
  onAssistantText?: (e: { text: string; final: boolean }) => void;
  onToolRound?: (e: { name: string; args: unknown; ok: boolean; preview: string }) => void;
  onUsage?: (d: { inputTokens: number; outputTokens: number }) => void;
};

export interface StreamResult {
  finalText: string;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number };
  isError: boolean;
}

interface RawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  event?: {
    type?: string;
    content_block?: { type?: string; name?: string; id?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

/**
 * 解析 `claude -p --output-format stream-json --include-partial-messages` 的逐行 JSON。
 * 抽成纯函数（输入是行的 async 迭代器）以便脱离真实 claude 进程做单元测试。
 *
 * 事件契约（见 docs / claude stream-json）：
 *  - system/init                         → 带 session_id
 *  - stream_event content_block_start    → tool_use（content_block.name = mcp__pith__…）
 *  - stream_event content_block_delta    → input_json_delta（拼 partial_json）| text_delta（拼答案）
 *  - stream_event content_block_stop     → 工具入参收齐 → onToolRound
 *  - stream_event message_delta          → usage（累积）
 *  - result                              → result（最终文本）、usage、session_id、is_error
 */
export async function parseClaudeStream(
  lines: AsyncIterable<string>,
  events: StreamEvents = {},
): Promise<StreamResult> {
  let finalText = '';
  let streamedText = '';
  let sessionId: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let isError = false;
  let toolName = '';
  let toolJson = '';

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: RawEvent;
    try {
      evt = JSON.parse(trimmed) as RawEvent;
    } catch {
      continue; // 忽略非 JSON 行（噪声 / 部分行）
    }
    if (evt.session_id) sessionId = evt.session_id;

    if (evt.type === 'result') {
      finalText = evt.result ?? streamedText;
      isError = evt.is_error === true;
      if (evt.usage) {
        usage = {
          inputTokens: evt.usage.input_tokens ?? 0,
          outputTokens: evt.usage.output_tokens ?? 0,
        };
        events.onUsage?.(usage);
      }
      break;
    }

    if (evt.type === 'stream_event' && evt.event) {
      const e = evt.event;
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        toolName = e.content_block.name ?? '';
        toolJson = '';
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        toolJson += e.delta.partial_json ?? '';
      } else if (e.type === 'content_block_stop' && toolName) {
        let args: unknown = toolJson;
        try {
          args = JSON.parse(toolJson);
        } catch {
          /* 入参未拼成合法 JSON 时原样给出 */
        }
        events.onToolRound?.({
          name: toolName.replace(/^mcp__pith__/, ''),
          args,
          ok: true,
          preview: '',
        });
        toolName = '';
        toolJson = '';
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streamedText += e.delta.text ?? '';
        events.onAssistantText?.({ text: streamedText, final: false });
      } else if (e.type === 'message_delta' && e.usage) {
        usage = {
          inputTokens: e.usage.input_tokens ?? usage.inputTokens,
          outputTokens: e.usage.output_tokens ?? usage.outputTokens,
        };
      }
    }
  }

  return { finalText, sessionId, usage, isError };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export class ClaudeCodeAgent implements AgentLike {
  private history: Msg[] = [];
  private ccSessionId: string | null = null;

  constructor(private readonly opts: ClaudeCodeAgentOptions) {}

  async send(
    text: string,
    opts: {
      signal?: AbortSignal;
      scope?: { collections: string[]; entryIds: string[] };
      events?: StreamEvents;
    } = {},
  ): Promise<string> {
    this.history.push({ role: 'user', content: text });

    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      this.opts.model,
      '--mcp-config',
      this.opts.mcpConfigPath,
      '--allowedTools',
      this.opts.allowedTools ?? 'mcp__pith__*',
      '--append-system-prompt',
      this.opts.systemPrompt,
    ];
    // --resume 复用 CC 侧会话（只发当前这条 user 消息，历史由 CC 记着）。
    if (this.ccSessionId) args.push('--resume', this.ccSessionId);
    // prompt 作为 -p 的值放最后（与本机验证的命令形态一致）。
    args.push('-p', text);

    console.log(
      `[pith/claude-code] spawn ${this.opts.binary} --model ${this.opts.model} ` +
        `${this.ccSessionId ? `--resume ${this.ccSessionId}` : '(new CC session)'} ` +
        `mcp=${this.opts.mcpConfigPath} token=${this.opts.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'unset'}`,
    );
    const child = spawn(this.opts.binary, args, {
      env: this.opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort);

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const rl = readline.createInterface({ input: child.stdout });
    let parsed: StreamResult;
    try {
      parsed = await parseClaudeStream(rl, opts.events);
    } finally {
      rl.close();
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await new Promise<number>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.on('close', (code) => resolve(code ?? 0));
    });

    if (parsed.sessionId) this.ccSessionId = parsed.sessionId;

    if (parsed.isError || (exitCode !== 0 && !parsed.finalText)) {
      const msg = parsed.finalText || stderr.trim() || `claude exited ${exitCode}`;
      throw new Error(msg);
    }

    this.history.push({ role: 'assistant', content: parsed.finalText });
    opts.events?.onAssistantText?.({ text: parsed.finalText, final: true });
    return parsed.finalText;
  }

  exportHistory(): unknown[] {
    return this.history;
  }

  restoreHistory(messages: unknown[]): void {
    this.history = messages as Msg[];
    this.ccSessionId = null; // CC 侧 session 不随 pith 历史持久化
  }

  reset(): void {
    this.history = [];
    this.ccSessionId = null;
  }

  snapshot(): string {
    return this.history
      .filter((m) => m.role !== 'system')
      .map((m) => `**${m.role}**: ${m.content}`)
      .join('\n\n');
  }
}
