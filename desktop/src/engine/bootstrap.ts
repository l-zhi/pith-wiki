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
import os from 'node:os';
import path from 'node:path';

import {
  loadConfigFromEnv,
  ensureWikiRoot,
  ensureQueueDirs,
  pickHydrationProvider,
  resolveProviderEntry,
  type Config,
} from '@core/config.js';
import { pithWikiHome } from '@core/paths.js';
import { createClient } from '@core/llm/client.js';
import { Agent, defaultSystemPrompt } from '@core/llm/agent.js';
import { ClaudeCodeAgent } from './claudeCodeAgent.js';
import { ReviewingAgent, type ReviewTrace } from './reviewingAgent.js';
import { composeSystemPrompt, loadSoul, SOUL_PROMPT_HEADER, type LoadedSoul } from '@core/llm/soul.js';
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
  type CliDTO,
  type ProviderDTO,
  type QueueDigestDTO,
  type ScheduledTaskDTO,
  type ScheduleSpecDTO,
  type SettingsDTO,
  type SettingsSaveDTO,
  type SoulDTO,
  type SkillCardDTO,
  type SkillEnvDTO,
  type SkillReqDTO,
  type SkillsDTO,
  type Transport,
} from '../shared/protocol.js';
import { SessionStore } from './sessionStore.js';
import { SessionManager, type AgentFactory, type AgentLike } from './sessionManager.js';
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
  /** 水合专属 client / model / json 能力（claude-code 聊天时指向某 openai provider）。 */
  hydrationClient: ReturnType<typeof createClient>;
  hydrationModel: string;
  hydrationSupportsJson: boolean;
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

/** claude-code provider 的检索人设：引导 Claude Code 优先用 pith MCP 工具检索知识库作答。 */
const CLAUDE_CODE_SYSTEM_PROMPT =
  '你是 pith 本地知识库的问答助手。回答前优先调用 mcp__pith__ 工具从用户的知识库检索证据：' +
  'wiki_query（模糊语义检索）、wiki_grep（精确/正则检索）、wiki_get（按 id 取条目）、' +
  'wiki_list（浏览某 collection）、wiki_read_source（读条目原文）。' +
  '基于检索到的条目作答，并在末尾标注引用到的条目标题；库中确无相关内容时如实说明。';

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
  // 水合专属 client：聊天 provider 是 claude-code 时，后台水合 / digest 仍走一个 API
  // provider（claude-code 不能做批量 JSON 水合）。openai 聊天时直接复用主 client。
  let hydrationClient = client;
  let hydrationModel = config.model;
  let hydrationSupportsJson = config.supportsJsonMode;
  if (config.providerKind === 'claude-code') {
    const he = pickHydrationProvider(config);
    if (he) {
      const r = resolveProviderEntry(he);
      hydrationClient = createClient(
        { ...config, ...r },
        {
          onSecurityNotice: (msg, kind) =>
            emitNotice(kind === 'warning' ? 'warning' : 'info', `🔒 ${msg}`),
        },
      );
      hydrationModel = r.model;
      hydrationSupportsJson = r.supportsJsonMode;
    } else {
      emitNotice(
        'warning',
        '聊天用的是 claude-code，但没有可做水合的 API provider —— 后台水合会失败。请在设置里加一个 OpenAI 兼容 provider。',
      );
    }
  }
  console.log(
    `[pith/route] hydration → model=${hydrationModel} baseURL=${hydrationClient.baseURL} json=${hydrationSupportsJson}`,
  );
  // 审稿专用 client（P2b）：配了 reviewProvider（须为 API provider）→ reviewer 走它；
  // 否则 null → reviewer 与 writer 同 provider（见 agentFactory）。
  let reviewClient: ReturnType<typeof createClient> | null = null;
  let reviewModel = '';
  if (config.reviewProvider) {
    const re = config.providers[config.reviewProvider];
    if (re && re.kind !== 'claude-code') {
      const r = resolveProviderEntry(re);
      reviewClient = createClient(
        { ...config, ...r },
        {
          onSecurityNotice: (msg, kind) =>
            emitNotice(kind === 'warning' ? 'warning' : 'info', `🔒 ${msg}`),
        },
      );
      reviewModel = r.model;
      console.log(`[pith/route] reviewer → model=${reviewModel} baseURL=${reviewClient.baseURL}`);
    } else {
      emitNotice(
        'warning',
        `审稿 provider "${config.reviewProvider}" 不可用（须为 API provider，非 claude-code）—— 审稿将回退为与聊天同模型。`,
      );
    }
  }
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
      const hydrator = new HydrationService(
        hydrationClient,
        hydrationModel,
        library,
        hydrationSupportsJson,
      );
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
  const agentFactory: AgentFactory = (sessionId, approvals, origin, reviewMode) => {
    // 写文件落点：知识库 output collection 的绝对路径（claude-code 会漏掉 wiki-data 这层）。
    const outputDir = path.join(config.wikiRoot, config.digestCollection);

    // 每个分支产出 writer + 一个"按人设造同类 agent"的 makeReviewer；
    // reviewMode 时把 writer/reviewer 包成 ReviewingAgent（对 SessionManager 透明）。
    let writer: AgentLike;
    let makeReviewer: () => AgentLike;
    let model: string;
    let provider: string | undefined;

    if (config.providerKind === 'claude-code') {
      // claude-code：委托本机 claude CLI（headless + pith-mcp），复用订阅额度。
      const entry = config.activeProvider ? config.providers[config.activeProvider] : undefined;
      const token =
        entry?.oauthToken ?? (entry?.oauthTokenEnv ? process.env[entry.oauthTokenEnv] : undefined);
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
      const mcpConfigPath = entry?.mcpConfigPath ?? path.join(home, 'pith-mcp.json');
      console.log(
        `[pith/route] chat → claude-code CLI | provider=${config.activeProvider} model=${config.model} ` +
          `binary=${entry?.binary ?? 'claude'} mcp=${mcpConfigPath} review=${reviewMode}`,
      );
      const soulSuffix = soul.content.trim()
        ? `\n\n${SOUL_PROMPT_HEADER}\n\n${soul.content.trim()}`
        : '';
      const writerPrompt =
        `${CLAUDE_CODE_SYSTEM_PROMPT}\n\n` +
        `如需把结果写成文件（日报/报告等），文件路径必须是绝对路径且写入这个确切目录：` +
        `${outputDir}/（pith 知识库的 output collection），文件名用「主题或日期.md」。` +
        `这是唯一的输出落点，不要自己拼路径或省略其中任何一层目录。` +
        soulSuffix;
      const mkCC = (systemPrompt: string): AgentLike =>
        new ClaudeCodeAgent({
          binary: entry?.binary ?? 'claude',
          model: config.model,
          systemPrompt,
          mcpConfigPath,
          env,
          cwd: home,
        });
      writer = mkCC(writerPrompt);
      makeReviewer = () => mkCC(REVIEWER_SYSTEM_PROMPT);
      model = config.model;
      provider = config.activeProvider || 'claude-code';
    } else {
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
          origin,
        },
      );
      const extraTools = skillRegistry.list().length > 0 ? [makeSkillTool(skillRegistry)] : [];
      if (skillRegistry.allowedCommands().size > 0) extraTools.push(runCommandTool);
      if (skillRegistry.allowedHosts().size > 0) extraTools.push(httpRequestTool);
      extraTools.push(...scheduleTools);
      console.log(
        `[pith/route] chat → openai | provider=${config.activeProvider || '(top-level)'} ` +
          `model=${config.model} baseURL=${config.baseURL} review=${reviewMode}`,
      );
      const mkPith = (systemPrompt: string): AgentLike =>
        new Agent(client, config.model, ctx, { systemPrompt, extraTools, maxSteps: config.maxSteps });
      writer = mkPith(composeSystemPrompt(defaultSystemPrompt, soul));
      makeReviewer = () => mkPith(REVIEWER_SYSTEM_PROMPT);
      model = config.model;
      provider = config.activeProvider || undefined;
    }

    if (!reviewMode) return { agent: writer, model, provider };

    // reviewer：配了 reviewProvider → 用独立 client 造一个只读 pith Agent（不给写/执行/skill 工具）；
    // 否则与 writer 同 provider（makeReviewer）。
    let reviewer: AgentLike;
    if (reviewClient) {
      const rctx = buildContext(
        config,
        reviewClient,
        () => Promise.resolve('no' as const), // reviewer 不写文件
        library,
        {
          converterRegistry: converters.registry,
          converterCache: converters.cache,
          skillRegistry,
          scheduleService,
          requestCommandApproval: () => Promise.resolve('no' as const), // reviewer 不执行命令
          origin,
        },
      );
      reviewer = new Agent(reviewClient, reviewModel, rctx, {
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        extraTools: [],
        maxSteps: config.maxSteps,
      });
    } else {
      reviewer = makeReviewer();
    }

    // 审稿模式：writer→reviewer→修订 闭环。
    const agent = new ReviewingAgent({
      writer,
      reviewer,
      maxRounds: config.reviewMaxRounds,
      rubric: getReviewRubric(),
      traceSink: (trace) => writeReviewTrace(config.outputDir, sessionId, trace),
    });
    return { agent, model, provider };
  };
  const sessions = new SessionManager(
    sessionStore,
    agentFactory,
    (evt) => bridge.emit(evt),
    path.join(config.wikiRoot, 'output'), // write_file 落点根：把相对路径还原成绝对路径
  );

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
    hydrationClient,
    hydrationModel,
    hydrationSupportsJson,
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
    review: task.review,
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
        // claude-code provider 没有 apiKey（走订阅），不该被当成"未配置"而弹引导页
        needsOnboarding: s.config.apiKey.length === 0 && s.config.providerKind !== 'claude-code',
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
      return requireSvc().sessions.create(req.provider, { reviewMode: req.reviewMode });
    case 'session.setReviewMode':
      return requireSvc().sessions.setReviewMode(req.sessionId, req.reviewMode);
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
        s.hydrationClient,
        s.hydrationModel,
        s.library,
        s.hydrationSupportsJson,
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
      const output = s.config.digestCollection;
      const byCol = new Map<string, number>();
      for (const e of s.library.list()) byCol.set(e.collection, (byCol.get(e.collection) ?? 0) + 1);
      return [...byCol.entries()]
        .map(([id, count]) => ({ id, count, watch: watch.has(id), output: id === output }))
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
    case 'settings.getSoul':
      return getSoul();
    case 'settings.saveSoul':
      return saveSoul(req.content);
    case 'settings.getReview':
      return getReview();
    case 'settings.saveReview':
      return saveReview(req.content);
    case 'settings.setActiveProvider': {
      // 即时切换聊天 provider（聊天框下拉 + 设置「对话模型」选择器）：改 activeProvider + 全量重建。
      const file = readConfigFile();
      const providers = (file.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
      let nextProviders = providers;
      if (req.name && !providers[req.name]) {
        // 选了本机检测到的 CLI（如 claude-code）但还没配过 → 现合成一条最小 entry，
        // binary 回填检测到的绝对路径（GUI 子进程 PATH 可能很瘦）。其余非 CLI 名才报错。
        if (req.name === 'claude-code') {
          const bin = resolveBinaryPath('claude');
          nextProviders = {
            ...providers,
            'claude-code': { kind: 'claude-code', model: 'sonnet', ...(bin ? { binary: bin } : {}) },
          };
        } else {
          throw new Error(`provider not found: ${req.name}`);
        }
      }
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ ...file, providers: nextProviders, activeProvider: req.name }, null, 2) + '\n',
        'utf8',
      );
      await rebuildServices();
      return { ok: true };
    }
    case 'settings.setHydrationProvider': {
      // 即时切换水合 provider（设置「水合模型」选择器）：空串=Auto；非空必须是已存在的 API provider。
      const file = readConfigFile();
      const providers = (file.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
      if (req.name) {
        const p = providers[req.name];
        if (!p) throw new Error(`provider not found: ${req.name}`);
        if (p.kind === 'claude-code') throw new Error('水合 provider 必须是 API provider，claude-code 不能做批量水合');
      }
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ ...file, hydrationProvider: req.name }, null, 2) + '\n',
        'utf8',
      );
      await rebuildServices();
      return { ok: true };
    }
    case 'settings.setReviewProvider': {
      // 即时切换审稿 provider（设置「审稿模型」选择器）：空串=同 writer；非空必须是已存在的 API provider。
      const file = readConfigFile();
      const providers = (file.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
      if (req.name) {
        const p = providers[req.name];
        if (!p) throw new Error(`provider not found: ${req.name}`);
        if (p.kind === 'claude-code') throw new Error('审稿 provider 必须是 API provider，claude-code 不适合逐轮评审');
      }
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ ...file, reviewProvider: req.name }, null, 2) + '\n',
        'utf8',
      );
      await rebuildServices();
      return { ok: true };
    }
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
        review: p.review,
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
        review: p.review,
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

/** SOUL.md 的规范落点：pith home 下的单份文件（桌面端全局单工作区）。 */
function soulFilePath(): string {
  return path.join(pithWikiHome(), 'SOUL.md');
}

/** 读 SOUL.md 内容供设置页编辑（不存在 → 空串）。 */
function getSoul(): SoulDTO {
  const p = soulFilePath();
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    content = '';
  }
  return { content, path: p };
}

/**
 * 写 SOUL.md 并全量重建 Engine（soul 在 Agent 构造时烘焙进 system prompt，改后需重建）。
 * 空内容 = 删除 SOUL.md（loadSoul 视作"无 soul"，不再往 prompt 追加 Voice 段）。
 */
async function saveSoul(content: string): Promise<{ ok: true }> {
  const p = soulFilePath();
  const trimmed = content.trim();
  if (trimmed) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, trimmed + '\n', 'utf8');
  } else {
    try {
      fs.rmSync(p);
    } catch {
      /* 本就不存在，无需处理 */
    }
  }
  await rebuildServices();
  return { ok: true };
}

/* ───────────────────────── 审稿模式（ReviewingAgent） ───────────────────────── */

/** reviewer agent 的系统人设——真正的评审指令每轮由 buildReviewPrompt 作为用户消息给出。 */
const REVIEWER_SYSTEM_PROMPT =
  '你是 pith 的审稿人。严格按用户消息中的格式与标准输出裁决,首行必须是 `VERDICT: PASS` 或 `VERDICT: REVISE`。' +
  '只做评审:不要创建或修改任何文件,不要调用写入 / 入库 / 排程类工具。';

/** 审核标准落点:`<pithHome>/REVIEW.md`。 */
function reviewFilePath(): string {
  return path.join(pithWikiHome(), 'REVIEW.md');
}

/** 审核标准来源:REVIEW.md;不存在 → 空串 → ReviewingAgent 用内置默认 rubric。 */
function getReviewRubric(): string {
  try {
    return fs.readFileSync(reviewFilePath(), 'utf8');
  } catch {
    return '';
  }
}

/** 读 REVIEW.md 供设置页编辑(与 getSoul 对称)。 */
function getReview(): SoulDTO {
  return { content: getReviewRubric(), path: reviewFilePath() };
}

/** 写 REVIEW.md 并全量重建(rubric 在 Agent 构造时读入);空内容 = 删除(回落默认 rubric)。 */
async function saveReview(content: string): Promise<{ ok: true }> {
  const p = reviewFilePath();
  const trimmed = content.trim();
  if (trimmed) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, trimmed + '\n', 'utf8');
  } else {
    try {
      fs.rmSync(p);
    } catch {
      /* 本就不存在 */
    }
  }
  await rebuildServices();
  return { ok: true };
}

/** 留痕(做法 B):把审稿轨迹追加到 transcript 目录,不进会话历史。 */
function writeReviewTrace(transcriptsDir: string, sessionId: string, trace: ReviewTrace): void {
  try {
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const stamp = new Date().toISOString();
    const passed = trace.rounds.at(-1)?.verdict === 'PASS';
    const head = `## ${stamp} · ${passed ? `PASS(${trace.rounds.length}轮)` : `EXHAUSTED(${trace.rounds.length}轮未过)`}`;
    const body = trace.rounds
      .map((r) => {
        const issues = r.verdict === 'REVISE' ? `\n${r.issues}\n` : '';
        return `### 第${r.round}轮 — ${r.verdict}${issues}\n<details><summary>本轮草稿</summary>\n\n${r.draft}\n\n</details>`;
      })
      .join('\n\n');
    const md = `${head}\n\n**任务**: ${trace.task}\n\n${body}\n\n---\n\n`;
    fs.appendFileSync(path.join(transcriptsDir, `review-${sessionId}.md`), md, 'utf8');
  } catch {
    /* 留痕失败不应影响对话主流程 */
  }
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

/**
 * 解析一个 CLI 可执行文件的绝对路径：绝对/相对路径直接验在；裸名在 PATH +
 * ~/.local/bin 里查（GUI 启动的子进程 PATH 往往很瘦，补一条用户常装目录）。
 * 找不到 → undefined。
 */
function resolveBinaryPath(bin: string): string | undefined {
  try {
    if (bin.includes('/')) return fs.existsSync(bin) ? bin : undefined;
    const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
    for (const d of dirs) {
      if (d && fs.existsSync(path.join(d, bin))) return path.join(d, bin);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 本机可作为聊天后端的 CLI 检测（v1 仅 claude-code）。取已配置 binary，否则探测 `claude`。 */
function detectClis(providersRaw: Record<string, Record<string, unknown>>): CliDTO[] {
  const cc = Object.values(providersRaw).find((p) => p.kind === 'claude-code');
  const bin = typeof cc?.binary === 'string' && cc.binary ? cc.binary : 'claude';
  return [{ id: 'claude-code', label: 'Claude Code CLI', present: Boolean(resolveBinaryPath(bin)) }];
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
    const kind = p.kind === 'claude-code' ? 'claude-code' : 'openai';
    // claude-code 的密钥存在 oauthToken（而非 apiKey）；展示成 literal（掩码）。
    const ccToken =
      kind === 'claude-code' && typeof p.oauthToken === 'string' && p.oauthToken.length > 0
        ? (p.oauthToken as string)
        : null;
    const effectiveLiteral = ccToken ?? literal;
    return {
      name,
      kind,
      baseURL: String(p.baseURL ?? ''),
      model: String(p.model ?? ''),
      supportsJsonMode: p.supportsJsonMode !== false,
      keySource: effectiveLiteral ? 'literal' : envVar ? 'env' : 'none',
      keyMasked: effectiveLiteral ? maskKey(effectiveLiteral) : undefined,
      keyEnvVar: envVar ?? undefined,
      keyResolved: Boolean(effectiveLiteral || envVal),
    };
  });
  const watchDirs = ((file.watchDirs as Record<string, unknown>[] | undefined) ?? []).map((w) => ({
    path: String(w.path ?? ''),
    collectionFromSubdir: w.collectionFromSubdir === true,
    initialScan: w.initialScan === true,
  }));
  return {
    activeProvider: String(file.activeProvider ?? ''),
    hydrationProvider: String(file.hydrationProvider ?? ''),
    reviewProvider: String(file.reviewProvider ?? ''),
    providers,
    availableClis: detectClis(providersRaw),
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
    // claude-code 委托本机 CLI，不走 HTTP，无需 baseURL；其余必须是合法 URL。
    if (p.kind !== 'claude-code') {
      try {
        new URL(p.baseURL);
      } catch {
        throw new Error(`invalid baseURL for ${p.name}: ${p.baseURL}`);
      }
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
    const base = { ...(oldProviders[p.name] ?? {}) }; // 保留 apiKeyEnv / binary / mcpConfigPath 等未管理字段
    base.kind = p.kind;
    base.model = p.model;
    if (p.supportsJsonMode) delete base.supportsJsonMode;
    else base.supportsJsonMode = false;
    if (p.kind === 'claude-code') {
      // 不写空 baseURL（否则下次 load 的 url 校验会失败）；密钥存 oauthToken。
      delete base.baseURL;
      if (p.newApiKey && p.newApiKey.trim()) base.oauthToken = p.newApiKey.trim();
      // 在「对话模型」里直接选了本机检测到的 CLI（无 binary）→ 回填检测到的绝对路径，
      // 这样 GIU 子进程即使 PATH 很瘦也能 spawn（裸名 'claude' 可能找不到）。
      if (!base.binary) {
        const detected = resolveBinaryPath('claude');
        if (detected) base.binary = detected;
      }
    } else {
      base.baseURL = p.baseURL;
      if (p.newApiKey && p.newApiKey.trim()) base.apiKey = p.newApiKey.trim();
    }
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
    hydrationProvider: payload.hydrationProvider,
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

  // 切到 claude-code 但找不到 pith-mcp 配置 → 能聊天但读不到知识库，给个非阻塞提示。
  const activeEntry = nextProviders[payload.activeProvider];
  if (activeEntry?.kind === 'claude-code') {
    const mcp =
      typeof activeEntry.mcpConfigPath === 'string'
        ? activeEntry.mcpConfigPath
        : path.join(pithWikiHome(), 'pith-mcp.json');
    if (!fs.existsSync(mcp)) {
      emitNotice(
        'warning',
        `已切到 Claude Code，但未找到 pith-mcp 配置（${mcp}）—— 现在能聊天但读不到你的知识库。请在该 provider 的 mcpConfigPath 指向一个 pith-mcp 配置文件。`,
      );
    }
  }
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

/**
 * 配置 skill 的 appkey：upsert 写 config.json 的 `secrets` map（持久化，密钥唯一源）+
 * 直接写引擎进程 process.env（即时生效——http_request 调用时才读 process.env，无需重建/重启）。
 * value 为空 = 清除该 key（同时从 secrets 删 + 从 process.env delete）。
 * secrets 在引擎启动时由 loadConfigFromEnv 灌进 process.env，运行期改动靠这里直接设。
 */
function setSkillEnv(key: string, value: string): void {
  if (!ENV_NAME_RE.test(key)) throw new Error(`invalid env var name: ${key}`);
  const clean = value.replace(/[\r\n]/g, '').trim();
  const file = readConfigFile();
  const secrets = { ...((file.secrets as Record<string, string> | undefined) ?? {}) };
  if (clean) secrets[key] = clean;
  else delete secrets[key];
  const next = { ...file, secrets };
  fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
  fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
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
