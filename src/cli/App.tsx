import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Agent, AgentError, defaultSystemPrompt } from '../llm/agent.js';
import { createClient } from '../llm/client.js';
import { composeSystemPrompt, loadSoul, type LoadedSoul } from '../llm/soul.js';
import { buildContext } from '../tools/index.js';
import { makeSkillTool } from '../tools/skill.js';
import { runCommandTool } from '../tools/run_command.js';
import { buildSkillRegistry, SkillRegistry } from '../skills/index.js';
import { installSkillFromSource, removeSkillByName, SkillExistsError } from '../skills/install.js';
import {
  ensureOutputDir,
  ensureQueueDirs,
  ensureWikiRoot,
  resolveProviderEntry,
  type Config,
} from '../config.js';
import { ChatView, DisplayMessage } from './ChatView.js';
import { renderMarkdown } from './MarkdownView.js';
import { InputBox } from './InputBox.js';
import { buildMentionCandidates, buildMentionTree, parseScope } from './mentions.js';
import { ToolApproval, ApprovalRequest } from './ToolApproval.js';
import { TokenMeter } from './TokenMeter.js';
import { appendHistory, loadHistory } from './history.js';
import { StatusBar, type QueueWorkerStatus } from './StatusBar.js';
import { SLASH_COMMANDS, type SlashCommand } from './slashCommands.js';
import { TranscriptLogger, deriveTranscriptPath } from './transcript.js';
import { QueueLockedError, QueueStore } from '../wiki/queue/store.js';
import { runQueue } from '../wiki/queue/runner.js';
import { buildConverterPipeline } from '../wiki/converters/index.js';
import { runWatcher } from '../wiki/queue/watcher.js';
import { LibraryService } from '../wiki/library.js';
import { HydrationService } from '../wiki/hydration.js';
import { formatConvertersTable } from './converterFormat.js';
import { collectDashboardData, formatDashboard } from './dashboardData.js';
import { Dashboard } from './Dashboard.js';
import { clearDead, formatDeadList, formatQueueStatus, resetDead, shortError } from './queueOps.js';

interface Props {
  /**
   * 启动时的 config（已经 applyActiveProvider 过；apiKey/baseURL/model 是当前
   * provider 的值）。REPL 内通过 `/provider` 切换时不会改写这个对象，而是
   * 用 activeProviderName state + useMemo 派生出运行时 config 喂给下游。
   */
  config: Config;
}

export function App({ config: initialConfig }: Props) {
  const { exit } = useApp();
  // 当前生效的 provider 名（来自 initialConfig.activeProvider；undefined = 没用
  // multi-provider，走顶层 apiKey/baseURL/model）。
  const [activeProviderName, setActiveProviderName] = useState<string | undefined>(
    () => initialConfig.activeProvider,
  );

  // 把当前 provider overlay 到 config 上。下面所有 `config.X` 都读这个派生值，
  // /provider 切换时整棵 useMemo 链（client → agent → hydrator）自动重建。
  const config = useMemo<Config>(() => {
    if (!activeProviderName) return initialConfig;
    const entry = initialConfig.providers[activeProviderName];
    if (!entry) return initialConfig; // 兜底；slash 命令切换前已经校验过
    const resolved = resolveProviderEntry(entry);
    return {
      ...initialConfig,
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      model: resolved.model,
      activeProvider: activeProviderName,
    };
  }, [initialConfig, activeProviderName]);

  // OpenAI client 跟随 config；切换 provider 时自动重建。
  const client = useMemo(() => createClient(config), [config]);

  // SOUL.md：启动时按 (config.soulFile > env > 默认双层) 解析一次。
  // useState lazy init 保证整个 session 只读一次盘——切 provider 不需要重读
  // （soul 跟 wiki/模型无关），改 SOUL.md 文件本身要重启 REPL 才生效（避免半中段
  // 风格漂移）。
  const [soul] = useState<LoadedSoul>(() =>
    loadSoul({ soulFile: config.soulFile, workspaceRoot: config.workspaceRoot }),
  );

  const [messages, setMessages] = useState<DisplayMessage[]>([
    {
      id: 'welcome',
      role: 'system',
      text:
        `pith-wiki ready. model=${config.model} root=${config.workspaceRoot}` +
        (activeProviderName ? ` provider=${activeProviderName}` : '') +
        `\nType "/" for command suggestions (Tab completes). Ctrl+C cancels in-flight; press twice to exit.` +
        (config.transcriptEnabled
          ? `\ntranscript on (use /transcript to see path)`
          : '\ntranscript off') +
        (soul.sources.length > 0
          ? `\nsoul loaded from ${soul.sources.map((p) => shortenHome(p)).join(' + ')}`
          : ''),
    },
  ]);
  const [inFlight, setInFlight] = useState(false);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // verbose=false（默认）：think / tool / 中间叙述只在动态区显示一行实时状态（见 activity）。
  // verbose=true：think 与 tool 在终端内联展开完整内容。切换只影响后续轮（scrollback 不可改）。
  const [verbose, setVerbose] = useState(false);
  // 进行中的"当前活动"单行状态（默认模式下渲染在动态区，替代静态 spinner 文案）。
  // 新动作替换旧的；轮结束清空。null = 还没有具体活动，显示通用 thinking…。
  const [activity, setActivity] = useState<string | null>(null);
  // 历史命令：启动时从 ~/.pith-wiki/history 加载最近 N 条；每次提交追加。
  const [history, setHistory] = useState<string[]>(() =>
    loadHistory(config.historyFile, HISTORY_LIMIT),
  );

  const abortRef = useRef<AbortController | null>(null);
  const lastInterruptRef = useRef<number>(0);
  const idCounterRef = useRef(0);
  const nextId = () => `m${++idCounterRef.current}`;

  // 队列 worker：随 REPL session 一起起，组件 unmount 时 abort + 释放锁。
  // 锁被另一个进程占着（用户开了 `queue run`）时降级为只读状态展示。
  const [queueWorkerStatus, setQueueWorkerStatus] = useState<QueueWorkerStatus>(() => ({
    mode: config.queueAutoStart ? 'self' : 'off',
  }));

  // 整个 REPL session 共用一份 LibraryService。
  // 关键不变量：agent 的工具（wiki_query / wiki_list / wiki_get / wiki_read_source /
  // /digest 的 hydrator）和后台 queue worker / watcher 都通过同一个 library 写读，
  // in-memory cache 天然同步。worker 刚 ingest 的新条目，下一秒 wiki_list 就能看到；
  // index.json 也只有一个 owner 在写，不会两份 cache 互相覆盖。
  const library = useMemo(
    () => new LibraryService(config.wikiRoot, { ignoredDirs: [config.outputDir] }),
    [config.wikiRoot, config.outputDir],
  );

  // 转换器注册表 + 结果缓存：整个 REPL session 共用一份。
  // worker / watcher / agent 工具上下文都拿同一份；watcher 据此动态生成 chokidar glob，
  // /converters slash 据此打表。
  const converters = useMemo(
    () =>
      buildConverterPipeline({ wikiRoot: config.wikiRoot, cacheConverted: config.cacheConverted }),
    [config.wikiRoot, config.cacheConverted],
  );

  // Skill 注册表：启动时异步扫一次 skillDirs。
  // 与 soul 同生命周期——加载后整个 session 不变；新增 skill 需重启 REPL 才生效
  // （catalog 在 Agent 构造时 baked）。初始为空 registry，加载完 setState 触发 agent 重建一次。
  const [skillRegistry, setSkillRegistry] = useState<SkillRegistry>(() => new SkillRegistry());
  useEffect(() => {
    let alive = true;
    const warnings: string[] = [];
    buildSkillRegistry({
      skillDirs: config.skillDirs,
      onWarn: (m) => warnings.push(m),
    })
      .then((reg) => {
        if (!alive) return;
        setSkillRegistry(reg);
        const n = reg.list().length;
        if (n > 0 || warnings.length > 0) {
          const parts = [`skills: ${n} discovered`];
          if (warnings.length) parts.push(...warnings.map((w) => `  ⚠ ${w}`));
          append({ role: 'system', text: parts.join('\n') });
        }
      })
      .catch((err: Error) => {
        if (!alive) return;
        append({ role: 'error', text: `skill discovery failed: ${err.message}` });
      });
    return () => {
      alive = false;
    };
    // 只在挂载时跑一次（skillDirs 启动后不变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动 dashboard：扫 wikiRoot 各 collection 的 .md 数 + 每个 watchDir 的可识别文件数，
  // 作为一条 system 消息追加到对话顶部。异步加载，不阻塞 REPL 启动。
  // /provider 切换会改 config，但不影响 wikiRoot/watchDirs，dashboard 不必重跑——
  // 故依赖只取真正影响输出的字段。
  useEffect(() => {
    let alive = true;
    collectDashboardData(config, converters.registry)
      .then((data) => {
        if (!alive) return;
        // 把启动时的 worker 状态快照进 dashboard（mode pill）。后续若 worker 报错，
        // 会通过 setQueueWorkerStatus 触发独立的 system 消息，不再依赖底部常驻指示器。
        const workerSnap = {
          mode: queueWorkerStatus.mode,
          externalPid: queueWorkerStatus.externalPid,
          error: queueWorkerStatus.error,
        };
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'system',
            // text 留 plain 版本做日志/transcript 兜底；node 走 Ink 真表格
            text: formatDashboard(data, workerSnap),
            node: <Dashboard data={data} worker={workerSnap} />,
          },
        ]);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'error', text: `dashboard scan failed: ${err.message}` },
        ]);
      });
    return () => {
      alive = false;
    };
    // 故意省略 dep: hydrator / library / config 的其它派生都不参与 watcher 启停
    // （等以后启用 react-hooks lint 再加 `eslint-disable-next-line react-hooks/exhaustive-deps`）
  }, [config.wikiRoot, config.watchDirs, converters]);

  useEffect(() => {
    if (!config.queueAutoStart) return;
    ensureQueueDirs(config);
    const store = new QueueStore(config.queueStatePath);
    let release: (() => void) | null = null;
    try {
      release = store.acquireLock();
    } catch (err) {
      if (err instanceof QueueLockedError) {
        setQueueWorkerStatus({ mode: 'external', externalPid: err.lockingPid });
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'system',
            text: `queue: another process holds the lock (pid=${err.lockingPid}); running read-only`,
          },
        ]);
        return;
      }
      const msg = (err as Error).message;
      setQueueWorkerStatus({ mode: 'error', error: msg });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'error', text: `queue lock failed: ${msg}` },
      ]);
      return;
    }

    const ac = new AbortController();
    const hydrator = new HydrationService(client, config.model, library, config.supportsJsonMode);

    const workerPromise = runQueue({
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
      // REPL 内 worker 不打控制台 log（会污染对话视图）。进度查 state.json 的
      // events 环 + ~/.pith-wiki/queue/logs/<jobId>.log；崩溃会通过下面的 .catch
      // 走 system error message 显式提示用户。
      log: () => {},
      idleBehavior: 'wait',
    }).catch((err: Error) => {
      setQueueWorkerStatus({ mode: 'error', error: err.message });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'error', text: `queue worker crashed: ${err.message}` },
      ]);
    });

    // watcher：仅当 watchAutoStart 且 watchDirs 非空时起。失败不影响 worker。
    let watcherPromise: Promise<void> | null = null;
    if (config.watchAutoStart && config.watchDirs.length > 0) {
      const safety = {
        workspaceRoot: config.workspaceRoot,
        wikiRoot: config.wikiRoot,
        maxPayloadBytes: config.maxToolPayloadBytes,
        readOnly: config.readOnly,
        additionalReadPaths: config.additionalReadPaths,
      };
      watcherPromise = runWatcher({
        store,
        targets: config.watchDirs,
        safety,
        signal: ac.signal,
        extensions: converters.registry.extensions(),
        // REPL 内 watcher 不打控制台 log（会污染对话视图）。事件可在 state.json 的
        // events 环里看到（kind='enqueued' msg='watcher:add/change/initial-scan'）。
        log: () => {},
      }).catch((err: Error) => {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'error', text: `watcher failed: ${err.message}` },
        ]);
      });
    }

    return () => {
      ac.abort();
      // 释放锁：worker 的 finally 也会清，但同步释放更稳——React unmount 之后
      // 进程通常立刻退出，没机会等异步 finally 跑完。
      try {
        release?.();
      } catch {
        // 锁已被 worker finally 释放也无妨，吞掉。
      }
      // 把 5s 防抖窗口里没写盘的索引同步落地，让下次启动直接命中磁盘 cache。
      // best-effort：失败也不阻塞退出。
      try {
        library.flushIndex();
      } catch {
        // ignore
      }
      // 异步 worker / watcher 后续可能再写一次 state.json（最终态、close），无害。
      void workerPromise;
      void watcherPromise;
    };
  }, [config, client, library]);

  const requestApproval = useMemo(
    () => (path: string, preview: string) =>
      new Promise<'yes' | 'no' | 'always'>((resolve) => {
        setApproval({
          kind: 'write',
          path,
          preview,
          resolve: (answer) => {
            setApproval(null);
            resolve(answer);
          },
        });
      }),
    [],
  );

  // 命令执行审批：与写入审批共用 setApproval 队列，靠 kind='exec' 区分文案。
  const requestCommandApproval = useMemo(
    () => (command: string, argvPreview: string) =>
      new Promise<'yes' | 'no' | 'always'>((resolve) => {
        setApproval({
          kind: 'exec',
          path: command,
          preview: argvPreview,
          resolve: (answer) => {
            setApproval(null);
            resolve(answer);
          },
        });
      }),
    [],
  );

  // Transcript logger：每次 REPL session 一份独立 markdown 文件，写在 config.outputDir。
  // 用 useMemo 而不是 useState，保证整个 session 期间只构造一次；构造时立即写 header。
  const transcript = useMemo(() => {
    if (!config.transcriptEnabled) return null;
    try {
      ensureOutputDir(config);
    } catch (err) {
      // 目录创建失败就放弃 transcript，但不影响 REPL 启动
      process.stderr.write(`transcript: failed to create outputDir — ${(err as Error).message}\n`);
      return null;
    }
    const startedAt = new Date();
    const filePath = deriveTranscriptPath(config.outputDir, startedAt);
    const logger = new TranscriptLogger(filePath);
    logger.writeHeader({
      model: config.model,
      workspaceRoot: config.workspaceRoot,
      wikiRoot: config.wikiRoot,
      startedAt: startedAt.toISOString(),
    });
    return logger;
  }, [config]);

  const agent = useMemo(() => {
    // 共用的 library + converter pipeline 透传进 toolCtx；wiki_* 工具和 worker /
    // watcher 看到同一份索引、同一份转换器注册表。
    const ctx = buildContext(config, client, requestApproval, library, {
      converterRegistry: converters.registry,
      converterCache: converters.cache,
      skillRegistry,
      requestCommandApproval,
    });
    const systemPrompt = composeSystemPrompt(defaultSystemPrompt, soul);
    // skill 走单个 `skill` 工具（仅当存在 skill 时才挂，避免空 catalog 的死工具）。
    const extraTools = skillRegistry.list().length > 0 ? [makeSkillTool(skillRegistry)] : [];
    // run_command 仅当有 skill 声明过可执行命令时才挂（否则是个永远失败的死工具）。
    if (skillRegistry.allowedCommands().size > 0) extraTools.push(runCommandTool);
    return new Agent(client, config.model, ctx, { systemPrompt, extraTools });
  }, [config, client, requestApproval, requestCommandApproval, library, converters, soul, skillRegistry]);

  const append = (msg: Omit<DisplayMessage, 'id'>) =>
    setMessages((prev) => [...prev, { ...msg, id: nextId() }]);

  // `@`-mention 数据：flat 候选给 parseScope 校验、目录树给 InputBox 导航。
  // 随 messages 长度变化重算，让本会话内 ingest / worker 新增的条目也能进 picker
  // （list() 走内存索引，廉价）。
  const mentionCandidates = useMemo(
    () => buildMentionCandidates(library),
    [library, messages.length],
  );
  const mentionTree = useMemo(() => buildMentionTree(library), [library, messages.length]);

  // 每个 skill 暴露成一个动态 slash 命令 `/<name>`，并入 InputBox 的命令提示 / 补全。
  // 与内置命令同名者由 filterCommands 丢弃（内置优先）。
  const skillCommands = useMemo<SlashCommand[]>(
    () =>
      skillRegistry.list().map((s) => ({
        name: `/${s.name}`,
        description: `skill: ${s.description}`,
        takesArg: true,
      })),
    [skillRegistry],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (inFlight && abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        append({ role: 'system', text: '⏹  cancelled in-flight request' });
        lastInterruptRef.current = now;
        return;
      }
      if (now - lastInterruptRef.current < 1500) {
        exit();
        return;
      }
      lastInterruptRef.current = now;
      append({ role: 'system', text: '(press Ctrl+C again to exit)' });
    }
  });

  const handleSubmit = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // 任何提交（含 slash 命令）都进历史，方便回溯重用。
    setHistory((prev) => {
      const next = [...prev, trimmed];
      return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
    });
    appendHistory(config.historyFile, trimmed);

    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed);
      return;
    }

    // 解析本轮 @-mention → 检索范围。命中集合 / 条目就把范围旁路传给 agent。
    const scope = parseScope(trimmed, mentionCandidates);

    append({ role: 'user', text: trimmed });
    if (scope) {
      const parts = [
        ...scope.collections.map((c) => `${c}/`),
        ...scope.entryIds,
      ];
      append({ role: 'system', text: `↳ scope: ${parts.join(' · ')}` });
    }
    transcript?.recordUser(trimmed);
    const ac = new AbortController();
    abortRef.current = ac;
    setInFlight(true);
    setActivity(null);
    try {
      await agent.send(trimmed, {
        signal: ac.signal,
        scope: scope ?? undefined,
        events: {
          // 默认模式：进行中的过程（思考/tool/中间叙述）只在动态区显示一行可截断的
          // 实时状态，新动作替换旧的，轮结束即消失——不往 scrollback 堆永久行。
          // verbose 模式：把每条过程降权 append 进 scrollback，供调试逐条回看。
          // 完整内容两种模式都落 transcript。
          onThinking: ({ text, source }) => {
            if (verbose) {
              append({ role: 'process', text: `· 思考过程\n${indent(text)}` });
            } else {
              setActivity('思考中…');
            }
            transcript?.recordThinking(text, source);
          },
          onAssistantText: ({ text, final }) => {
            if (final) {
              // 正文渲染成 markdown 富节点（去符号/着色/表格/链接）；text 原文保留作
              // transcript 与渲染失败时的回退。renderMarkdown 内部已 try/catch。
              append({ role: 'assistant', text, node: renderMarkdown(text) });
            } else if (verbose) {
              append({ role: 'process', text: `· ${text.replace(/\s+/g, ' ').trim()}` });
            } else {
              setActivity(text.replace(/\s+/g, ' ').trim());
            }
            // 中间叙述也写 transcript，保证可追溯（这是之前完全丢失的内容）。
            transcript?.recordAssistant(text);
          },
          onToolRound: ({ name, args, ok, preview }) => {
            const head = `${name}(${truncateJson(args)})`;
            if (verbose) {
              append({ role: 'process', text: `· ${head}\n${indent(preview)}` });
            } else {
              setActivity(`${head} → ${ok ? '✓' : `✗ ${shortError(preview)}`}`);
            }
            transcript?.recordToolCall(name, args);
            transcript?.recordToolResult(name, ok, preview);
          },
          onUsage: (d) =>
            setUsage((u) => ({
              inputTokens: u.inputTokens + d.inputTokens,
              outputTokens: u.outputTokens + d.outputTokens,
            })),
        },
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Already surfaced via the cancel handler.
      } else if (err instanceof AgentError) {
        const text = `[${err.kind}] ${err.message}`;
        append({ role: 'error', text });
        transcript?.recordError(text);
      } else {
        const text = (err as Error).message;
        append({ role: 'error', text });
        transcript?.recordError(text);
      }
    } finally {
      abortRef.current = null;
      setInFlight(false);
      setActivity(null);
      transcript?.endTurn();
    }
  };

  const handleSlashCommand = (cmd: string) => {
    if (cmd === '/help') {
      const lines = SLASH_COMMANDS.map((c) => {
        const aliasNote = c.aliases?.length ? ` (alias: ${c.aliases.join(', ')})` : '';
        const argNote = c.takesArg ? ' [arg]' : '';
        return `  ${c.name}${argNote}  —  ${c.description}${aliasNote}`;
      });
      append({
        role: 'system',
        text:
          'Slash commands:\n' +
          lines.join('\n') +
          `\n\nType "/" to see live suggestions; press Tab to complete.\n` +
          `Up/Down arrows browse the last ${HISTORY_LIMIT} commands.\n` +
          'Tools: read_file, write_file, list_dir, wiki_ingest, wiki_get, wiki_query, wiki_queue_add, wiki_queue_status',
      });
    } else if (cmd === '/clear') {
      setMessages([{ id: nextId(), role: 'system', text: 'screen cleared' }]);
    } else if (cmd === '/reset') {
      agent.reset();
      setMessages([{ id: nextId(), role: 'system', text: 'conversation reset' }]);
    } else if (cmd === '/transcript') {
      append({
        role: 'system',
        text: transcript
          ? `transcript: ${transcript.filePath}`
          : 'transcript disabled (run with --no-transcript or transcriptEnabled=false)',
      });
    } else if (cmd === '/digest' || cmd.startsWith('/digest ')) {
      const arg = cmd === '/digest' ? '' : cmd.slice('/digest '.length).trim();
      void handleDigest(arg);
    } else if (cmd === '/provider' || cmd.startsWith('/provider ')) {
      const arg = cmd === '/provider' ? '' : cmd.slice('/provider '.length).trim();
      handleProvider(arg);
    } else if (cmd === '/converters') {
      append({ role: 'system', text: formatConvertersTable(converters.registry) });
    } else if (cmd === '/dashboard') {
      // 复用启动 dashboard 的同款渲染：异步采集 + Ink 表格节点。
      // worker / dashboard 状态都按"调用瞬间"快照，不订阅后续变化（StatusBar 已实时反映）。
      const workerSnap = {
        mode: queueWorkerStatus.mode,
        externalPid: queueWorkerStatus.externalPid,
        error: queueWorkerStatus.error,
      };
      collectDashboardData(config, converters.registry)
        .then((data) => {
          append({
            role: 'system',
            text: formatDashboard(data, workerSnap),
            node: <Dashboard data={data} worker={workerSnap} />,
          });
        })
        .catch((err: Error) => {
          append({ role: 'error', text: `dashboard error: ${err.message}` });
        });
    } else if (cmd === '/queue' || cmd.startsWith('/queue ')) {
      const arg = cmd === '/queue' ? '' : cmd.slice('/queue '.length).trim();
      handleQueue(arg);
    } else if (cmd === '/soul') {
      if (soul.sources.length === 0) {
        append({
          role: 'system',
          text:
            'No SOUL.md loaded.\nDrop one at ~/.pith-wiki/SOUL.md (user-global)\n' +
            'or ' +
            path.join(config.workspaceRoot, 'SOUL.md') +
            ' (project-local),\n' +
            'or set PITH_WIKI_SOUL=<path>. Restart REPL to apply.',
        });
      } else {
        append({
          role: 'system',
          text:
            `soul sources:\n  ${soul.sources.map((p) => shortenHome(p)).join('\n  ')}\n\n` +
            '─'.repeat(40) +
            '\n' +
            soul.content,
        });
      }
    } else if (cmd === '/verbose') {
      const next = !verbose;
      setVerbose(next);
      append({
        role: 'system',
        text: next
          ? 'verbose on — 后续轮内联展开 think / tool 详情（已显示的内容不变）'
          : 'verbose off — 后续轮 think / tool 降权为暗灰摘要',
      });
    } else if (cmd === '/skill' || cmd.startsWith('/skill ')) {
      const arg = cmd === '/skill' ? '' : cmd.slice('/skill '.length).trim();
      void handleSkill(arg);
    } else if (cmd === '/exit' || cmd === '/quit') {
      exit();
    } else {
      // 走到这里说明不是任何内置命令（内置已在上面优先匹配 → 系统命令永远胜过同名 skill）。
      // 尝试把 `/<name> [问题]` 解析成一个 skill 调用。
      const firstSpace = cmd.search(/\s/);
      const name = (firstSpace === -1 ? cmd : cmd.slice(0, firstSpace)).slice(1); // 去掉前导 '/'
      const question = firstSpace === -1 ? '' : cmd.slice(firstSpace + 1).trim();
      if (skillRegistry.has(name)) {
        invokeSkillByName(name, question);
      } else {
        append({ role: 'error', text: `Unknown command: ${cmd}` });
      }
    }
  };

  /**
   * `/skill`（无参）→ 列出已发现的 skill。
   * `/skill add <source>` / `/skill remove <name>` → REPL 内安装/卸载（热生效）。
   * `/skill <name> <问题>` → 调用某个 skill（等价于 /<name> <问题>）。
   */
  const handleSkill = async (arg: string): Promise<void> => {
    const firstSpace = arg.search(/\s/);
    const head = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : arg.slice(firstSpace + 1).trim();

    if (head === 'add') {
      // 解析可选的 --force（位置不限），其余 token 拼回 source。
      const tokens = rest.split(/\s+/).filter(Boolean);
      const force = tokens.includes('--force');
      const source = tokens.filter((t) => t !== '--force').join(' ');
      if (!source) {
        append({ role: 'error', text: 'Usage: /skill add <path | git-url | owner/repo> [--force]' });
        return;
      }
      await handleSkillAdd(source, force);
      return;
    }
    if (head === 'remove') {
      if (!rest) {
        append({ role: 'error', text: 'Usage: /skill remove <name>' });
        return;
      }
      handleSkillRemove(rest);
      return;
    }

    if (!arg) {
      const all = skillRegistry.list();
      if (all.length === 0) {
        append({
          role: 'system',
          text:
            'No skills installed.\nInstall with `/skill add <path | git-url | owner/repo>`,\n' +
            'or drop a <name>/SKILL.md under ' +
            config.skillDirs.map((d) => shortenHome(d)).join(' or ') +
            '.',
        });
        return;
      }
      const lines = all.map((s) => `  /${s.name}  —  ${s.description}`);
      append({
        role: 'system',
        text:
          'Installed skills (invoke with /<name> <your question>):\n' +
          lines.join('\n') +
          '\n\nManage: /skill add <source> · /skill remove <name>',
      });
      return;
    }
    // `/skill <name> <问题>`：复用 invokeSkillByName。
    invokeSkillByName(head, rest);
  };

  /**
   * REPL 内安装 skill：装完重新扫描 skillDirs 并 setSkillRegistry —— 触发
   * agent useMemo 重建，新 skill 的 catalog/slash 命令立即生效，无需重启。
   * 代价：与 /provider 切换同语义，会重置当前对话历史（agent 是新实例）。
   */
  const handleSkillAdd = async (source: string, force = false): Promise<void> => {
    try {
      const result = installSkillFromSource(source, config, { force });
      const reg = await buildSkillRegistry({ skillDirs: config.skillDirs });
      setSkillRegistry(reg); // 触发 agent 重建（热加载 + 对话重置）
      const parts = [`✓ installed skill "${result.skill.name}" → ${shortenHome(result.dest)}`];
      if (result.skill.commands.length > 0) {
        parts.push(
          `⚠ declares executable command(s): ${result.skill.commands.join(', ')} — ` +
            'the agent can run these after you approve them.',
        );
      }
      if (result.missingRequires.length > 0) {
        parts.push(
          `⚠ missing CLI(s) on PATH: ` +
            result.missingRequires
              .map((m) => (m.install ? `${m.bin} (install: ${m.install})` : m.bin))
              .join(', '),
        );
      }
      parts.push('（已重新加载 skill；本次安装重置了对话上下文）');
      append({ role: 'system', text: parts.join('\n') });
    } catch (err) {
      if (err instanceof SkillExistsError) {
        append({
          role: 'error',
          text: `${err.message}. 重装请加 --force：/skill add ${source} --force`,
        });
      } else {
        append({ role: 'error', text: `skill add failed: ${(err as Error).message}` });
      }
    }
  };

  const handleSkillRemove = (name: string): void => {
    const removed = removeSkillByName(name, config);
    if (!removed) {
      append({ role: 'error', text: `Skill not found: ${name}` });
      return;
    }
    void buildSkillRegistry({ skillDirs: config.skillDirs }).then((reg) => {
      setSkillRegistry(reg);
      append({
        role: 'system',
        text: `✓ removed skill "${name}"（已重新加载；对话上下文已重置）`,
      });
    });
  };

  /**
   * 调用一个具名 skill。供两条入口复用：动态 `/<name> <问题>` 与 `/skill <name> <问题>`。
   * 把 skill 正文压入上下文；带问题则立即走 handleSubmit 跑一轮（仅这轮生效），
   * 不带问题则等用户下一条输入（两步式）。
   */
  const invokeSkillByName = (name: string, question: string): void => {
    const skill = skillRegistry.get(name);
    if (!skill) {
      append({ role: 'error', text: `Unknown skill: ${name}. Try /skill to list installed ones.` });
      return;
    }
    agent.injectContext(`[Skill: ${skill.name}]\n\n${skill.body}`);
    if (question) {
      void handleSubmit(question);
    } else {
      append({
        role: 'system',
        text: `skill "${skill.name}" loaded — now type your request (or use /${skill.name} <question> in one line).`,
      });
    }
  };

  /**
   * /queue 处理：dashboard 看到 dead N 后能在 REPL 内直接处理。
   *
   * 子命令（无参 / dead → 列 dead 列表，是 dashboard 看到红色后最自然的下一步）：
   *   - (无参) | dead     列 dead jobs + 操作提示
   *   - status            完整计数 + 最近 events
   *   - retry-all         全部 dead → pending
   *   - retry <id>...     指定 id → pending（支持多个）
   *   - clear-dead        删除全部 dead 记录
   *
   * 写动作走独立 QueueStore：与 worker 同进程并发 mutate state.json，QueueStore
   * 注释保证最坏只丢 events 一条；dead/running 互不相交，job 字段层面安全。
   */
  const handleQueue = (arg: string): void => {
    const store = new QueueStore(config.queueStatePath);
    const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);

    if (!sub || sub === 'dead') {
      append({ role: 'system', text: formatDeadList(store.load(), config.queueLogDir) });
      return;
    }
    if (sub === 'status') {
      append({ role: 'system', text: formatQueueStatus(store.load()) });
      return;
    }
    if (sub === 'retry-all') {
      const r = resetDead(store);
      append({
        role: 'system',
        text: r.reset === 0 ? 'No dead jobs to retry.' : `Reset ${r.reset} dead job(s) → pending.`,
      });
      return;
    }
    if (sub === 'retry') {
      if (rest.length === 0) {
        append({
          role: 'error',
          text: 'Usage: /queue retry <id> [<id>...]  (or /queue retry-all)',
        });
        return;
      }
      const r = resetDead(store, rest);
      const parts: string[] = [];
      if (r.reset > 0) parts.push(`reset ${r.reset} → pending`);
      if (r.skipped.length) parts.push(`skipped: ${r.skipped.join(', ')}`);
      if (r.notFound.length) parts.push(`not found: ${r.notFound.join(', ')}`);
      append({ role: 'system', text: parts.join('  ·  ') || 'nothing to do' });
      return;
    }
    if (sub === 'clear-dead') {
      const { removed } = clearDead(store);
      append({
        role: 'system',
        text: removed === 0 ? 'No dead jobs to clear.' : `Cleared ${removed} dead job(s).`,
      });
      return;
    }
    append({
      role: 'error',
      text: `Unknown /queue subcommand: "${sub}". Try: /queue, /queue status, /queue retry-all, /queue retry <id>, /queue clear-dead`,
    });
  };

  /**
   * /provider 处理：
   *   - 无参 → 列出所有配置的 provider，标注当前激活、缺 key 的条目
   *   - 有参 → 校验 + 切换：setActiveProviderName 触发 useMemo 链重建
   *     （config → client → agent），相当于隐式 reset 对话——不同模型不该共享 history
   */
  const handleProvider = (arg: string): void => {
    const providers = initialConfig.providers;
    const names = Object.keys(providers);

    if (!arg) {
      if (names.length === 0) {
        append({
          role: 'system',
          text:
            'No providers configured. Add a "providers" map in ~/.pith-wiki/config.json. Example:\n' +
            '  {\n' +
            '    "providers": {\n' +
            '      "deepseek": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },\n' +
            '      "qwen":     { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "apiKeyEnv": "DASHSCOPE_API_KEY" }\n' +
            '    },\n' +
            '    "activeProvider": "deepseek"\n' +
            '  }',
        });
        return;
      }
      const lines = names.map((n) => {
        const e = providers[n];
        const r = resolveProviderEntry(e);
        const marker = n === activeProviderName ? '* ' : '  ';
        const keyNote = r.apiKey ? '' : ' (no key — set apiKey or apiKeyEnv)';
        return `${marker}${n}  →  model=${e.model}  baseURL=${e.baseURL}${keyNote}`;
      });
      append({
        role: 'system',
        text:
          `providers (* = active):\n${lines.join('\n')}\n` +
          `\nUse "/provider <name>" to switch. Switching resets the conversation.`,
      });
      return;
    }

    if (!(arg in providers)) {
      append({
        role: 'error',
        text: `Unknown provider: "${arg}". Configured: ${names.join(', ') || '(none)'}`,
      });
      return;
    }
    const resolved = resolveProviderEntry(providers[arg]);
    if (!resolved.apiKey) {
      const envHint = providers[arg].apiKeyEnv
        ? ` (set env ${providers[arg].apiKeyEnv})`
        : ' (set "apiKey" or "apiKeyEnv" in config)';
      append({
        role: 'error',
        text: `Cannot switch to "${arg}": no API key resolved${envHint}.`,
      });
      return;
    }
    if (arg === activeProviderName) {
      append({ role: 'system', text: `already on "${arg}"; nothing to switch` });
      return;
    }

    setActiveProviderName(arg);
    // 显式 reset agent 之外的状态：messages 清屏、usage 计数清零。
    // agent 本身会随 useMemo 链重建（client / activeConfig 变化 → 新 Agent 实例）。
    setMessages([
      {
        id: nextId(),
        role: 'system',
        text: `switched to provider "${arg}" (model=${resolved.model}). conversation reset.`,
      },
    ]);
    setUsage({ inputTokens: 0, outputTokens: 0 });
  };

  /**
   * /digest 处理：
   *   1. 抓 agent 当前对话快照（自上次 /reset）
   *   2. 喂给 HydrationService.hydrate，落进 wiki 的 digestCollection
   *   3. 落库后把新 entry id / 路径告诉用户；transcript 也记一行
   * 不会 reset agent —— 摘要后用户可能还想继续聊。
   * 期间设 inFlight=true 防止用户并发触发；hydrate 不支持 abort，所以
   * Ctrl-C 不会取消（这点跟普通对话不同，一次 hydrate 通常 1-3s 可接受）。
   */
  const handleDigest = async (rawArg: string) => {
    const collection = rawArg.trim() || config.digestCollection;
    if (!agent.hasContent()) {
      append({
        role: 'error',
        text: 'no conversation to digest yet (try after at least one user/assistant turn)',
      });
      return;
    }
    const snapshot = agent.snapshot();
    if (!snapshot) {
      append({ role: 'error', text: 'conversation snapshot is empty' });
      return;
    }
    append({
      role: 'system',
      text: `digesting current conversation into collection "${collection}"…`,
    });
    setInFlight(true);
    try {
      ensureWikiRoot(config);
      // 复用 session 共享的 library —— 写入立即被 agent 后续的 wiki_query/list 看到，
      // 也共用同一份 index.json 的写入节流，不会和 worker 互相覆盖。
      const hydrator = new HydrationService(client, config.model, library, config.supportsJsonMode);
      const entry = await hydrator.hydrate({
        rawContent: snapshot,
        collectionId: collection,
        autoLink: true,
        source: { type: 'inline' },
        // 关键：对话模式 — 让 hydrator 用 CONVERSATION_SYSTEM_PROMPT，强制保留
        // 问题视角，避免"成长与低谷期"被笼统压成"成长经历"
        mode: 'conversation',
      });
      const saved = library.put(entry);
      const filePath = path.join(config.wikiRoot, saved.collection, `${saved.id}.md`);
      const summary = `digest saved: ${saved.id} (collection=${saved.collection})\n  title: ${saved.title}\n  tags: ${saved.tags.join(', ') || '(none)'}\n  links: ${saved.links.join(', ') || '(none)'}\n  path: ${filePath}`;
      append({ role: 'system', text: summary });
      transcript?.recordSystem(`digest saved as ${saved.id} in ${saved.collection} (${filePath})`);
    } catch (err) {
      append({ role: 'error', text: `digest failed: ${(err as Error).message}` });
    } finally {
      setInFlight(false);
    }
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // 兜底刷盘：即使关掉了 auto-queue（上面的 effect 不跑），用户依然可能通过
      // /digest 或 wiki_ingest 工具往 library 写过东西。退出前同步落 index.json。
      try {
        library.flushIndex();
      } catch {
        // best-effort
      }
    };
  }, [library]);

  return (
    <Box flexDirection="column">
      <ChatView messages={messages} inFlight={inFlight && !approval} activity={activity} />
      {approval ? <ToolApproval request={approval} /> : null}
      <Box flexDirection="column">
        <TokenMeter inputTokens={usage.inputTokens} outputTokens={usage.outputTokens} />
        {/* dead 不再主动浮到对话流刷屏：status bar 显示计数 + 提示，按需 /queue dead 查询。 */}
        <StatusBar
          statePath={config.queueStatePath}
          worker={queueWorkerStatus}
          watchedTargets={config.watchAutoStart ? config.watchDirs.length : 0}
          totalWatchDirs={config.watchDirs.length}
        />
        <InputBox
          disabled={inFlight || approval !== null}
          onSubmit={handleSubmit}
          history={history}
          mentionTree={mentionTree}
          extraCommands={skillCommands}
        />
      </Box>
      {config.readOnly ? <Text color="gray">read-only mode</Text> : null}
    </Box>
  );
}

/** 历史浏览容量：上下键最多回溯多少条。文件本身不限大小，仅加载尾部。 */
const HISTORY_LIMIT = 20;

function truncateJson(args: unknown): string {
  // JSON.stringify(undefined) → undefined（非字符串）；unknown-tool 路径会传 undefined。
  const json = JSON.stringify(args) ?? '';
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

/** verbose 模式下把多行内容缩进 2 空格，挂在过程档标题行下面。 */
function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** 显示路径时把 `<homedir>/...` 压缩成 `~/...`，让 dashboard 一行装得下。 */
function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

