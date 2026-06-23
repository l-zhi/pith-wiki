/**
 * Engine —— pith 桌面端唯一的核心宿主进程（Electron utilityProcess，ADR-0006）。
 *
 * 装配（与 REPL App.tsx 的服务装配同源，去 Ink 化）：
 *   - 共享一份 LibraryService / ConverterRegistry / SkillRegistry / OpenAI client
 *   - SessionManager：每会话一个 Agent（独立 ToolContext → 会话级审批记忆）
 *   - Queue Worker + watcher 内置后台运行（锁被外部进程持有时降级 external）
 *   - 与 main 的通信：process.parentPort 上的 EngineBridge envelope
 *
 * Workspace 语义（全局单工作区）：启动时 chdir 到 ~/.pith-wiki，让 config 的
 * cwd 回退命中全局家目录；显式 env / config.json 设置仍然优先。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfigFromEnv, ensureWikiRoot, ensureQueueDirs, type Config } from '@core/config.js';
import { pithWikiHome } from '@core/paths.js';
import { createClient } from '@core/llm/client.js';
import { Agent, defaultSystemPrompt } from '@core/llm/agent.js';
import { composeSystemPrompt, loadSoul, type LoadedSoul } from '@core/llm/soul.js';
import { buildContext } from '@core/tools/index.js';
import { makeSkillTool } from '@core/tools/skill.js';
import { runCommandTool } from '@core/tools/run_command.js';
import { httpRequestTool } from '@core/tools/http_request.js';
import { scheduleTools } from '@core/tools/schedule.js';
import { ScheduleStore } from '@core/schedule/store.js';
import { ScheduleService } from '@core/schedule/service.js';
import { fireTimesBetween } from '@core/schedule/cron.js';
import { buildSkillRegistry, SkillRegistry, loadSkill, type Skill } from '@core/skills/index.js';
import {
  installSkillFromSource,
  removeSkillByName,
  checkRequirements,
} from '@core/skills/install.js';
import { listBundledSkills } from '@core/skills/bundled.js';
import { LibraryService } from '@core/wiki/library.js';
import { HydrationService } from '@core/wiki/hydration.js';
import { buildConverterPipeline } from '@core/wiki/converters/index.js';
import { QueueStore, QueueLockedError } from '@core/wiki/queue/store.js';
import { runQueue } from '@core/wiki/queue/runner.js';
import { runWatcher } from '@core/wiki/queue/watcher.js';
import { collectDashboardData } from '@core/cli/dashboardData.js';
import { clearDead, resetDead } from '@core/cli/queueOps.js';

import {
  makeBridgeServer,
  type BridgeMessage,
  type DashboardDTO,
  type EngineRequest,
  type EntryDetail,
  type EntrySummary,
  type GraphDTO,
  type ProviderDTO,
  type QueueDigestDTO,
  type ScheduledTaskDTO,
  type ScheduleSpecDTO,
  type SettingsDTO,
  type SettingsSaveDTO,
  type SkillCardDTO,
  type SkillEnvDTO,
  type SkillReqDTO,
  type SkillsDTO,
  type Transport,
} from '../shared/protocol.js';
import { SessionStore } from './sessionStore.js';
import { SessionManager, type AgentFactory } from './sessionManager.js';
import { Scheduler } from './scheduler.js';

const APP_VERSION = '0.1.0';

/* ───────────────────────── transport ───────────────────────── */

// Electron utilityProcess 子进程：process.parentPort 收发 main 转发的 envelope
const parentPort = (
  process as unknown as {
    parentPort: {
      on(ev: 'message', cb: (e: { data: unknown }) => void): void;
      postMessage(msg: unknown): void;
    };
  }
).parentPort;

const transport: Transport = {
  post: (msg) => parentPort.postMessage(msg),
  onMessage: (cb) => parentPort.on('message', (e) => cb(e.data as BridgeMessage)),
};

/* ───────────────────────── services ───────────────────────── */

interface Services {
  config: Config;
  client: ReturnType<typeof createClient>;
  library: LibraryService;
  converters: ReturnType<typeof buildConverterPipeline>;
  skillRegistry: SkillRegistry;
  soul: LoadedSoul;
  sessions: SessionManager;
  scheduleService: ScheduleService;
  scheduler: Scheduler;
  store: QueueStore;
  workerMode: 'self' | 'external' | 'off' | 'error';
  workerError?: string;
  stop: () => void;
}

let svc: Services | null = null;

function emitNotice(level: 'info' | 'warning' | 'error', text: string): void {
  bridge.emit({ kind: 'engine.notice', level, text });
}

async function initServices(): Promise<Services> {
  const home = pithWikiHome();
  fs.mkdirSync(home, { recursive: true });
  try {
    process.chdir(home); // 全局单工作区：cwd 回退 = ~/.pith-wiki
  } catch {
    /* chdir 失败保持原 cwd */
  }

  const config = loadConfigFromEnv();
  ensureWikiRoot(config);

  const client = createClient(config, {
    onSecurityNotice: (msg, kind) =>
      emitNotice(kind === 'warning' ? 'warning' : 'info', `🔒 ${msg}`),
  });
  const library = new LibraryService(config.wikiRoot, { ignoredDirs: [config.outputDir] });
  const converters = buildConverterPipeline({
    wikiRoot: config.wikiRoot,
    cacheConverted: config.cacheConverted,
  });
  const soul = loadSoul({ soulFile: config.soulFile, workspaceRoot: config.workspaceRoot });
  const skillRegistry = await buildSkillRegistry({
    skillDirs: config.skillDirs,
    onWarn: (m) => emitNotice('warning', `skill: ${m}`),
  });

  /* —— 队列 worker + watcher（同 REPL 装配） —— */
  const store = new QueueStore(config.queueStatePath);
  let workerMode: Services['workerMode'] = config.queueAutoStart ? 'self' : 'off';
  let workerError: string | undefined;
  const ac = new AbortController();
  let release: (() => void) | null = null;
  if (config.queueAutoStart) {
    ensureQueueDirs(config);
    try {
      release = store.acquireLock();
      const hydrator = new HydrationService(client, config.model, library, config.supportsJsonMode);
      void runQueue({
        store,
        hydrator,
        library,
        converterRegistry: converters.registry,
        cache: converters.cache,
        concurrency: config.queueConcurrency,
        maxAttempts: config.queueMaxAttempts,
        backoffMs: [5_000, 30_000, 120_000],
        logDir: config.queueLogDir,
        signal: ac.signal,
        log: () => {},
        idleBehavior: 'wait',
      }).catch((err: Error) => {
        emitNotice('error', `queue worker crashed: ${err.message}`);
      });
      if (config.watchAutoStart && config.watchDirs.length > 0) {
        void runWatcher({
          store,
          targets: config.watchDirs,
          safety: {
            workspaceRoot: config.workspaceRoot,
            wikiRoot: config.wikiRoot,
            maxPayloadBytes: config.maxToolPayloadBytes,
            readOnly: config.readOnly,
            additionalReadPaths: config.additionalReadPaths,
          },
          signal: ac.signal,
          extensions: converters.registry.extensions(),
          log: () => {},
        }).catch((err: Error) => emitNotice('error', `watcher failed: ${err.message}`));
      }
    } catch (err) {
      if (err instanceof QueueLockedError) {
        workerMode = 'external';
        emitNotice('info', `queue: external process holds the lock (pid=${err.lockingPid})`);
      } else {
        workerMode = 'error';
        workerError = (err as Error).message;
        emitNotice('error', `queue lock failed: ${workerError}`);
      }
    }
  }

  /* —— 定时任务（触发宿主 = 本 engine） —— */
  const scheduleService = new ScheduleService(new ScheduleStore(config.scheduleStatePath));

  /* —— SessionManager —— */
  const sessionStore = new SessionStore(path.join(home, 'sessions'));
  const agentFactory: AgentFactory = (_sessionId, approvals) => {
    const ctx = buildContext(
      config,
      client,
      (p, preview) => approvals.request('write', p, preview),
      library,
      {
        converterRegistry: converters.registry,
        converterCache: converters.cache,
        skillRegistry,
        scheduleService,
        requestCommandApproval: (cmd, argv) => approvals.request('exec', cmd, argv),
      },
    );
    const extraTools = skillRegistry.list().length > 0 ? [makeSkillTool(skillRegistry)] : [];
    if (skillRegistry.allowedCommands().size > 0) extraTools.push(runCommandTool);
    if (skillRegistry.allowedHosts().size > 0) extraTools.push(httpRequestTool);
    extraTools.push(...scheduleTools);
    const agent = new Agent(client, config.model, ctx, {
      systemPrompt: composeSystemPrompt(defaultSystemPrompt, soul),
      extraTools,
    });
    return { agent, model: config.model, provider: config.activeProvider || undefined };
  };
  const sessions = new SessionManager(sessionStore, agentFactory, (evt) => bridge.emit(evt));

  const scheduler = new Scheduler(
    scheduleService,
    sessions,
    (evt) => bridge.emit(evt),
    (msg) => emitNotice('warning', msg),
  );

  let digestTimer: ReturnType<typeof setInterval> | null = null;

  const services: Services = {
    config,
    client,
    library,
    converters,
    skillRegistry,
    soul,
    sessions,
    scheduleService,
    scheduler,
    store,
    workerMode,
    workerError,
    stop: () => {
      if (digestTimer) clearInterval(digestTimer);
      scheduler.stop();
      ac.abort();
      try {
        release?.();
      } catch {
        /* released by worker finally */
      }
      try {
        library.flushIndex();
      } catch {
        /* best effort */
      }
    },
  };

  // 队列变化推送：2s 比对一次 digest，变了才广播。替代 renderer 侧的盲轮询，
  // 也让侧边栏 Collections 能跟着后台水合实时长出来。
  let lastDigestJson = '';
  digestTimer = setInterval(() => {
    try {
      const digest = queueDigest(services);
      const json = JSON.stringify(digest.counts) + digest.dead.length;
      if (json !== lastDigestJson) {
        lastDigestJson = json;
        bridge.emit({ kind: 'queue.update', digest });
      }
    } catch {
      /* state.json 短暂不可读时跳过本拍 */
    }
  }, 2000);

  // 定时任务触发循环：启动即补跑一拍关机期间错过的触发，再进入 30s 周期。
  scheduler.start();

  return services;
}

/* ───────────────────────── request handlers ───────────────────────── */

function requireSvc(): Services {
  if (!svc) throw new Error('engine not initialized');
  return svc;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function entrySummary(e: {
  id: string;
  collection: string;
  title: string;
  summary: string;
  tags: string[];
  source: { type: string };
  updated: string;
}): EntrySummary {
  return {
    id: e.id,
    collection: e.collection,
    title: e.title,
    summary: e.summary,
    tags: e.tags,
    sourceType: e.source.type,
    updated: relTime(e.updated),
  };
}

function watchSet(config: Config): Set<string> {
  const out = new Set<string>();
  for (const wd of config.watchDirs) {
    if (wd.collection) out.add(wd.collection);
    if (wd.fallbackCollection) out.add(wd.fallbackCollection);
    if (wd.collectionFromSubdir) {
      try {
        for (const ent of fs.readdirSync(wd.path, { withFileTypes: true })) {
          if (ent.isDirectory() && !ent.name.startsWith('.'))
            out.add(wd.subdirAlias?.[ent.name] ?? ent.name);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function scheduleTaskToDTO(
  svc: ScheduleService,
  task: ReturnType<ScheduleService['list']>[number],
): ScheduledTaskDTO {
  const now = new Date();
  const next = svc.nextFire(task, now);
  let upcoming: string[] = [];
  if (task.enabled) {
    if (task.schedule.kind === 'once') {
      upcoming = next ? [next.toISOString()] : [];
    } else {
      const until = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      upcoming = fireTimesBetween(task.schedule.expr, now, until, 60).map((d) => d.toISOString());
    }
  }
  return {
    id: task.id,
    title: task.title ?? task.input.split('\n')[0].slice(0, 48),
    input: task.input,
    schedule: task.schedule as ScheduleSpecDTO,
    enabled: task.enabled,
    catchUp: task.catchUp,
    requireApproval: task.requireApproval,
    nextFire: next ? next.toISOString() : null,
    upcomingFires: upcoming,
    runCount: task.runs.length,
    runs: task.runs.slice().reverse(),
  };
}

function queueDigest(s: Services): QueueDigestDTO {
  const counts = { pending: 0, running: 0, completed: 0, dead: 0 };
  const dead: QueueDigestDTO['dead'] = [];
  try {
    const state = s.store.load();
    for (const job of Object.values(state.jobs)) {
      counts[job.status] += 1;
      if (job.status === 'dead') {
        dead.push({
          id: job.id,
          collection: job.collection,
          file: job.file,
          status: 'dead',
          error: job.lastError,
          attempts: job.attempts,
        });
      }
    }
  } catch {
    /* state.json 缺失/损坏 → 全零 */
  }
  return { counts, dead, workerMode: s.workerMode, workerError: s.workerError };
}

async function handle(req: EngineRequest): Promise<unknown> {
  switch (req.kind) {
    case 'app.bootstrap': {
      const s = requireSvc();
      const providers = Object.entries(s.config.providers ?? {}).map(([name, p]) => ({
        name,
        model: (p as { model?: string }).model ?? s.config.model,
        hasKey: Boolean(
          (p as { apiKey?: string; apiKeyEnv?: string }).apiKey ||
          process.env[(p as { apiKeyEnv?: string }).apiKeyEnv ?? ''],
        ),
      }));
      return {
        ready: s.config.apiKey.length > 0,
        needsOnboarding: s.config.apiKey.length === 0,
        provider: s.config.activeProvider || 'deepseek',
        model: s.config.model,
        wikiRoot: s.config.wikiRoot,
        workspaceRoot: s.config.workspaceRoot,
        version: APP_VERSION,
        providers,
      };
    }
    case 'app.saveOnboarding': {
      saveOnboarding(req.provider, req.baseURL, req.model, req.apiKey);
      // 全量重建（onboarding 发生在会话开始前，丢弃 live 状态无代价）
      svc?.stop();
      svc = await initServices();
      return { ok: true };
    }
    case 'session.create':
      return requireSvc().sessions.create(req.provider);
    case 'session.list':
      return requireSvc().sessions.list();
    case 'session.resume':
      return requireSvc().sessions.resume(req.sessionId);
    case 'session.rename':
      requireSvc().sessions.rename(req.sessionId, req.title);
      return { ok: true };
    case 'session.delete':
      return requireSvc().sessions.delete(req.sessionId);
    case 'session.send': {
      const s = requireSvc();
      s.sessions.send(req.sessionId, req.text, req.scope).catch((err: Error) => {
        emitNotice('warning', err.message);
      });
      return { accepted: true };
    }
    case 'session.abort':
      requireSvc().sessions.abort(req.sessionId);
      return { ok: true };
    case 'session.reset':
      requireSvc().sessions.reset(req.sessionId);
      return { ok: true };
    case 'session.digest': {
      const s = requireSvc();
      const snap = s.sessions.snapshot(req.sessionId);
      if (!snap) throw new Error('nothing to digest — the conversation is empty');
      const hydrator = new HydrationService(
        s.client,
        s.config.model,
        s.library,
        s.config.supportsJsonMode,
      );
      const entry = await hydrator.hydrate({
        rawContent: snap,
        collectionId: req.collection ?? s.config.digestCollection ?? 'output',
        autoLink: true,
        source: { type: 'inline' },
        mode: 'conversation',
      });
      const saved = s.library.put(entry);
      return { id: saved.id, collection: saved.collection, title: saved.title };
    }
    case 'approval.answer':
      requireSvc().sessions.answerApproval(req.approvalId, req.answer);
      return { ok: true };
    case 'library.collections': {
      const s = requireSvc();
      s.library.refreshIfStale(); // 捕捉 write_file 等绕过 put 的直接写盘（如定时任务写 output）
      const watch = watchSet(s.config);
      const byCol = new Map<string, number>();
      for (const e of s.library.list()) byCol.set(e.collection, (byCol.get(e.collection) ?? 0) + 1);
      return [...byCol.entries()]
        .map(([id, count]) => ({ id, count, watch: watch.has(id) }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    }
    case 'library.entries': {
      const s = requireSvc();
      s.library.refreshIfStale(); // 同上：点开 collection 时确保看到刚写入的新文件
      return s.library
        .list(req.collection)
        .sort((a, b) => (a.updated < b.updated ? 1 : -1))
        .map(entrySummary);
    }
    case 'library.entry': {
      const s = requireSvc();
      const e = s.library.get(req.id, req.collection);
      if (!e) throw new Error(`entry not found: ${req.id}`);
      const idx = s.library.linkIndex().get(e.id);
      const raw = [
        '---',
        `id: ${e.id}`,
        `collection: ${e.collection}`,
        `title: ${e.title}`,
        `tags: [${e.tags.join(', ')}]`,
        `links: [${e.links.join(', ')}]`,
        `source: ${e.source.type}${'value' in e.source && e.source.value ? ` (${e.source.value})` : ''}`,
        `updated: ${e.updated}`,
        '---',
        '',
        e.content,
      ].join('\n');
      const detail: EntryDetail = {
        ...entrySummary(e),
        updated: e.updated,
        content: e.content,
        links: e.links,
        backlinks: idx?.backward ?? [],
        sourceValue: 'value' in e.source ? (e.source.value as string | undefined) : undefined,
        compressionRatio: e.compressionRatio,
        raw,
      };
      return detail;
    }
    case 'library.graph': {
      // 全量链接图：linkIndex 已在内存（懒计算 + put/delete 失效），这里只做投影。
      // 悬空 forward link（指向不存在的条目）v1 丢弃——幽灵节点留 v2。
      const s = requireSvc();
      const entries = s.library.list();
      const idx = s.library.linkIndex();
      const known = new Set(entries.map((e) => e.id));
      const edges: GraphDTO['edges'] = [];
      for (const e of entries) {
        for (const target of e.links) {
          if (known.has(target)) edges.push({ source: e.id, target });
        }
      }
      const nodes: GraphDTO['nodes'] = entries.map((e) => {
        const li = idx.get(e.id);
        const degree =
          (li?.forward.filter((x) => known.has(x)).length ?? 0) + (li?.backward.length ?? 0);
        return { id: e.id, collection: e.collection, title: e.title, degree };
      });
      const dto: GraphDTO = { nodes, edges };
      return dto;
    }
    case 'queue.digest':
      return queueDigest(requireSvc());
    case 'queue.jobLog': {
      const s = requireSvc();
      if (!/^[A-Za-z0-9_-]+$/.test(req.id)) throw new Error('invalid job id');
      const logPath = path.join(s.config.queueLogDir, `${req.id}.log`);
      try {
        const raw = fs.readFileSync(logPath, 'utf8');
        // 只回尾部 16KB：日志可能含多轮重试，太长对排错无益
        const MAX = 16 * 1024;
        return { log: raw.length > MAX ? '…(truncated)\n' + raw.slice(-MAX) : raw, path: logPath };
      } catch {
        return { log: '(no log file for this job)', path: logPath };
      }
    }
    case 'queue.retryDead':
      return resetDead(requireSvc().store);
    case 'queue.clearDead':
      return clearDead(requireSvc().store);
    case 'settings.get':
      return settingsGet();
    case 'settings.save':
      return saveSettings(req.payload);
    case 'skills.list':
      return skillsList();
    case 'skills.install': {
      const s = requireSvc();
      installSkillFromSource(req.name, s.config); // 复制 bundled → skillDirs[0]
      await rebuildServices(); // 全量重建，让新 skill 的工具/catalog 生效
      return { ok: true };
    }
    case 'skills.remove': {
      const s = requireSvc();
      removeSkillByName(req.name, s.config);
      await rebuildServices();
      return { ok: true };
    }
    case 'schedule.list': {
      const s = requireSvc();
      return s.scheduleService.list().map((t) => scheduleTaskToDTO(s.scheduleService, t));
    }
    case 'schedule.create': {
      const s = requireSvc();
      const p = req.payload;
      const task = s.scheduleService.create({
        input: p.input,
        title: p.title,
        schedule: p.schedule,
        enabled: p.enabled,
        catchUp: p.catchUp,
        requireApproval: p.requireApproval,
      });
      bridge.emit({ kind: 'schedule.update' });
      return scheduleTaskToDTO(s.scheduleService, task);
    }
    case 'schedule.update': {
      const s = requireSvc();
      const p = req.payload;
      const task = s.scheduleService.update(req.id, {
        input: p.input,
        title: p.title,
        schedule: p.schedule,
        enabled: p.enabled,
        catchUp: p.catchUp,
        requireApproval: p.requireApproval,
      });
      bridge.emit({ kind: 'schedule.update' });
      return scheduleTaskToDTO(s.scheduleService, task);
    }
    case 'schedule.delete': {
      const s = requireSvc();
      const deleted = s.scheduleService.delete(req.id);
      bridge.emit({ kind: 'schedule.update' });
      return { ok: deleted };
    }
    case 'schedule.runNow': {
      const s = requireSvc();
      s.scheduler.runNow(req.id);
      return { ok: true };
    }
    case 'skills.setEnv':
      setSkillEnv(req.key, req.value);
      return { ok: true };
    case 'dashboard.data': {
      const s = requireSvc();
      const data = await collectDashboardData(s.config, s.converters.registry);
      const dto: DashboardDTO = {
        wikiRoot: data.wikiRoot,
        provider: data.provider,
        model: data.model,
        ready: data.ready,
        collections: data.collections,
        watchDirs: data.watchDirs,
        extensions: data.registeredExtensions,
      };
      return dto;
    }
    default:
      throw new Error(`unknown request: ${(req as { kind: string }).kind}`);
  }
}

/* ───────────────────────── settings ───────────────────────── */

function configFilePath(): string {
  return path.join(pithWikiHome(), 'config.json');
}

function readConfigFile(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function maskKey(key: string): string {
  if (key.length <= 7) return '•••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 设置界面的读取视图：来自 config.json 原文 + env 解析状态；key 永不回传明文。 */
function settingsGet(): SettingsDTO {
  const file = readConfigFile();
  const providersRaw =
    (file.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const providers: ProviderDTO[] = Object.entries(providersRaw).map(([name, p]) => {
    const literal =
      typeof p.apiKey === 'string' && p.apiKey.length > 0 ? (p.apiKey as string) : null;
    const envVar = typeof p.apiKeyEnv === 'string' ? (p.apiKeyEnv as string) : null;
    const envVal = envVar ? (process.env[envVar] ?? '') : '';
    return {
      name,
      baseURL: String(p.baseURL ?? ''),
      model: String(p.model ?? ''),
      supportsJsonMode: p.supportsJsonMode !== false,
      keySource: literal ? 'literal' : envVar ? 'env' : 'none',
      keyMasked: literal ? maskKey(literal) : undefined,
      keyEnvVar: envVar ?? undefined,
      keyResolved: Boolean(literal || envVal),
    };
  });
  const watchDirs = ((file.watchDirs as Record<string, unknown>[] | undefined) ?? []).map((w) => ({
    path: String(w.path ?? ''),
    collectionFromSubdir: w.collectionFromSubdir === true,
    initialScan: w.initialScan === true,
  }));
  return {
    activeProvider: String(file.activeProvider ?? ''),
    providers,
    watchDirs,
    additionalReadPaths: ((file.additionalReadPaths as string[] | undefined) ?? []).map(String),
    readOnly: file.readOnly === true,
    configPath: configFilePath(),
  };
}

/**
 * 保存设置：read-merge-write config.json（保留设置界面不管理的键），然后全量
 * 重建 Engine。事务语义：新配置 init 失败 → 回滚旧文件内容 + 用旧配置重建，
 * 把失败原因抛回 UI（界面内报错，不落成半坏状态）。
 */
async function saveSettings(payload: SettingsSaveDTO): Promise<{ ok: true }> {
  // —— 校验（落盘前） ——
  if (!payload.providers.length) throw new Error('at least one provider is required');
  const names = new Set(payload.providers.map((p) => p.name));
  if (!names.has(payload.activeProvider))
    throw new Error('activeProvider must be one of providers');
  for (const p of payload.providers) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(p.name)) throw new Error(`invalid provider name: ${p.name}`);
    try {
      new URL(p.baseURL);
    } catch {
      throw new Error(`invalid baseURL for ${p.name}: ${p.baseURL}`);
    }
    if (!p.model.trim()) throw new Error(`model is required for ${p.name}`);
  }
  for (const w of payload.watchDirs) {
    if (!path.isAbsolute(w.path)) throw new Error(`watch dir must be absolute: ${w.path}`);
  }

  const file = readConfigFile();
  const prevRaw = fs.existsSync(configFilePath())
    ? fs.readFileSync(configFilePath(), 'utf8')
    : null;

  // —— providers merge：从既有 entry 出发，保留 apiKeyEnv 等未管理字段 ——
  const oldProviders =
    (file.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const nextProviders: Record<string, Record<string, unknown>> = {};
  for (const p of payload.providers) {
    const base = { ...(oldProviders[p.name] ?? {}) };
    base.baseURL = p.baseURL;
    base.model = p.model;
    if (p.supportsJsonMode) delete base.supportsJsonMode;
    else base.supportsJsonMode = false;
    if (p.newApiKey && p.newApiKey.trim()) base.apiKey = p.newApiKey.trim();
    nextProviders[p.name] = base;
  }

  // —— watchDirs merge：按 path 保留旧 entry 的高级字段（subdirAlias/ignore…） ——
  const oldWatch = (file.watchDirs as Record<string, unknown>[] | undefined) ?? [];
  const oldByPath = new Map(oldWatch.map((w) => [String(w.path ?? ''), w]));
  const nextWatch = payload.watchDirs.map((w) => ({
    ...(oldByPath.get(w.path) ?? {}),
    path: w.path,
    collectionFromSubdir: w.collectionFromSubdir,
    initialScan: w.initialScan,
  }));

  // —— additionalReadPaths 联动：移除被删 watch 目录，并入新增 watch 目录 ——
  const oldWatchPaths = new Set(oldWatch.map((w) => String(w.path ?? '')));
  const newWatchPaths = new Set(payload.watchDirs.map((w) => w.path));
  const removedWatch = [...oldWatchPaths].filter((p) => !newWatchPaths.has(p));
  const extra = new Set(((file.additionalReadPaths as string[] | undefined) ?? []).map(String));
  for (const p of removedWatch) extra.delete(p);
  for (const p of newWatchPaths) extra.add(p);

  const next = {
    ...file,
    providers: nextProviders,
    activeProvider: payload.activeProvider,
    watchDirs: nextWatch,
    additionalReadPaths: [...extra],
    readOnly: payload.readOnly,
  };
  if (!payload.readOnly) delete (next as Record<string, unknown>).readOnly;

  // —— 落盘 + 事务化重建 ——
  fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
  fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  svc?.stop();
  svc = null;
  try {
    svc = await initServices();
  } catch (err) {
    // 回滚：恢复旧文件，用旧配置重建（尽力而为），错误抛回 UI
    if (prevRaw !== null) fs.writeFileSync(configFilePath(), prevRaw, 'utf8');
    else fs.rmSync(configFilePath(), { force: true });
    try {
      svc = await initServices();
    } catch {
      /* 旧配置也起不来：保持未初始化，UI 会看到 engine not initialized */
    }
    throw new Error(
      `settings rejected — engine failed to start with new config: ${(err as Error).message}`,
    );
  }
  bridge.emit({ kind: 'engine.ready' });
  return { ok: true };
}

/* ───────────────────────── skills（技能管理页） ───────────────────────── */

/** 安装/卸载 skill 后全量重建：让新 skill 的工具挂载与 catalog 在新会话生效。 */
async function rebuildServices(): Promise<void> {
  svc?.stop();
  svc = null;
  svc = await initServices();
  bridge.emit({ kind: 'engine.ready' });
}

/** 某 skill 声明的 auth_env 名（去重）及其在 process.env 中是否已配置。 */
function skillEnvStatus(sk: Skill): SkillEnvDTO[] {
  const names = [...new Set(sk.httpAllow.map((h) => h.auth_env).filter((e): e is string => !!e))];
  return names.map((name) => ({ name, set: Boolean(process.env[name]) }));
}

/** 某 skill 声明的 requires（依赖 CLI）及其在 PATH 上是否存在。 */
function skillReqStatus(sk: Skill): SkillReqDTO[] {
  const missing = new Set(checkRequirements(sk).map((r) => r.bin));
  return sk.requires.map((r) => ({ bin: r.bin, install: r.install, present: !missing.has(r.bin) }));
}

/** 技能页数据：策展的 bundled 建议清单 + 安装状态 + 所需 appkey 的配置状态。 */
function skillsList(): SkillsDTO {
  const s = requireSvc();
  const installed = new Set(s.skillRegistry.list().map((sk) => sk.name));
  const skills: SkillCardDTO[] = listBundledSkills().map((b) => {
    const isInstalled = installed.has(b.name);
    // 已装：从 registry 取（已安装版本的 http_allow）；未装：从 bundled 源目录读
    let sk: Skill | undefined = isInstalled ? s.skillRegistry.get(b.name) : undefined;
    if (!sk) {
      try {
        sk = loadSkill(b.dir);
      } catch {
        sk = undefined;
      }
    }
    return {
      name: b.name,
      description: b.description,
      installed: isInstalled,
      requiredEnv: sk ? skillEnvStatus(sk) : [],
      requires: sk ? skillReqStatus(sk) : [],
    };
  });
  return { skills };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envFilePath(): string {
  return path.join(pithWikiHome(), '.env');
}

/**
 * 配置 skill 的 appkey：upsert 写 ~/.pith-wiki/.env（持久化）+ 直接写引擎进程
 * process.env（即时生效——http_request 调用时才读 process.env，无需重建/重启）。
 * value 为空 = 清除该 key。.env 进程内只加载一次，故必须同时直接设 process.env。
 */
function setSkillEnv(key: string, value: string): void {
  if (!ENV_NAME_RE.test(key)) throw new Error(`invalid env var name: ${key}`);
  const clean = value.replace(/[\r\n]/g, '').trim();
  const file = envFilePath();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const lines = (raw ? raw.split('\n') : []).filter((l) => !re.test(l));
  if (clean) lines.push(`${key}=${clean}`);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.length ? lines.join('\n') + '\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out, 'utf8');
  if (clean) process.env[key] = clean;
  else delete process.env[key];
}

/** onboarding 写入全局 config.json 的 providers map + activeProvider。 */
function saveOnboarding(provider: string, baseURL: string, model: string, apiKey: string): void {
  const file = path.join(pithWikiHome(), 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* 首次创建 */
  }
  const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
  providers[provider] = { baseURL, model, apiKey };
  const next = { ...existing, providers, activeProvider: provider };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/* ───────────────────────── boot ───────────────────────── */

const bridge = makeBridgeServer(transport, handle);

initServices()
  .then((s) => {
    svc = s;
    bridge.emit({ kind: 'engine.ready' });
  })
  .catch((err: Error) => {
    emitNotice('error', `engine init failed: ${err.message}`);
  });

process.on('exit', () => svc?.stop());
