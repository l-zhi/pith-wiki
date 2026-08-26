import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { QueryScope } from '../wiki/assembler.js';
import { explainDelegateError } from './delegateErrors.js';

export interface PithMcpSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Read the `mcpServers.pith` launch spec used by delegated CLI providers. */
export function readPithMcpSpec(configPath: string): PithMcpSpec | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: unknown; env?: unknown }>;
    };
    const server = raw.mcpServers?.pith;
    if (!server || typeof server.command !== 'string' || !server.command) return undefined;
    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    const env =
      server.env && typeof server.env === 'object'
        ? Object.fromEntries(
            Object.entries(server.env as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined;
    return { command: server.command, args, env };
  } catch {
    return undefined;
  }
}

/**
 * CodexAgent —— 把一次问答委托给本机 `codex` CLI（headless，`codex exec --json`），让 Codex
 * 作为 agent 通过 pith 的 MCP server（经 `-c mcp_servers.pith.*` 内联注册）检索知识库后作答。
 * 实现 AgentLike，与 pith 内置 Agent / ClaudeCodeAgent 在 SessionManager 眼里可互换
 * （按 provider.kind 分流）。是 ClaudeCodeAgent 的平级 sibling，只是 CLI 差异四处不同：
 *
 *   - 入口 `codex exec --json`（claude 是 `claude -p --output-format stream-json`）
 *   - MCP 经 `-c mcp_servers.pith.*` 内联覆盖（claude 是 `--mcp-config <file>`）
 *   - 多轮 `codex exec resume <thread_id>`（claude 是 `--resume <id>`）
 *   - 人设无 `--append-system-prompt` 标志，改为首轮前置拼进 prompt（resume 后人设已在 thread 历史里）
 *
 * 复用订阅额度：用户先 `codex login`（写 ~/.codex/auth.json），spawn 时不设 OPENAI_API_KEY，
 * codex 自动读 auth.json 走 ChatGPT/Codex 订阅、不计 API 费。
 *
 * 沙箱取舍（见 docs/PRD-codex-integration.md §2.5）：headless exec 下只有 `-s danger-full-access`
 * 能让 MCP 工具真正执行（受限沙箱下 MCP 调用会被判需审批、exec 无审批通道 → 被取消）。
 * 因此 codex 分支拿不到 claude-code `acceptEdits` 那种「写入限定在 cwd」的硬约束——写入只受
 * `-C <pith home>` + system prompt 的软约束。这是 v1 已知取舍（本机 + 用户主动选 codex + 只读 MCP）。
 *
 * 多轮：首轮无 resume，从 `thread.started` 事件拿 thread_id；后续 `codex exec resume <id>`。
 * pith 重启后 exportHistory/restoreHistory 仍保留对话本体供 UI 回放，但 codex 侧 thread 续不上
 * （v1 限制：重开历史会话会丢 codex 端上下文，新会话不受影响）。
 */
export interface CodexAgentOptions {
  /** codex 可执行文件（绝对路径或 PATH 中的名字）。 */
  binary: string;
  /** 模型别名或 id（传给 `-m`）；空则不传，用 codex 默认模型。 */
  model: string;
  /** 追加到首轮 prompt 前的 pith 检索人设（codex 无 --append-system-prompt，故前置拼接）。 */
  systemPrompt: string;
  /**
   * pith-mcp 的启动规格（从 pith-mcp.json 读出，翻成 `-c mcp_servers.pith.*` 内联覆盖）。
   * 无则不挂 MCP（codex 能聊天但读不到知识库）。
   */
  mcp?: PithMcpSpec;
  /** spawn 环境（订阅模式下应剔除 OPENAI_API_KEY，让 codex 走 ~/.codex/auth.json）。 */
  env: NodeJS.ProcessEnv;
  /** 沙箱模式，默认 danger-full-access（见类注释的取舍说明）。 */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * spawn 的工作目录（`-C`）。也是软约束的写入落点根——传 pith home，
   * 让 system prompt 引导模型写在这里。不传则继承父进程 cwd。
   */
  cwd?: string;
  /** Diagnostic logging hook. Defaults to console.log; CLI UIs can silence it. */
  log?: (message: string) => void;
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
  /** 错误信息（isError 时；来自 error 事件 message）。 */
  errorMessage?: string;
}

/** codex `mcp_tool_call` 结果里的 content 归一成字符串。 */
type CodexToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  structured_content?: unknown;
} | null;

function toolResultText(result: CodexToolResult): string {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .map((b) => (b?.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
}

function truncatePreview(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** codex exec --json 的单个事件（只声明我们用到的字段，未知字段忽略）。 */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  // mcp_tool_call
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: CodexToolResult;
  error?: { message?: string } | null;
  status?: string;
  // command_execution
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  // reasoning
  summary_text?: string;
  raw_content?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // error 事件的兜底字段
  message?: string;
  error?: { message?: string } | string;
}

/**
 * 解析 `codex exec --json` 的逐行 JSON（JSONL）。抽成纯函数（输入是行的 async 迭代器）
 * 以便脱离真实 codex 进程做单元测试（fixture 见 tests，来自 P0 实测抓取）。
 *
 * 事件契约（codex-cli 0.145.0，实测锁定，见 docs/PRD-codex-integration.md §2.5）：
 *  - thread.started      → thread_id（= resume 用的 session id）
 *  - turn.started        → 忽略
 *  - item.started        → mcp_tool_call 的 in_progress 先记入 pending（结果还没回来）
 *  - item.completed      → 按 item.type 分流：
 *      · agent_message      → 助手文本（累积并流式回放；finalText = 最后一条 agent_message）
 *      · mcp_tool_call      → 配对 pending → onToolRound（带 result 的 preview）
 *      · command_execution  → onToolRound（name='shell'，preview=aggregated_output）
 *      · reasoning          → onThinking
 *  - turn.completed      → usage（终止事件；codex 无 claude 那样的独立 result 事件）
 *  - error/stream_error/turn.aborted → isError
 *
 * 注意：codex 一轮里可能有多条 agent_message（先「我要调工具」再给答案）。流式回放发累积文本
 * （UI 看到进展），但 finalText 取**最后一条** agent_message（真正的答案），与 `-o
 * --output-last-message` 语义一致——CodexAgent 会用 -o 文件内容作更权威的 finalText 覆盖。
 */
export async function parseCodexStream(
  lines: AsyncIterable<string>,
  events: StreamEvents = {},
): Promise<StreamResult> {
  let sessionId: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let isError = false;
  let errorMessage: string | undefined;
  const agentMessages: string[] = [];
  // 已开始、等待 item.completed 的 mcp_tool_call：id → {name, args}（结果到达时才发，配 preview）。
  const pending = new Map<string, { name: string; args: unknown }>();

  const emitStreamedText = () => {
    events.onAssistantText?.({ text: agentMessages.join('\n\n'), final: false });
  };

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CodexEvent;
    try {
      evt = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue; // 忽略非 JSON 行（噪声 / 部分行）
    }

    const type = evt.type ?? '';
    if (type === 'thread.started' && evt.thread_id) {
      sessionId = evt.thread_id;
      continue;
    }
    if (type === 'turn.completed') {
      if (evt.usage) {
        usage = {
          inputTokens: evt.usage.input_tokens ?? 0,
          outputTokens: evt.usage.output_tokens ?? 0,
        };
        events.onUsage?.(usage);
      }
      continue; // 终止事件，但继续读干净剩余行（进程随后退出）
    }
    if (
      type === 'error' ||
      type === 'stream_error' ||
      type === 'turn.aborted' ||
      type === 'turn.failed'
    ) {
      isError = true;
      errorMessage =
        evt.message ??
        (typeof evt.error === 'string' ? evt.error : evt.error?.message) ??
        `codex ${type}`;
      continue;
    }

    const item = evt.item;
    if (!item) continue;

    if (type === 'item.started') {
      // mcp_tool_call 的 in_progress：暂存，等 item.completed 配 preview 再发。
      if (item.type === 'mcp_tool_call' && item.id) {
        pending.set(item.id, { name: item.tool ?? 'mcp_tool', args: item.arguments });
      }
      continue;
    }

    if (type !== 'item.completed') continue;

    switch (item.type) {
      case 'agent_message': {
        const text = item.text ?? '';
        if (text) {
          agentMessages.push(text);
          emitStreamedText();
        }
        break;
      }
      case 'reasoning': {
        const text = item.text ?? item.summary_text ?? item.raw_content ?? '';
        if (text) events.onThinking?.({ text, source: 'codex' });
        break;
      }
      case 'mcp_tool_call': {
        const call = item.id ? pending.get(item.id) : undefined;
        if (item.id) pending.delete(item.id);
        events.onToolRound?.({
          name: call?.name ?? item.tool ?? 'mcp_tool',
          args: call?.args ?? item.arguments,
          ok: item.status === 'completed' && !item.error,
          preview: item.error?.message
            ? `⚠ ${item.error.message}`
            : truncatePreview(toolResultText(item.result ?? null)),
        });
        break;
      }
      case 'command_execution': {
        events.onToolRound?.({
          name: 'shell',
          args: { command: item.command },
          ok: item.status === 'completed' && (item.exit_code ?? 0) === 0,
          preview: truncatePreview(item.aggregated_output ?? ''),
        });
        break;
      }
      default:
        break; // 其余 item 类型（file_change / web_search / image 等）v1 暂不映射
    }
  }

  // 流结束仍有未配对结果的 mcp_tool_call（异常收尾）：兜底补发，工具行不丢。
  for (const { name, args } of pending.values()) {
    events.onToolRound?.({ name, args, ok: false, preview: '' });
  }

  const finalText = agentMessages.length ? agentMessages[agentMessages.length - 1] : '';
  return { finalText, sessionId, usage, isError, errorMessage };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

let outFileSeq = 0;

export class CodexAgent {
  private history: Msg[] = [];
  private codexSessionId: string | null = null;
  private pendingContext: string[] = [];

  constructor(private readonly opts: CodexAgentOptions) {}

  /** 把 pith-mcp 启动规格翻成 `-c mcp_servers.pith.*` 覆盖（值按 TOML 解析）。 */
  private mcpConfigArgs(): string[] {
    const m = this.opts.mcp;
    if (!m) return [];
    const args = [
      '-c',
      `mcp_servers.pith.command=${JSON.stringify(m.command)}`,
      '-c',
      `mcp_servers.pith.args=${JSON.stringify(m.args)}`,
    ];
    if (m.env && Object.keys(m.env).length > 0) {
      // TOML inline table：{ KEY = "val", ... }
      const entries = Object.entries(m.env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(', ');
      args.push('-c', `mcp_servers.pith.env={ ${entries} }`);
    }
    return args;
  }

  async send(
    text: string,
    opts: {
      signal?: AbortSignal;
      // scope 目前不参与 codex 检索（它经 MCP 工具自查库），保留以满足 AgentLike。
      scope?: QueryScope;
      events?: StreamEvents;
    } = {},
  ): Promise<string> {
    this.history.push({ role: 'user', content: text });

    const pendingContext = this.pendingContext.splice(0);
    const turnPrompt = [...pendingContext, text].join('\n\n---\n\n');

    // codex 无 --append-system-prompt：首轮把人设前置拼进 prompt；resume 轮人设已在 thread 历史里。
    const prompt =
      !this.codexSessionId && this.opts.systemPrompt.trim()
        ? `${this.opts.systemPrompt.trim()}\n\n---\n\n${turnPrompt}`
        : turnPrompt;

    const outFile = path.join(os.tmpdir(), `pith-codex-last-${process.pid}-${++outFileSeq}.txt`);
    const sandbox = this.opts.sandbox ?? 'danger-full-access';

    // 公共 flag（`codex exec` 与 `codex exec resume` 都接受）。注意 resume 子命令**不接受**
    // `-s/--sandbox` 与 `-C/--cd`：所以沙箱统一用 `-c sandbox_mode=...`（两者都认 -c），
    // 工作目录统一靠 spawn 的 cwd（resume 靠进程 cwd + 显式 SESSION_ID 定位会话，不需 -C）。
    const commonFlags = [
      '--json',
      '--skip-git-repo-check', // pith home 不是 git 仓库，不加 codex exec 会拒跑
      '-c',
      `sandbox_mode=${JSON.stringify(sandbox)}`,
      ...(this.opts.model ? ['-m', this.opts.model] : []),
      '-o',
      outFile,
      ...this.mcpConfigArgs(),
    ];

    const args = this.codexSessionId
      ? ['exec', 'resume', this.codexSessionId, ...commonFlags, prompt]
      : ['exec', ...commonFlags, ...(this.opts.cwd ? ['-C', this.opts.cwd] : []), prompt];

    (this.opts.log ?? console.log)(
      `[pith/codex] spawn ${this.opts.binary} exec ${this.codexSessionId ? `resume ${this.codexSessionId}` : '(new thread)'} ` +
        `model=${this.opts.model || '(default)'} sandbox=${sandbox} mcp=${this.opts.mcp ? 'on' : 'off'} ` +
        `apiKey=${this.opts.env.OPENAI_API_KEY ? 'set' : 'unset(subscription)'}`,
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
      parsed = await parseCodexStream(rl, opts.events);
    } finally {
      rl.close();
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await new Promise<number>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.on('close', (code) => resolve(code ?? 0));
    });

    if (parsed.sessionId) this.codexSessionId = parsed.sessionId;

    // -o 写出的「最后一条消息」是最权威的最终文本；读到就覆盖 parser 的 finalText。
    let finalText = parsed.finalText;
    try {
      const fromFile = fs.readFileSync(outFile, 'utf8').trim();
      if (fromFile) finalText = fromFile;
    } catch {
      /* 无 -o 文件（异常退出等）→ 用 parser 的 finalText */
    } finally {
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* best effort */
      }
    }

    if (opts.signal?.aborted) {
      const err = new Error('Codex request aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (parsed.isError || (exitCode !== 0 && !finalText)) {
      const msg = parsed.errorMessage || finalText || stderr.trim() || `codex exited ${exitCode}`;
      throw new Error(explainDelegateError('codex', msg));
    }

    this.history.push({ role: 'assistant', content: finalText });
    opts.events?.onAssistantText?.({ text: finalText, final: true });
    return finalText;
  }

  exportHistory(): unknown[] {
    return this.history;
  }

  restoreHistory(messages: unknown[]): void {
    this.history = messages as Msg[];
    this.codexSessionId = null; // codex 侧 thread 不随 pith 历史持久化
    this.pendingContext = [];
  }

  reset(): void {
    this.history = [];
    this.codexSessionId = null;
    this.pendingContext = [];
  }

  injectContext(text: string): void {
    if (!text.trim()) return;
    this.history.push({ role: 'user', content: text });
    this.pendingContext.push(text);
  }

  hasContent(): boolean {
    return this.history.length > 0;
  }

  snapshot(): string {
    return this.history
      .filter((m) => m.role !== 'system')
      .map((m) => `**${m.role}**: ${m.content}`)
      .join('\n\n');
  }
}
