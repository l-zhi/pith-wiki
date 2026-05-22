import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Agent, AgentError, defaultSystemPrompt } from '../llm/agent.js';
import { createClient } from '../llm/client.js';
import { composeSystemPrompt, loadSoul, type LoadedSoul } from '../llm/soul.js';
import { buildContext } from '../tools/index.js';
import {
  ensureOutputDir,
  ensureQueueDirs,
  ensureWikiRoot,
  resolveProviderEntry,
  type Config,
} from '../config.js';
import { ChatView, DisplayMessage } from './ChatView.js';
import { InputBox } from './InputBox.js';
import { ToolApproval, ApprovalRequest } from './ToolApproval.js';
import { TokenMeter } from './TokenMeter.js';
import { appendHistory, loadHistory } from './history.js';
import { StatusBar, type QueueWorkerStatus } from './StatusBar.js';
import { SLASH_COMMANDS } from './slashCommands.js';
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
import { clearDead, formatDeadList, formatQueueStatus, resetDead } from './queueOps.js';

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
        `llm-wiki ready. model=${config.model} root=${config.workspaceRoot}` +
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
  const library = useMemo(() => new LibraryService(config.wikiRoot), [config.wikiRoot]);

  // 转换器注册表 + 结果缓存：整个 REPL session 共用一份。
  // worker / watcher / agent 工具上下文都拿同一份；watcher 据此动态生成 chokidar glob，
  // /converters slash 据此打表。
  const converters = useMemo(
    () => buildConverterPipeline({ wikiRoot: config.wikiRoot, cacheConverted: config.cacheConverted }),
    [config.wikiRoot, config.cacheConverted],
  );

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
    const hydrator = new HydrationService(client, config.model, library);

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
    () =>
      (path: string, preview: string) =>
        new Promise<'yes' | 'no' | 'always'>((resolve) => {
          setApproval({
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
    });
    const systemPrompt = composeSystemPrompt(defaultSystemPrompt, soul);
    return new Agent(client, config.model, ctx, { systemPrompt });
  }, [config, client, requestApproval, library, converters, soul]);

  const append = (msg: Omit<DisplayMessage, 'id'>) =>
    setMessages((prev) => [...prev, { ...msg, id: nextId() }]);

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

    append({ role: 'user', text: trimmed });
    transcript?.recordUser(trimmed);
    const ac = new AbortController();
    abortRef.current = ac;
    setInFlight(true);
    try {
      await agent.send(trimmed, {
        signal: ac.signal,
        events: {
          onAssistantText: (text) => {
            append({ role: 'assistant', text });
            transcript?.recordAssistant(text);
          },
          onToolCall: ({ name, args }) => {
            append({
              role: 'tool',
              text: `→ ${name}(${truncateJson(args)})`,
            });
            transcript?.recordToolCall(name, args);
          },
          onToolResult: ({ name, ok, preview }) => {
            append({
              role: 'tool',
              text: `${ok ? '✓' : '✗'} ${name}: ${preview}`,
            });
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
            'or ' + path.join(config.workspaceRoot, 'SOUL.md') + ' (project-local),\n' +
            'or set PITH_WIKI_SOUL=<path>. Restart REPL to apply.',
        });
      } else {
        append({
          role: 'system',
          text:
            `soul sources:\n  ${soul.sources.map((p) => shortenHome(p)).join('\n  ')}\n\n` +
            '─'.repeat(40) + '\n' +
            soul.content,
        });
      }
    } else if (cmd === '/exit' || cmd === '/quit') {
      exit();
    } else {
      append({ role: 'error', text: `Unknown command: ${cmd}` });
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
      append({ role: 'system', text: formatDeadList(store.load()) });
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
        append({ role: 'error', text: 'Usage: /queue retry <id> [<id>...]  (or /queue retry-all)' });
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
      append({ role: 'error', text: 'no conversation to digest yet (try after at least one user/assistant turn)' });
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
      const hydrator = new HydrationService(client, config.model, library);
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
      <ChatView messages={messages} inFlight={inFlight && !approval} />
      {approval ? <ToolApproval request={approval} /> : null}
      <Box flexDirection="column">
        <TokenMeter inputTokens={usage.inputTokens} outputTokens={usage.outputTokens} />
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
        />
      </Box>
      {config.readOnly ? <Text color="gray">read-only mode</Text> : null}
    </Box>
  );
}

/** 历史浏览容量：上下键最多回溯多少条。文件本身不限大小，仅加载尾部。 */
const HISTORY_LIMIT = 20;

function truncateJson(args: unknown): string {
  const json = JSON.stringify(args);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

/** 显示路径时把 `<homedir>/...` 压缩成 `~/...`，让 dashboard 一行装得下。 */
function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
