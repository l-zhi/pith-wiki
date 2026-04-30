import path from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import OpenAI from 'openai';
import { Agent, AgentError } from '../llm/agent.js';
import { buildContext } from '../tools/index.js';
import { ensureOutputDir, ensureQueueDirs, ensureWikiRoot, type Config } from '../config.js';
import { ChatView, DisplayMessage } from './ChatView.js';
import { InputBox } from './InputBox.js';
import { ToolApproval, ApprovalRequest } from './ToolApproval.js';
import { TokenMeter } from './TokenMeter.js';
import { appendHistory, loadHistory } from './history.js';
import { QueueIndicator, type QueueWorkerStatus } from './QueueIndicator.js';
import { SLASH_COMMANDS } from './slashCommands.js';
import { TranscriptLogger, deriveTranscriptPath } from './transcript.js';
import { QueueLockedError, QueueStore } from '../wiki/queue/store.js';
import { runQueue } from '../wiki/queue/runner.js';
import { runWatcher } from '../wiki/queue/watcher.js';
import { LibraryService } from '../wiki/library.js';
import { HydrationService } from '../wiki/hydration.js';

interface Props {
  config: Config;
  client: OpenAI;
}

export function App({ config, client }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([
    {
      id: 'welcome',
      role: 'system',
      text:
        `llm-wiki ready. model=${config.model} root=${config.workspaceRoot}\n` +
        `Type "/" for command suggestions (Tab completes). Ctrl+C cancels in-flight; press twice to exit.` +
        (config.transcriptEnabled
          ? `\ntranscript on (use /transcript to see path)`
          : '\ntranscript off'),
    },
  ]);
  const [inFlight, setInFlight] = useState(false);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // 历史命令：启动时从 ~/.llm-wiki/history 加载最近 N 条；每次提交追加。
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
  // watcher 状态：仅展示给 QueueIndicator 用。watcher 自身不取队列锁，
  // 失败也只影响监听这一条线，不阻塞队列消费，因此用独立状态字段。
  const [watchStatus, setWatchStatus] = useState<{
    targets: number;
    error?: string;
  }>(() => ({
    targets: config.watchAutoStart ? config.watchDirs.length : 0,
  }));

  // 整个 REPL session 共用一份 LibraryService。
  // 关键不变量：agent 的工具（wiki_query / wiki_list / wiki_get / wiki_read_source /
  // /digest 的 hydrator）和后台 queue worker / watcher 都通过同一个 library 写读，
  // in-memory cache 天然同步。worker 刚 ingest 的新条目，下一秒 wiki_list 就能看到；
  // index.json 也只有一个 owner 在写，不会两份 cache 互相覆盖。
  const library = useMemo(() => new LibraryService(config.wikiRoot), [config.wikiRoot]);

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
        return; // 不起 worker，但 QueueIndicator 仍会 poll 状态展示
      }
      setQueueWorkerStatus({ mode: 'error', error: (err as Error).message });
      return;
    }

    const ac = new AbortController();
    const hydrator = new HydrationService(client, config.model, library);

    const workerPromise = runQueue({
      store,
      hydrator,
      library,
      concurrency: config.queueConcurrency,
      maxAttempts: config.queueMaxAttempts,
      backoffMs: [5_000, 30_000, 120_000],
      logDir: config.queueLogDir,
      signal: ac.signal,
      // REPL 内 worker 不打控制台 log（会污染对话视图）；进度看底部 QueueIndicator
      // 和 ~/.llm-wiki/queue/logs/<jobId>.log。
      log: () => {},
      idleBehavior: 'wait',
    }).catch((err: Error) => {
      setQueueWorkerStatus({ mode: 'error', error: err.message });
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
        // REPL 内 watcher 不打控制台 log（会污染对话视图）。事件可在 state.json 的
        // events 环里看到（kind='enqueued' msg='watcher:add/change/initial-scan'）。
        log: () => {},
      }).catch((err: Error) => {
        setWatchStatus((prev) => ({ ...prev, error: err.message }));
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
    // 共用的 library 透传进 toolCtx；wiki_* 工具就和 worker / watcher 看到同一份索引。
    const ctx = buildContext(config, client, requestApproval, library);
    return new Agent(client, config.model, ctx);
  }, [config, client, requestApproval, library]);

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
    } else if (cmd === '/exit' || cmd === '/quit') {
      exit();
    } else {
      append({ role: 'error', text: `Unknown command: ${cmd}` });
    }
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
        <QueueIndicator
          statePath={config.queueStatePath}
          workerStatus={queueWorkerStatus}
          watchStatus={watchStatus}
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
