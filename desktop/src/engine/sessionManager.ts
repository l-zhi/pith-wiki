import path from 'node:path';
import type {
  DisplayItem,
  EngineEvent,
  EntryRefDTO,
  ScopeDTO,
  SessionMeta,
} from '../shared/protocol.js';
import type { RunOrigin } from '@core/tools/index.js';
import type { SessionStore } from './sessionStore.js';

/**
 * SessionManager —— 会话生命周期（深模块）。
 *
 * 职责（ADR-0006）：
 *   - 每会话一个 Agent 实例：独立历史 / 工具队列 / AbortController，多会话并行。
 *   - 持久化：每轮结束把 agent 导出历史的增量 append 进 SessionStore；
 *     安全阻断回滚（历史变短）时整文件重写。
 *   - 审批路由：工具层的审批请求 → approvalId 标记的事件，answer 按 id 回执；
 *     审批记忆在 Agent 的 ToolContext 里（会话级），重启/恢复后自然清空。
 *   - 恢复：load 历史 → 新 Agent.restoreHistory → 派生 DisplayItem 回放给 UI。
 *
 * Agent 通过 AgentFactory 注入（engine 入口闭包真实依赖；测试给 fake），
 * 本模块不 import LLM / Electron。
 */

export interface AgentLike {
  send(
    text: string,
    opts: {
      signal?: AbortSignal;
      scope?: { collections: string[]; entryIds: string[] };
      events?: {
        onThinking?: (e: { text: string; source: string }) => void;
        onAssistantText?: (e: { text: string; final: boolean }) => void;
        onToolRound?: (e: { name: string; args: unknown; ok: boolean; preview: string }) => void;
        onUsage?: (d: { inputTokens: number; outputTokens: number }) => void;
      };
    },
  ): Promise<string>;
  exportHistory(): unknown[];
  restoreHistory(messages: unknown[]): void;
  reset?(): void;
  snapshot?(): string;
}

export interface ApprovalBridge {
  /** SessionManager 提供给 AgentFactory 的审批通道（工具层回调 → UI 事件）。 */
  request(kind: 'write' | 'exec', path: string, preview: string): Promise<'yes' | 'no' | 'always'>;
}

export interface MadeAgent {
  agent: AgentLike;
  model: string;
  provider?: string;
}

export type AgentFactory = (
  sessionId: string,
  approvals: ApprovalBridge,
  origin: RunOrigin,
  reviewMode: boolean,
) => MadeAgent;

interface Live {
  agent: AgentLike;
  meta: { id: string; title: string; createdAt: string; model: string; provider?: string; reviewMode?: boolean };
  busy: boolean;
  abort: AbortController | null;
  pendingApproval: {
    id: string;
    resolve: (a: 'yes' | 'no' | 'always') => void;
  } | null;
  persistedLen: number;
}

const NEW_TITLE = 'New chat';

/** 定时任务单轮的整体超时兜底（含多轮工具调用）。超时 → abort，记 failed，绝不永久挂起。 */
const SCHEDULED_TURN_TIMEOUT_MS = 10 * 60 * 1000;

export class SessionManager {
  private live = new Map<string, Live>();
  private approvalSeq = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly makeAgent: AgentFactory,
    private readonly emit: (evt: EngineEvent) => void,
    /** agent 写文件的落点根目录（<wikiRoot>/output）——用于把 write_file 的相对路径还原成绝对路径。 */
    private readonly outputDir: string = '',
  ) {}

  /* ───────────── 查询 ───────────── */

  list(): SessionMeta[] {
    const stored = this.store.list();
    const seen = new Set<string>();
    const out: SessionMeta[] = [];
    for (const s of stored) {
      seen.add(s.id);
      const l = this.live.get(s.id);
      out.push({
        id: s.id,
        title: l?.meta.title ?? s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        model: s.model,
        provider: s.provider,
        msgCount: s.msgCount,
        busy: l?.busy ?? false,
        pendingApprovalId: l?.pendingApproval?.id,
        reviewMode: (l?.meta.reviewMode ?? s.reviewMode) === true,
      });
    }
    // 刚创建、还没有任何消息落盘的 live 会话也要出现在列表里
    for (const [id, l] of this.live) {
      if (seen.has(id)) continue;
      out.unshift({
        id,
        title: l.meta.title,
        createdAt: l.meta.createdAt,
        updatedAt: l.meta.createdAt,
        model: l.meta.model,
        provider: l.meta.provider,
        msgCount: 0,
        busy: l.busy,
        pendingApprovalId: l.pendingApproval?.id,
        reviewMode: l.meta.reviewMode === true,
      });
    }
    return out;
  }

  /* ───────────── 生命周期 ───────────── */

  create(
    provider?: string,
    opts: { autoApprove?: boolean; origin?: RunOrigin; reviewMode?: boolean } = {},
  ): SessionMeta {
    const id = this.store.newId();
    const createdAt = new Date().toISOString();
    const reviewMode = opts.reviewMode === true;
    const made = this.makeAgent(
      id,
      this.approvalBridge(id, opts.autoApprove),
      opts.origin ?? 'interactive',
      reviewMode,
    );
    const meta = {
      id,
      title: NEW_TITLE,
      createdAt,
      model: made.model,
      provider: made.provider ?? provider,
      ...(reviewMode ? { reviewMode: true } : {}),
    };
    this.store.create(meta);
    this.live.set(id, {
      agent: made.agent,
      meta,
      busy: false,
      abort: null,
      pendingApproval: null,
      persistedLen: made.agent.exportHistory().length,
    });
    return { ...meta, updatedAt: createdAt, msgCount: 0, busy: false, reviewMode };
  }

  /** 恢复（或返回已 live 的）会话；返回 UI 回放序列。不存在时抛错。 */
  resume(sessionId: string): { meta: SessionMeta; display: DisplayItem[] } {
    const existing = this.live.get(sessionId);
    const stored = this.store.load(sessionId);
    if (!existing && !stored) throw new Error(`session not found: ${sessionId}`);

    if (!existing) {
      // 恢复历史会话 = 用户在 UI 打开继续 → interactive（即便原是定时任务跑出来的）
      const reviewMode = stored!.meta.reviewMode === true;
      const made = this.makeAgent(
        sessionId,
        this.approvalBridge(sessionId),
        'interactive',
        reviewMode,
      );
      made.agent.restoreHistory(stored!.messages);
      this.live.set(sessionId, {
        agent: made.agent,
        meta: { ...stored!.meta },
        busy: false,
        abort: null,
        pendingApproval: null,
        persistedLen: made.agent.exportHistory().length,
      });
    }
    const l = this.live.get(sessionId)!;
    const display = deriveDisplay(stored?.messages ?? l.agent.exportHistory());
    return {
      meta: {
        ...l.meta,
        updatedAt: new Date().toISOString(),
        msgCount: display.length,
        busy: l.busy,
        pendingApprovalId: l.pendingApproval?.id,
        reviewMode: l.meta.reviewMode === true,
      },
      display,
    };
  }

  /** 重命名会话：live meta 与落盘 meta 同步更新。空标题拒绝。 */
  rename(sessionId: string, title: string): void {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 64);
    if (!clean) throw new Error('title must not be empty');
    const l = this.live.get(sessionId);
    if (l) l.meta.title = clean;
    this.store.updateMeta(sessionId, { title: clean });
  }

  delete(sessionId: string): boolean {
    const l = this.live.get(sessionId);
    if (l) {
      if (l.busy) this.abort(sessionId);
      this.live.delete(sessionId);
    }
    return this.store.delete(sessionId);
  }

  /**
   * 切换会话的审稿模式:重建该会话的 live agent(包/拆 ReviewingAgent),
   * 用 export→restore 迁移当前对话历史,持久化到 meta。busy 时拒绝。
   * 干净历史契约让两种 agent 互转不丢对话(见 ReviewingAgent)。
   */
  setReviewMode(sessionId: string, on: boolean): SessionMeta {
    const l = this.live.get(sessionId) ?? this.resumeLive(sessionId);
    if (l.busy) throw new Error('session is busy — wait for the current turn to finish');
    if ((l.meta.reviewMode === true) === on) {
      return this.metaOf(sessionId, l); // 无变化
    }
    const history = l.agent.exportHistory();
    const made = this.makeAgent(sessionId, this.approvalBridge(sessionId), 'interactive', on);
    made.agent.restoreHistory(history);
    l.agent = made.agent;
    l.meta.model = made.model;
    if (made.provider) l.meta.provider = made.provider;
    l.meta.reviewMode = on ? true : undefined;
    l.persistedLen = made.agent.exportHistory().length;
    this.store.updateMeta(sessionId, { reviewMode: on ? true : undefined });
    return this.metaOf(sessionId, l);
  }

  private metaOf(sessionId: string, l: Live): SessionMeta {
    const stored = this.store.list().find((s) => s.id === sessionId);
    return {
      id: sessionId,
      title: l.meta.title,
      createdAt: l.meta.createdAt,
      updatedAt: stored?.updatedAt ?? l.meta.createdAt,
      model: l.meta.model,
      provider: l.meta.provider,
      msgCount: stored?.msgCount ?? 0,
      busy: l.busy,
      pendingApprovalId: l.pendingApproval?.id,
      reviewMode: l.meta.reviewMode === true,
    };
  }

  /* ───────────── 执行 ───────────── */

  /**
   * 解析一轮对话；事件全程经 emit 流出。同会话并发 send 直接拒绝。
   * 返回本轮的错误（若有）——回合内的失败被 send 内部吞掉转成 turnDone 事件，
   * 这里把它一并回传，供定时任务等非交互调用方判定 run 状态。
   */
  async send(sessionId: string, text: string, scope?: ScopeDTO): Promise<{ error?: string }> {
    const l = this.live.get(sessionId) ?? this.resumeLive(sessionId);
    if (l.busy) throw new Error('session is busy — wait for the current turn to finish');

    if (l.meta.title === NEW_TITLE) {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 48) || NEW_TITLE;
      l.meta.title = title;
      try {
        this.store.updateMeta(sessionId, { title });
      } catch {
        /* 标题落盘失败不阻塞对话 */
      }
    }

    l.busy = true;
    l.abort = new AbortController();
    this.emit({ kind: 'session.busy', sessionId, busy: true });
    let turnError: string | undefined;
    const seenArtifacts = new Set<string>(); // 本回合已上报的产物路径，去重（Write 后又 Edit 同一文件只发一张卡）
    try {
      await l.agent.send(text, {
        signal: l.abort.signal,
        scope: scope && (scope.collections.length || scope.entryIds.length) ? scope : undefined,
        events: {
          onThinking: ({ text }) => this.emit({ kind: 'session.thinking', sessionId, text }),
          onAssistantText: ({ text, final }) =>
            this.emit({ kind: 'session.assistantText', sessionId, text, final }),
          onToolRound: ({ name, args, ok, preview }) => {
            this.emit({
              kind: 'session.toolRound',
              sessionId,
              name,
              argsPreview: previewJson(args),
              ok,
              preview,
            });
            // agent 写出了文件 → 额外发一张可打开的文件卡片
            if (ok) {
              const abs = artifactPath(name, args, this.outputDir);
              if (abs && !seenArtifacts.has(abs)) {
                seenArtifacts.add(abs);
                this.emit({ kind: 'session.artifact', sessionId, path: abs, name: path.basename(abs) });
              }
            }
          },
          onUsage: (d) =>
            this.emit({
              kind: 'session.usage',
              sessionId,
              inputTokens: d.inputTokens,
              outputTokens: d.outputTokens,
            }),
        },
      });
    } catch (err) {
      const e = err as Error;
      turnError = e.name === 'AbortError' ? 'cancelled' : e.message;
    } finally {
      // 未决审批随轮次终止：默认拒绝，避免悬挂的 resolve 泄漏
      if (l.pendingApproval) {
        l.pendingApproval.resolve('no');
        l.pendingApproval = null;
      }
      l.busy = false;
      l.abort = null;
      // 本回合 wiki 检索引用到 / 浏览过的条目（取本轮新增消息里 tool 结果）→ 挂到末条助手消息
      const history = l.agent.exportHistory();
      const { cited, browsed } = extractWikiRefs(history.slice(l.persistedLen));
      this.persist(sessionId, l);
      if (cited.length || browsed.length)
        this.emit({ kind: 'session.refs', sessionId, refs: cited, browsed });
      this.emit({ kind: 'session.busy', sessionId, busy: false });
      this.emit({ kind: 'session.turnDone', sessionId, error: turnError });
    }
    return { error: turnError };
  }

  /**
   * 定时任务用：新开一个会话、跑一轮、返回结构化结果（不抛）。
   * 事件照常 emit（若该 session 未在 UI 打开则无人显示，但运行已落盘可事后回看）。
   *
   * 关键：用 autoApprove 会话——无人值守时交互式审批会永久卡死那一轮（曾导致定时任务
   * 转圈不结束）。再加一个整轮超时兜底，任何无超时的工具/LLM 挂起都不会让任务永久挂着。
   */
  async runScheduled(
    input: string,
    title: string,
    opts: { requireApproval?: boolean; review?: boolean } = {},
  ): Promise<{ sessionId: string; status: 'ok' | 'failed'; preview?: string; error?: string }> {
    // 默认自动放行；requireApproval 的任务沿用交互式审批（有人批才过，否则整轮超时记 failed）
    // review=true → 会话以审稿模式跑（writer→reviewer→修订），日报等自动写作先过审再定稿。
    const meta = this.create(undefined, {
      autoApprove: !opts.requireApproval,
      origin: 'scheduled',
      reviewMode: opts.review,
    });
    try {
      this.rename(meta.id, title);
    } catch {
      /* 标题非法不阻塞执行 */
    }
    const timer = setTimeout(() => this.abort(meta.id), SCHEDULED_TURN_TIMEOUT_MS);
    let error: string | undefined;
    try {
      ({ error } = await this.send(meta.id, input));
    } finally {
      clearTimeout(timer);
    }
    const preview = lastAssistantText(this.live.get(meta.id)?.agent.exportHistory() ?? []);
    return {
      sessionId: meta.id,
      status: error ? 'failed' : 'ok',
      preview: preview ? preview.slice(0, 280) : undefined,
      error,
    };
  }

  abort(sessionId: string): void {
    const l = this.live.get(sessionId);
    l?.abort?.abort();
  }

  /** /reset：清空 agent 历史并截断落盘文件（标题保留）。busy 时拒绝。 */
  reset(sessionId: string): void {
    const l = this.live.get(sessionId) ?? this.resumeLive(sessionId);
    if (l.busy) throw new Error('session is busy');
    l.agent.reset?.();
    l.persistedLen = l.agent.exportHistory().length;
    this.store.create({ ...l.meta });
  }

  /** /digest 用：当前会话的对话快照（无内容时 null）。 */
  snapshot(sessionId: string): string | null {
    const l = this.live.get(sessionId) ?? this.resumeLive(sessionId);
    const snap = l.agent.snapshot?.();
    return snap && snap.trim().length > 0 ? snap : null;
  }

  answerApproval(approvalId: string, answer: 'yes' | 'no' | 'always'): void {
    for (const [sessionId, l] of this.live) {
      if (l.pendingApproval?.id === approvalId) {
        const { resolve } = l.pendingApproval;
        l.pendingApproval = null;
        this.emit({ kind: 'session.approvalSettled', sessionId, approvalId, answer });
        resolve(answer);
        return;
      }
    }
    throw new Error(`no pending approval with id ${approvalId}`);
  }

  /* ───────────── internals ───────────── */

  private resumeLive(sessionId: string): Live {
    this.resume(sessionId);
    return this.live.get(sessionId)!;
  }

  private approvalBridge(sessionId: string, autoApprove = false): ApprovalBridge {
    // 定时任务等无人值守的会话：没有人在触发时刻回答审批，交互式审批会让那一轮
    // 永久卡死（await 一个永不 resolve 的 Promise）。这类会话改为自动放行——
    // 任务是用户亲手排的（standing consent），写入受 wikiRoot/workspace 沙箱约束，
    // 可执行的二进制也已在 skill 安装时进白名单。
    if (autoApprove) {
      return { request: async () => 'always' as const };
    }
    return {
      request: (kind, path, preview) =>
        new Promise((resolve) => {
          const l = this.live.get(sessionId);
          const id = `ap${++this.approvalSeq}`;
          if (!l) {
            resolve('no');
            return;
          }
          l.pendingApproval = { id, resolve };
          this.emit({
            kind: 'session.approvalRequest',
            sessionId,
            approvalId: id,
            approvalKind: kind,
            path,
            preview,
          });
        }),
    };
  }

  /** 增量 append；历史回滚（SecurityBlock 等）导致变短时整文件重写。 */
  private persist(sessionId: string, l: Live): void {
    try {
      const history = l.agent.exportHistory();
      if (history.length >= l.persistedLen) {
        this.store.appendMessages(sessionId, history.slice(l.persistedLen));
      } else {
        // 回滚路径：meta 不变，消息整体重写
        const meta = this.store.load(sessionId)?.meta ?? l.meta;
        this.store.create(meta);
        this.store.appendMessages(sessionId, history.filter(isPersistable));
      }
      l.persistedLen = history.length;
    } catch (err) {
      this.emit({
        kind: 'engine.notice',
        level: 'warning',
        text: `session persist failed: ${(err as Error).message}`,
      });
    }
  }
}

function isPersistable(m: unknown): boolean {
  return typeof m === 'object' && m !== null;
}

/** 取历史里最后一条非空 assistant 文本（定时任务 run 预览用）。 */
function lastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return undefined;
}

function previewJson(v: unknown, max = 120): string {
  const json = JSON.stringify(v) ?? '';
  return json.length > max ? json.slice(0, max) + '…' : json;
}

/**
 * 从一次写文件的工具调用里解析出产物的绝对路径，用于生成"文件卡片"。
 * 支持两种 provider 的写工具：
 *   - core `write_file`：入参 `path` 是相对 outputDir 的路径（也可能已是绝对路径）
 *   - claude-code `Write` / `Edit`：入参 `file_path` 已是绝对路径
 * 非写工具、拿不到路径、或相对路径但 outputDir 未知 → 返回 null（不发卡片）。
 */
export function artifactPath(name: string, args: unknown, outputDir: string): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  let raw: string | undefined;
  if (name === 'write_file' && typeof a.path === 'string') raw = a.path;
  else if ((name === 'Write' || name === 'Edit') && typeof a.file_path === 'string')
    raw = a.file_path;
  if (!raw || !raw.trim()) return null;
  if (path.isAbsolute(raw)) return raw;
  return outputDir ? path.join(outputDir, raw) : null;
}

/** 把持久化的 ChatMessage 序列派生成 UI 回放条目。system 消息不回放。 */
export function deriveDisplay(messages: unknown[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  const toolNames = toolNameByCallId(messages); // 用于 refs 收集区分工具（排除 wiki_list 浏览）
  // tool 结果按 tool_call_id 归位
  const toolResults = new Map<string, string>();
  for (const m of messages) {
    const msg = m as Record<string, unknown>;
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      toolResults.set(
        msg.tool_call_id,
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      );
    }
  }
  // 当前回合累积的引用 / 浏览，遇 user 重置
  let turnCited = new Map<string, EntryRefDTO>();
  let turnBrowsed = new Map<string, EntryRefDTO>();
  for (const m of messages) {
    const msg = m as Record<string, unknown>;
    if (msg.role === 'user' && typeof msg.content === 'string') {
      out.push({ role: 'user', text: msg.content });
      turnCited = new Map();
      turnBrowsed = new Map();
    } else if (msg.role === 'tool') {
      collectRefs(turnCited, turnBrowsed, msg, toolNames.get(msg.tool_call_id as string));
    } else if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.trim()) {
        const refs = [...turnCited.values()];
        const browsed = [...turnBrowsed.values()].filter((b) => !turnCited.has(b.id));
        const item: DisplayItem = { role: 'assistant', text: content };
        if (refs.length) item.refs = refs;
        if (browsed.length) item.browsed = browsed;
        out.push(item);
      }
      const calls = msg.tool_calls as
        | { id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const result = c.id ? (toolResults.get(c.id) ?? '') : '';
          out.push({
            role: 'tool',
            name: c.function?.name ?? 'tool',
            argsPreview: truncate(c.function?.arguments ?? '', 120),
            resultPreview: truncate(result, 200),
          });
        }
      }
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** tool_call_id → 工具名（从 assistant 消息的 tool_calls 还原），供 refs 收集按工具区分。 */
function toolNameByCallId(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    const o = m as Record<string, unknown>;
    if (o.role !== 'assistant') continue;
    const calls = o.tool_calls as { id?: string; function?: { name?: string } }[] | undefined;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) if (c.id && c.function?.name) map.set(c.id, c.function.name);
  }
  return map;
}

export interface WikiRefs {
  /** 真正取用的来源：wiki_get / wiki_read_source / wiki_query.references / wiki_grep.items。 */
  cited: EntryRefDTO[];
  /** 仅用 wiki_list「翻菜单」浏览过的候选目录（未被引用的那些）。 */
  browsed: EntryRefDTO[];
}

/** 「批量扫候选」型工具：返回的是搜到/翻到的一大批候选，不是真正取用的来源 → 归入 browsed。 */
const BROWSE_TOOLS = new Set(['wiki_list', 'wiki_grep']);

/**
 * 从单条 tool 结果消息收集 wiki 条目，按产生结果的工具分流到 cited / browsed：
 *   - browsed（「翻到/搜到的候选」）：
 *       · wiki_list —— 按元数据浏览，单次可达 500 条
 *       · wiki_grep —— 精确搜索，命中可达几十上百条（这就是之前「引用」被撑到 51 的元凶）
 *   - cited（真正取用）：wiki_query.references（打分检索，top-5 + 1 跳，量小有意）/
 *       wiki_get.entry / wiki_read_source（按 id 取了某条全文）
 * 仅 ok:true 的结果。这样「引用」反映 agent 真正定向取用的来源，「浏览」是它扫过的候选面。
 */
function collectRefs(
  cited: Map<string, EntryRefDTO>,
  browsed: Map<string, EntryRefDTO>,
  msg: Record<string, unknown>,
  toolName?: string,
): void {
  if (msg.role !== 'tool') return;
  const raw = typeof msg.content === 'string' ? msg.content : '';
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!v || typeof v !== 'object' || v.ok !== true) return;
  const target = toolName && BROWSE_TOOLS.has(toolName) ? browsed : cited;
  const add = (e: unknown) => {
    const o = e as Record<string, unknown> | null;
    if (o && typeof o.id === 'string' && typeof o.title === 'string' && !target.has(o.id)) {
      target.set(o.id, {
        id: o.id,
        title: o.title,
        collection: typeof o.collection === 'string' ? o.collection : undefined,
      });
    }
  };
  if (Array.isArray(v.references)) (v.references as unknown[]).forEach(add);
  if (v.entry) add(v.entry);
  if (Array.isArray(v.items)) (v.items as unknown[]).forEach(add);
  if (typeof v.id === 'string' && typeof v.title === 'string') add(v);
}

/** 一段消息序列里 wiki 检索引用到 / 浏览过的条目（去重；引用的不再算浏览）。 */
export function extractWikiRefs(messages: unknown[]): WikiRefs {
  const cited = new Map<string, EntryRefDTO>();
  const browsed = new Map<string, EntryRefDTO>();
  const names = toolNameByCallId(messages);
  for (const m of messages) {
    const callId = (m as Record<string, unknown>).tool_call_id;
    collectRefs(cited, browsed, m as Record<string, unknown>, names.get(callId as string));
  }
  for (const id of cited.keys()) browsed.delete(id); // 被引用的不重复算作浏览
  return { cited: [...cited.values()], browsed: [...browsed.values()] };
}
