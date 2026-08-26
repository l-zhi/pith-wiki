import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AgentLike } from './sessionManager.js';
import type { ScopeDTO } from '../shared/protocol.js';
import { explainDelegateError } from './delegateErrors.js';

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
/**
 * claude-code provider 的默认 `--allowedTools`（逗号分隔）。除 pith 自家 MCP 工具外，
 * 默认放行两类外部技能，好让无人值守的定时任务也能核验飞书 / 微信读书当日动态：
 *   - `Bash(lark-cli:*)` —— 飞书 lark-* 技能全走 lark-cli（用用户已登录的飞书凭据）。
 *   - `Bash(curl:*)`     —— 微信读书技能用 curl POST i.weread.qq.com 网关（读 WEREAD_API_KEY）。
 * 安全取舍：等于允许无监督执行 lark-cli 与 curl；curl 无法按 URL 收窄，实际等于放开出站
 * HTTP。这是为「飞书/weread 默认可用」接受的代价。要收紧就传 opts.allowedTools 覆盖。
 * 前提：微信读书还需在设置里配好 WEREAD_API_KEY（否则 curl 拿不到 Bearer）。
 */
export const DEFAULT_ALLOWED_TOOLS = 'mcp__pith__*,Bash(lark-cli:*),Bash(curl:*)';

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
  /** 允许的工具白名单（逗号分隔）；不传用 DEFAULT_ALLOWED_TOOLS（pith MCP + 飞书/weread）。 */
  allowedTools?: string;
  /**
   * 与用户自己的 Claude Code 环境的隔离级别。**默认 'standard'。**
   *
   * 为什么需要：`claude -p` 起的是**完整的 Claude Code harness**，默认会自动发现并加载
   * 用户的 skills（本机实测 64 个，全都进 system prompt 的 catalog）、已启用 plugins、
   * hooks、其它 MCP server、以及 CLAUDE.md 记忆。这些是用户为自己的编码工作流准备的，
   * 与「pith 的知识库助手」这个人设无关：轻则白烧 token、重则 hook 在 pith 的会话里
   * 触发副作用，或记忆里的指令跟 pith 的人设打架。
   *
   *   - `standard`（默认）：`--strict-mcp-config`（只用 pith 的 MCP）+
   *     `--disable-slash-commands`（不加载 skills）+ `--setting-sources project`
   *     （不吃用户级 settings，即 plugins/hooks）。**订阅照常可用**（实测 OAuth 不受影响）。
   *     挡不住的只有 CLAUDE.md 自动发现 —— 那个只有 `--bare` 能关。
   *   - `bare`：额外加 `--bare`，连 CLAUDE.md/hooks/plugin sync 一并掐掉。**代价：Claude Code
   *     会强制走 ANTHROPIC_API_KEY / apiKeyHelper，不读 OAuth 与 keychain —— 即放弃订阅额度。**
   *     配了 API key 且要完全确定性时用它。
   *   - `off`：什么都不加，完全继承用户环境（想让 pith 会话用上自己那套 skills/hooks 时）。
   */
  isolation?: 'standard' | 'bare' | 'off';
  /**
   * spawn 的工作目录。也是 acceptEdits 的写入沙箱边界（只能写该目录内）——
   * 传 pith home，让模型写得了知识库、出不去。不传则继承父进程 cwd。
   */
  cwd?: string;
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

/** tool_result 块里的 content 可能是纯字符串，也可能是 content-block 数组。 */
type ToolResultContent = string | Array<{ type?: string; text?: string }>;

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
  /** 顶层 user 消息：工具结果作为 tool_result 块回来（非 stream_event）。 */
  message?: {
    content?: Array<{
      type?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: ToolResultContent;
    }>;
  };
}

/** tool_result 的 content 归一成字符串。 */
function toolResultText(content: ToolResultContent | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join('')
      .trim();
  return '';
}

function truncatePreview(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 解析 `claude -p --output-format stream-json --include-partial-messages` 的逐行 JSON。
 * 抽成纯函数（输入是行的 async 迭代器）以便脱离真实 claude 进程做单元测试。
 *
 * 事件契约（见 docs / claude stream-json）：
 *  - system/init                         → 带 session_id
 *  - stream_event content_block_start    → tool_use（content_block.name = mcp__pith__…、id）→ 记入 pending
 *  - stream_event content_block_delta    → input_json_delta（拼 partial_json）| text_delta（拼答案）
 *  - stream_event content_block_stop     → 工具入参收齐 → 暂存到 pending（此刻结果还没回来）
 *  - user 消息（顶层，非 stream_event）    → tool_result 块（tool_use_id 配对）→ onToolRound（带 preview）
 *  - stream_event message_delta          → usage（累积）
 *  - result                              → result（最终文本）、usage、session_id、is_error
 *
 * 注意：工具结果是作为独立的顶层 `type:"user"` 消息（tool_result 块）回来的，
 * 不在 stream_event 里。所以 onToolRound 延后到结果到达时才发（配 preview），
 * 而不是在 content_block_stop 就发空 preview——否则 UI 永远显示"（空结果）"。
 * 流末仍有未配对的 tool_use 就兜底补发（preview 空），保证工具行不丢。
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
  let toolId = '';
  let toolJson = '';
  // 已收齐入参、等待 tool_result 配对的工具调用：tool_use_id → {name, args}。
  const pending = new Map<string, { name: string; args: unknown }>();

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

    // 顶层 user 消息携带 tool_result：配对 pending 里的 tool_use，发出带 preview 的事件。
    if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        events.onToolRound?.({
          name: call.name,
          args: call.args,
          ok: block.is_error !== true,
          preview: truncatePreview(toolResultText(block.content)),
        });
      }
      continue;
    }

    if (evt.type === 'stream_event' && evt.event) {
      const e = evt.event;
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        toolName = e.content_block.name ?? '';
        toolId = e.content_block.id ?? '';
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
        // 结果还没回来——暂存，等 tool_result 到达时再发（配 preview）。
        // 无 id（异常流）则退化为立即发空 preview，至少不丢工具行。
        const name = toolName.replace(/^mcp__pith__/, '');
        if (toolId) pending.set(toolId, { name, args });
        else events.onToolRound?.({ name, args, ok: true, preview: '' });
        toolName = '';
        toolId = '';
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

  // 流结束仍有未配对 tool_result 的调用（异常收尾 / 结果未回）：兜底补发，工具行不丢。
  for (const { name, args } of pending.values()) {
    events.onToolRound?.({ name, args, ok: true, preview: '' });
  }

  return { finalText, sessionId, usage, isError };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export class ClaudeCodeAgent implements AgentLike {
  private history: Msg[] = [];
  private ccSessionId: string | null = null;

  constructor(private readonly opts: ClaudeCodeAgentOptions) {}

  /** 组装本轮 argv。抽出来便于单测（不 spawn 也能断言 flag 组合）。 */
  buildArgs(text: string): string[] {
    const isolation = this.opts.isolation ?? 'standard';
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
      this.opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      // 默认放行写文件，免去每次写 wiki output 都要授权。acceptEdits 只自动
      // 批准 Edit/Write，且实测把写入沙箱限定在进程 cwd（= pith home）内——
      // 写得了知识库目录，写不出 pith home（实测 Desktop 等外部路径仍被拒）。
      // scoped 的 Write(路径) allow 规则在 headless 下不生效，acceptEdits 才可靠。
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
      this.opts.systemPrompt,
    ];
    // 与用户自己的 CC 环境隔离（见 ClaudeCodeAgentOptions.isolation）。
    if (isolation !== 'off') {
      args.push('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project');
      if (isolation === 'bare') args.push('--bare');
    }
    // --resume 复用 CC 侧会话（只发当前这条 user 消息，历史由 CC 记着）。
    if (this.ccSessionId) args.push('--resume', this.ccSessionId);
    // prompt 作为 -p 的值放最后（与本机验证的命令形态一致）。
    args.push('-p', text);
    return args;
  }

  async send(
    text: string,
    opts: {
      signal?: AbortSignal;
      // scope 目前不参与 claude-code 检索（它经 MCP 工具自查库），保留以满足 AgentLike。
      scope?: ScopeDTO;
      events?: StreamEvents;
    } = {},
  ): Promise<string> {
    this.history.push({ role: 'user', content: text });

    const args = this.buildArgs(text);

    console.log(
      `[pith/claude-code] spawn ${this.opts.binary} --model ${this.opts.model} ` +
        `${this.ccSessionId ? `--resume ${this.ccSessionId}` : '(new CC session)'} ` +
        `mcp=${this.opts.mcpConfigPath} token=${this.opts.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'unset'}`,
    );
    const child = spawn(this.opts.binary, args, {
      env: this.opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
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
      throw new Error(explainDelegateError('claude-code', msg));
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
