import { spawn } from 'node:child_process';
import type { AgentLike } from './sessionManager.js';
import type { ScopeDTO } from '../shared/protocol.js';

/**
 * PiAgent —— 把一次问答委托给本机 `pi` CLI（headless，`pi --mode json`），让 pi 作为 agent
 * 通过 pith 的 MCP 桥接扩展检索知识库后作答。实现 AgentLike，与内置 Agent /
 * ClaudeCodeAgent / CodexAgent 在 SessionManager 眼里可互换（按 provider.kind 分流）。
 *
 * 与两个 sibling 的差异（都源自 pi 的设计取向）：
 *   - 入口 `pi --mode json <prompt>`（claude 是 `-p --output-format stream-json`，codex 是 `exec --json`）
 *   - **pi 无内置 MCP**：知识库经 `-e <bridge>` 扩展挂上（见 piBridgeSource.ts），不是 --mcp-config
 *   - 多轮 `--session <id>`（首轮从 session header 拿 id；claude 是 --resume，codex 是 exec resume）
 *   - 人设走 `--append-system-prompt`（与 claude-code 同；codex 只能前置拼进 prompt）
 *   - 事件流是 pi 自己的 AgentSessionEvent（message_update/tool_execution_* 等，见 pi docs/json.md）
 *
 * 复用订阅额度：用户先 `pi` 交互模式里 `/login`（写 ~/.pi/agent/auth.json），spawn 时不注入
 * API key，pi 自动走 OAuth 订阅（Claude Pro/Max、GitHub Copilot、xAI 等）。配了 apiKey 才
 * 传 `--api-key` 走按量计费。
 *
 * 确定性与安全取舍（v1，与 codex 分支同级）：
 *   - `--no-extensions -e <bridge>`：只加载 pith 的桥接扩展，忽略用户全局扩展（避免行为漂移）
 *   - `-na`（--no-approve）：忽略工作目录里的 project-local `.pi` 资源，防止知识库目录里的
 *     `.pi/settings.json` 劫持 pi 配置（pi 的 project trust 在非交互模式默认不提示）
 *   - `-nc`（--no-context-files）：不吃 AGENTS.md / CLAUDE.md（pith home 的祖先目录可能有）
 *   - pi 明确不提供沙箱/权限弹窗，因此内建 write/edit/bash 是全权的——写入落点只受
 *     spawn cwd + system prompt 的软约束（与 codex 的 danger-full-access 同一取舍）
 *
 * 多轮限制：pith 重启后 exportHistory/restoreHistory 仍保留对话本体供 UI 回放，但
 * pi 侧 session id 不随 pith 历史持久化（与 claude-code/codex 一致的 v1 限制）。
 */
export interface PiAgentOptions {
  /** pi 可执行文件（绝对路径或 PATH 中的名字）。 */
  binary: string;
  /** 模型 pattern（传给 `--model`，支持 `provider/id:thinking`）；空则用 pi 默认模型。 */
  model: string;
  /** 追加到 pi 默认 system prompt 之后的 pith 检索人设。 */
  systemPrompt: string;
  /** MCP 桥接扩展的绝对路径（ensurePiBridge 的返回值）。无则不挂知识库。 */
  bridgePath?: string;
  /** pith-mcp 启动规格；经环境变量传给桥接扩展。无则桥接扩展 no-op。 */
  mcp?: { command: string; args: string[]; env?: Record<string, string> };
  /** spawn 环境（订阅模式下不含 provider API key）。 */
  env: NodeJS.ProcessEnv;
  /** spawn 的工作目录，也是写入落点的软约束根（传 pith home）。 */
  cwd?: string;
  /** pi 会话文件目录（`--session-dir`）。让 pith 拥有这些会话文件，不混进用户的 ~/.pi。 */
  sessionDir?: string;
  /** 显式 API key（配了就按量计费；不配走 ~/.pi/agent/auth.json 订阅）。 */
  apiKey?: string;
}

export type StreamEvents = {
  onThinking?: (e: { text: string; source: string }) => void;
  onAssistantText?: (e: { text: string; final: boolean }) => void;
  onToolRound?: (e: { name: string; args: unknown; ok: boolean; preview: string }) => void;
  onUsage?: (d: { inputTokens: number; outputTokens: number }) => void;
};

export interface StreamResult {
  finalText: string;
  /** pi 的 session id（来自首行 session header），多轮 `--session <id>` 用。 */
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number };
  isError: boolean;
  errorMessage?: string;
}

/** pi 事件里的内容块（AssistantMessage.content / ToolResult.content）。 */
interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface PiMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  usage?: { input?: number; output?: number };
  stopReason?: string;
  errorMessage?: string;
}

/** `pi --mode json` 的单条事件（只声明用到的字段；未知字段忽略）。 */
interface PiEvent {
  type?: string;
  // session header（首行）
  id?: string;
  // message_* 事件
  message?: PiMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
  // tool_execution_* 事件
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: PiContentBlock[] };
  isError?: boolean;
}

function truncatePreview(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function blocksText(blocks: PiContentBlock[] | string | undefined, kind: 'text' | 'thinking'): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') return kind === 'text' ? blocks : '';
  return blocks
    .filter((b) => b?.type === kind)
    .map((b) => (kind === 'text' ? (b.text ?? '') : (b.thinking ?? '')))
    .join('\n')
    .trim();
}

/**
 * 把 stdout 的 chunk 流切成行。**不用 node:readline**：pi 的 rpc.md 明确警告
 * readline 还会在 U+2028/U+2029 处断行，而这两个字符在 JSON 字符串里合法
 * （知识库正文完全可能带），会把一条事件切成两半解析失败。只按 \n 切，容忍 \r\n。
 */
export async function* splitJsonLines(
  stream: AsyncIterable<string | Buffer>,
): AsyncIterable<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  if (buf) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}

/**
 * 解析 `pi --mode json` 的逐行 JSON。抽成纯函数（输入是行的 async 迭代器）以便脱离真实
 * pi 进程做单元测试。
 *
 * 事件契约（pi 0.82.1，见其 docs/json.md 与 dist/modes/print-mode.js）：
 *  - 首行 session header      → `{type:'session', version, id, cwd}`，id = `--session` 用的会话 id
 *  - message_update           → assistantMessageEvent.type='text_delta' 的 delta 累积成流式正文
 *  - message_end (assistant)  → 该轮完整消息：text 块 = 权威正文，thinking 块 → onThinking，
 *                               usage 累加，stopReason='error'|'aborted' → isError
 *  - tool_execution_start/end → 按 toolCallId 配对成一条 onToolRound（end 时才发，带 preview）
 *  - agent_end                → 本次 prompt 结束（仍继续读干净剩余行）
 *
 * finalText 取**最后一条**非空 assistant 正文（中间轮可能是「我去查一下」）。
 */
export async function parsePiStream(
  lines: AsyncIterable<string>,
  events: StreamEvents = {},
): Promise<StreamResult> {
  let sessionId: string | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let isError = false;
  let errorMessage: string | undefined;
  /** 已完成轮次的正文（用于流式回放时拼前缀，以及取最后一条作 finalText）。 */
  const completedTexts: string[] = [];
  /** 当前轮的流式增量。 */
  let streaming = '';
  const pending = new Map<string, { name: string; args: unknown }>();

  const emitStreamed = () => {
    const text = [...completedTexts, streaming].filter((t) => t.trim()).join('\n\n');
    if (text) events.onAssistantText?.({ text, final: false });
  };

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: PiEvent;
    try {
      evt = JSON.parse(trimmed) as PiEvent;
    } catch {
      continue; // 非 JSON 行（pi 的诊断输出等）忽略
    }

    switch (evt.type) {
      case 'session': {
        if (evt.id) sessionId = evt.id;
        break;
      }
      case 'message_update': {
        const inner = evt.assistantMessageEvent;
        if (inner?.type === 'text_delta' && inner.delta) {
          streaming += inner.delta;
          emitStreamed();
        }
        break;
      }
      case 'message_end': {
        const msg = evt.message;
        if (msg?.role !== 'assistant') break;
        if (msg.usage) {
          usage.inputTokens += msg.usage.input ?? 0;
          usage.outputTokens += msg.usage.output ?? 0;
          events.onUsage?.({ ...usage });
        }
        const thinking = blocksText(msg.content, 'thinking');
        if (thinking) events.onThinking?.({ text: thinking, source: 'pi' });
        // 权威正文取 message_end 的 text 块（流式增量可能被 provider 重传/截断）。
        const text = blocksText(msg.content, 'text');
        streaming = '';
        if (text) completedTexts.push(text);
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          isError = true;
          errorMessage = msg.errorMessage ?? `pi request ${msg.stopReason}`;
        }
        break;
      }
      case 'tool_execution_start': {
        if (evt.toolCallId) {
          pending.set(evt.toolCallId, { name: evt.toolName ?? 'tool', args: evt.args });
        }
        break;
      }
      case 'tool_execution_end': {
        const call = evt.toolCallId ? pending.get(evt.toolCallId) : undefined;
        if (evt.toolCallId) pending.delete(evt.toolCallId);
        events.onToolRound?.({
          name: call?.name ?? evt.toolName ?? 'tool',
          args: call?.args ?? evt.args,
          ok: evt.isError !== true,
          preview: truncatePreview(blocksText(evt.result?.content, 'text')),
        });
        break;
      }
      default:
        break; // turn_*/agent_*/compaction_*/auto_retry_* 等 v1 不映射
    }
  }

  // 流意外中断时仍有未收尾的工具调用：兜底补发，工具行不丢（与 codex 分支同策略）。
  for (const { name, args } of pending.values()) {
    events.onToolRound?.({ name, args, ok: false, preview: '' });
  }

  const finalText = completedTexts.length ? completedTexts[completedTexts.length - 1] : '';
  return { finalText, sessionId, usage, isError, errorMessage };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export class PiAgent implements AgentLike {
  private history: Msg[] = [];
  private piSessionId: string | null = null;

  constructor(private readonly opts: PiAgentOptions) {}

  /** 桥接扩展所需的环境变量（pith-mcp 的启动规格）。无 mcp → 扩展自行 no-op。 */
  private bridgeEnv(): NodeJS.ProcessEnv {
    const m = this.opts.mcp;
    if (!m) return {};
    return {
      PITH_MCP_COMMAND: m.command,
      PITH_MCP_ARGS: JSON.stringify(m.args),
      ...(m.env && Object.keys(m.env).length > 0 ? { PITH_MCP_ENV: JSON.stringify(m.env) } : {}),
    };
  }

  /** 组装本轮 argv。抽出来便于测试（不 spawn 也能断言 flag 组合）。 */
  buildArgs(prompt: string): string[] {
    const args = ['--mode', 'json'];
    if (this.opts.sessionDir) args.push('--session-dir', this.opts.sessionDir);
    if (this.piSessionId) args.push('--session', this.piSessionId);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.apiKey) args.push('--api-key', this.opts.apiKey);
    if (this.opts.systemPrompt.trim()) {
      args.push('--append-system-prompt', this.opts.systemPrompt.trim());
    }
    // 只加载 pith 的桥接扩展；不吃用户全局扩展 / project-local 资源 / 上下文文件。
    if (this.opts.bridgePath) args.push('--no-extensions', '-e', this.opts.bridgePath);
    else args.push('--no-extensions');
    args.push('-na', '-nc');
    args.push(prompt);
    return args;
  }

  async send(
    text: string,
    opts: {
      signal?: AbortSignal;
      // scope 不参与 pi 检索（它经桥接的 wiki_* 工具自查库），保留以满足 AgentLike。
      scope?: ScopeDTO;
      events?: StreamEvents;
    } = {},
  ): Promise<string> {
    this.history.push({ role: 'user', content: text });

    const args = this.buildArgs(text);
    console.log(
      `[pith/pi] spawn ${this.opts.binary} --mode json ${this.piSessionId ? `(session ${this.piSessionId})` : '(new session)'} ` +
        `model=${this.opts.model || '(default)'} bridge=${this.opts.bridgePath ? 'on' : 'off'} ` +
        `mcp=${this.opts.mcp ? 'on' : 'off'} apiKey=${this.opts.apiKey ? 'set' : 'unset(subscription)'}`,
    );
    const child = spawn(this.opts.binary, args, {
      env: { ...this.opts.env, ...this.bridgeEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });

    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort);

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });

    let parsed: StreamResult;
    try {
      child.stdout.setEncoding('utf8');
      parsed = await parsePiStream(splitJsonLines(child.stdout), opts.events);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await new Promise<number>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.on('close', (code) => resolve(code ?? 0));
    });

    if (parsed.sessionId) this.piSessionId = parsed.sessionId;

    if (parsed.isError || (exitCode !== 0 && !parsed.finalText)) {
      throw new Error(
        parsed.errorMessage || parsed.finalText || stderr.trim() || `pi exited ${exitCode}`,
      );
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
    this.piSessionId = null; // pi 侧 session 不随 pith 历史持久化
  }

  reset(): void {
    this.history = [];
    this.piSessionId = null;
  }

  snapshot(): string {
    return this.history
      .filter((m) => m.role !== 'system')
      .map((m) => `**${m.role}**: ${m.content}`)
      .join('\n\n');
  }
}
