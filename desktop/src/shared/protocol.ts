/**
 * EngineBridge —— renderer ↔ main ↔ Engine 三进程共享的类型化消息协议。
 *
 * 设计（ADR-0006）：
 *   - 事件流：Engine → renderer，全部带 sessionId（会话路由）或归类 engine.*。
 *   - 请求-响应：renderer → Engine，带自增 correlation id；审批是 Engine 发起的
 *     "反向请求"，建模为 approvalRequest 事件 + approval.answer 请求，approvalId
 *     就是它的 correlation id。
 *   - main 进程是哑管道：原样转发 envelope，不解析 payload。
 *
 * 本模块零 Electron / Node 依赖（纯数据 + 分发逻辑），renderer / engine / 测试
 * 共用同一份实现。传输层抽象成 { post, onMessage } 一对函数。
 */

/* ───────────────────────── 领域 DTO ───────────────────────── */

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider?: string;
  msgCount: number;
  /** 有未处理审批时为该审批 id（会话列表角标用）。 */
  pendingApprovalId?: string;
  busy?: boolean;
}

/** 助手回答引用到的 wiki 条目（来自该回合 wiki 检索工具的返回）。 */
export interface EntryRefDTO {
  id: string;
  title: string;
  collection?: string;
}

/** 会话恢复时回放给 UI 的展示条目（由持久化的 ChatMessage 派生）。 */
export type DisplayItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; refs?: EntryRefDTO[]; browsed?: EntryRefDTO[] }
  | { role: 'tool'; name: string; argsPreview: string; resultPreview: string };

export interface ScopeDTO {
  collections: string[];
  entryIds: string[];
}

export interface CollectionInfo {
  id: string;
  count: number;
  watch: boolean;
  /** 是否为生成产物 collection（= config.digestCollection，默认 output）——侧边栏据此特殊标记。 */
  output: boolean;
}

export interface EntrySummary {
  id: string;
  collection: string;
  title: string;
  summary: string;
  tags: string[];
  sourceType: string;
  updated: string;
}

export interface EntryDetail extends EntrySummary {
  content: string;
  links: string[];
  backlinks: string[];
  sourceValue?: string;
  compressionRatio?: number;
  raw: string;
}

export interface QueueJobDTO {
  id: string;
  collection: string;
  file: string;
  status: 'pending' | 'running' | 'completed' | 'dead';
  error?: string;
  attempts?: number;
}

export interface QueueDigestDTO {
  counts: { pending: number; running: number; completed: number; dead: number };
  dead: QueueJobDTO[];
  workerMode: 'self' | 'external' | 'off' | 'error';
  workerError?: string;
}

export interface DashboardRowDTO {
  name: string;
  files: number;
  pending: number;
  running: number;
  done: number;
  dead: number;
  watch: boolean;
  danger: boolean;
}

export interface DashboardDTO {
  wikiRoot: string;
  provider: string;
  model: string;
  ready: boolean;
  collections: DashboardRowDTO[];
  watchDirs: { path: string; collection: string; count: number; error?: string }[];
  extensions: string[];
}

/* ───── Settings（设置界面，按设计稿三段） ───── */

export interface ProviderDTO {
  name: string;
  baseURL: string;
  model: string;
  supportsJsonMode: boolean;
  /** key 形态：literal=字面值（掩码展示）/ env=引用环境变量 / none=未配置 */
  keySource: 'literal' | 'env' | 'none';
  /** literal 时的掩码（sk-…末4位）；不回传明文 */
  keyMasked?: string;
  /** env 时的变量名 */
  keyEnvVar?: string;
  /** key 当前是否能解析出非空值 */
  keyResolved: boolean;
}

export interface WatchDirDTO {
  path: string;
  collectionFromSubdir: boolean;
  initialScan: boolean;
}

export interface SettingsDTO {
  activeProvider: string;
  providers: ProviderDTO[];
  watchDirs: WatchDirDTO[];
  /** 只读展示：当前读白名单（watch 目录自动联动 + 用户手加的） */
  additionalReadPaths: string[];
  readOnly: boolean;
  configPath: string;
}

/** 保存载荷。providers 缺席 = 删除；newApiKey 仅在用户输入了新 key 时携带。 */
export interface SettingsSaveDTO {
  activeProvider: string;
  providers: {
    name: string;
    baseURL: string;
    model: string;
    supportsJsonMode: boolean;
    newApiKey?: string;
  }[];
  watchDirs: WatchDirDTO[];
  readOnly: boolean;
}

/* ───── 关系图谱 ───── */

export interface GraphNodeDTO {
  id: string;
  collection: string;
  title: string;
  /** 度数（出+入），节点大小映射用 */
  degree: number;
}

export interface GraphDTO {
  nodes: GraphNodeDTO[];
  /** 仅保留两端都存在的边（悬空 forward link v1 丢弃） */
  edges: { source: string; target: string }[];
}

/* ───── 技能（Skill 管理页） ───── */

/** skill 声明的某个 auth_env，及其当前是否已在环境中配置。 */
export interface SkillEnvDTO {
  name: string;
  set: boolean;
}

/** skill 声明的某个依赖二进制（CLI 集成型用），及其当前是否在 PATH 上。 */
export interface SkillReqDTO {
  bin: string;
  install?: string;
  present: boolean;
}

export interface SkillCardDTO {
  name: string;
  description: string;
  /** registry 中已存在同名 skill = 已安装 */
  installed: boolean;
  /** 该 skill 声明的 http_allow[].auth_env（去重）及配置状态；非空时 UI 提供 appkey 配置 */
  requiredEnv: SkillEnvDTO[];
  /** 该 skill 声明的 requires（依赖 CLI）及在 PATH 上的检测状态；非空时 UI 显示依赖提示 */
  requires: SkillReqDTO[];
}

export interface SkillsDTO {
  skills: SkillCardDTO[];
}

/* ───── 定时任务（Schedule 视图） ───── */

export type ScheduleSpecDTO =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expr: string; tz: string };

export interface ScheduleRunDTO {
  runId: string;
  sessionId: string;
  firedAt: string;
  status: 'ok' | 'failed' | 'skipped' | 'catchUp';
  preview?: string;
  error?: string;
}

export interface ScheduledTaskDTO {
  id: string;
  title: string;
  input: string;
  schedule: ScheduleSpecDTO;
  enabled: boolean;
  catchUp: boolean;
  requireApproval: boolean;
  /** 下一次触发（ISO），无则 null（一次性已过 / cron 不可能触发）。 */
  nextFire: string | null;
  /** 未来一段窗口内的触发点（ISO，日历铺点用；cron 枚举 90 天内、封顶若干条）。 */
  upcomingFires: string[];
  runCount: number;
  runs: ScheduleRunDTO[];
}

/** 创建/更新载荷（bridge 是类型化 TS，可直接用联合，不过 zodToJsonSchema）。 */
export interface ScheduleSavePayload {
  input: string;
  title?: string;
  schedule: ScheduleSpecDTO;
  enabled: boolean;
  catchUp: boolean;
  requireApproval: boolean;
}

export interface BootstrapDTO {
  ready: boolean;
  needsOnboarding: boolean;
  provider: string;
  model: string;
  wikiRoot: string;
  workspaceRoot: string;
  version: string;
  providers: { name: string; model: string; hasKey: boolean }[];
}

/* ───────────────────────── 请求 / 事件 ───────────────────────── */

export type EngineRequest =
  | { kind: 'app.bootstrap' }
  | { kind: 'app.saveOnboarding'; provider: string; baseURL: string; model: string; apiKey: string }
  | { kind: 'session.create'; provider?: string }
  | { kind: 'session.list' }
  | { kind: 'session.resume'; sessionId: string }
  | { kind: 'session.rename'; sessionId: string; title: string }
  | { kind: 'session.delete'; sessionId: string }
  | { kind: 'session.send'; sessionId: string; text: string; scope?: ScopeDTO }
  | { kind: 'session.reset'; sessionId: string }
  | { kind: 'session.digest'; sessionId: string; collection?: string }
  | { kind: 'session.abort'; sessionId: string }
  | { kind: 'approval.answer'; approvalId: string; answer: 'yes' | 'no' | 'always' }
  | { kind: 'library.collections' }
  | { kind: 'library.entries'; collection: string }
  | { kind: 'library.entry'; id: string; collection?: string }
  | { kind: 'library.graph' }
  | { kind: 'queue.digest' }
  | { kind: 'queue.jobLog'; id: string }
  | { kind: 'queue.retryDead' }
  | { kind: 'queue.clearDead' }
  | { kind: 'dashboard.data' }
  | { kind: 'settings.get' }
  | { kind: 'settings.save'; payload: SettingsSaveDTO }
  | { kind: 'skills.list' }
  | { kind: 'skills.install'; name: string }
  | { kind: 'skills.remove'; name: string }
  | { kind: 'skills.setEnv'; key: string; value: string } // value 空串 = 清除
  | { kind: 'schedule.list' }
  | { kind: 'schedule.create'; payload: ScheduleSavePayload }
  | { kind: 'schedule.update'; id: string; payload: ScheduleSavePayload }
  | { kind: 'schedule.delete'; id: string }
  | { kind: 'schedule.runNow'; id: string };

export type EngineEvent =
  | { kind: 'session.thinking'; sessionId: string; text: string }
  | { kind: 'session.assistantText'; sessionId: string; text: string; final: boolean }
  | {
      kind: 'session.toolRound';
      sessionId: string;
      name: string;
      argsPreview: string;
      ok: boolean;
      preview: string;
    }
  | { kind: 'session.usage'; sessionId: string; inputTokens: number; outputTokens: number }
  | { kind: 'session.busy'; sessionId: string; busy: boolean }
  /** 回合结束：该回合 wiki 检索引用到（refs）/ 仅浏览过（browsed）的条目（去重），挂到最后一条助手消息上 */
  | { kind: 'session.refs'; sessionId: string; refs: EntryRefDTO[]; browsed?: EntryRefDTO[] }
  | { kind: 'session.turnDone'; sessionId: string; error?: string }
  | {
      kind: 'session.approvalRequest';
      sessionId: string;
      approvalId: string;
      approvalKind: 'write' | 'exec';
      path: string;
      preview: string;
    }
  | { kind: 'session.approvalSettled'; sessionId: string; approvalId: string; answer: string }
  | { kind: 'engine.notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'engine.ready' }
  /** 队列状态变化推送（Engine 内部 2s 比对一次，有变化才发）。带全量 digest，UI 免请求。 */
  | { kind: 'queue.update'; digest: QueueDigestDTO }
  /** 定时任务有变化（tick 触发 / run 完成 / CRUD）。UI 收到后重新拉 schedule.list。 */
  | { kind: 'schedule.update' };

/* ───────────────────────── envelope ───────────────────────── */

export type BridgeMessage =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'evt'; evt: EngineEvent };

export interface Transport {
  post(msg: BridgeMessage): void;
  onMessage(cb: (msg: BridgeMessage) => void): void;
}

/** 运行时结构校验（跨进程边界的消息不可信任形状）。 */
export function isBridgeMessage(v: unknown): v is BridgeMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.t === 'req') return typeof m.id === 'number' && typeof m.req === 'object' && m.req !== null;
  if (m.t === 'res') return typeof m.id === 'number' && typeof m.ok === 'boolean';
  if (m.t === 'evt') return typeof m.evt === 'object' && m.evt !== null;
  return false;
}

/* ───────────────────────── client（renderer 侧） ───────────────────────── */

export interface BridgeClient {
  request<T = unknown>(req: EngineRequest): Promise<T>;
  onEvent(cb: (evt: EngineEvent) => void): () => void;
}

export function makeBridgeClient(transport: Transport): BridgeClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(evt: EngineEvent) => void>();

  transport.onMessage((msg) => {
    if (!isBridgeMessage(msg)) return;
    if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return; // 迟到 / 重复响应：丢弃
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    } else if (msg.t === 'evt') {
      for (const cb of listeners) cb(msg.evt);
    }
  });

  return {
    request<T>(req: EngineRequest): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        transport.post({ t: 'req', id, req });
      });
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/* ───────────────────────── server（Engine 侧） ───────────────────────── */

export type RequestHandler = (req: EngineRequest) => Promise<unknown> | unknown;

export interface BridgeServer {
  /** Engine 主动推事件。 */
  emit(evt: EngineEvent): void;
}

/**
 * Engine 侧：注册统一的请求处理器；响应（含异常→error 字符串）自动回填
 * correlation id。未知消息形状直接忽略（不可信输入不抛）。
 */
export function makeBridgeServer(transport: Transport, handle: RequestHandler): BridgeServer {
  transport.onMessage((msg) => {
    if (!isBridgeMessage(msg) || msg.t !== 'req') return;
    void (async () => {
      try {
        const data = await handle(msg.req);
        transport.post({ t: 'res', id: msg.id, ok: true, data });
      } catch (err) {
        transport.post({ t: 'res', id: msg.id, ok: false, error: (err as Error).message });
      }
    })();
  });
  return {
    emit(evt) {
      transport.post({ t: 'evt', evt });
    },
  };
}

/** 测试/同进程用：互联的一对 transport。 */
export function makeTransportPair(): [Transport, Transport] {
  const aCbs: ((m: BridgeMessage) => void)[] = [];
  const bCbs: ((m: BridgeMessage) => void)[] = [];
  const a: Transport = {
    post: (m) => queueMicrotask(() => bCbs.forEach((cb) => cb(m))),
    onMessage: (cb) => aCbs.push(cb),
  };
  const b: Transport = {
    post: (m) => queueMicrotask(() => aCbs.forEach((cb) => cb(m))),
    onMessage: (cb) => bCbs.push(cb),
  };
  return [a, b];
}
