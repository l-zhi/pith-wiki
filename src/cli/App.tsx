import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import OpenAI from 'openai';
import { Agent, AgentError } from '../llm/agent.js';
import { buildContext } from '../tools/index.js';
import type { Config } from '../config.js';
import { ChatView, DisplayMessage } from './ChatView.js';
import { InputBox } from './InputBox.js';
import { ToolApproval, ApprovalRequest } from './ToolApproval.js';
import { TokenMeter } from './TokenMeter.js';
import { appendHistory, loadHistory } from './history.js';

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
      text: `llm-wiki ready. model=${config.model} root=${config.workspaceRoot}\nType /help for commands. Ctrl+C cancels in-flight; press twice to exit.`,
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

  const agent = useMemo(() => {
    const ctx = buildContext(config, client, requestApproval);
    return new Agent(client, config.model, ctx);
  }, [config, client, requestApproval]);

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
    const ac = new AbortController();
    abortRef.current = ac;
    setInFlight(true);
    try {
      await agent.send(trimmed, {
        signal: ac.signal,
        events: {
          onAssistantText: (text) => append({ role: 'assistant', text }),
          onToolCall: ({ name, args }) =>
            append({
              role: 'tool',
              text: `→ ${name}(${truncateJson(args)})`,
            }),
          onToolResult: ({ name, ok, preview }) =>
            append({
              role: 'tool',
              text: `${ok ? '✓' : '✗'} ${name}: ${preview}`,
            }),
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
        append({ role: 'error', text: `[${err.kind}] ${err.message}` });
      } else {
        append({ role: 'error', text: (err as Error).message });
      }
    } finally {
      abortRef.current = null;
      setInFlight(false);
    }
  };

  const handleSlashCommand = (cmd: string) => {
    if (cmd === '/help') {
      append({
        role: 'system',
        text:
          'Slash commands: /help · /clear · /reset · /exit\n' +
          `Up/Down arrows browse the last ${HISTORY_LIMIT} commands.\n` +
          'Tools: read_file, write_file, list_dir, wiki_ingest, wiki_get, wiki_query',
      });
    } else if (cmd === '/clear') {
      setMessages([{ id: nextId(), role: 'system', text: 'screen cleared' }]);
    } else if (cmd === '/reset') {
      agent.reset();
      setMessages([{ id: nextId(), role: 'system', text: 'conversation reset' }]);
    } else if (cmd === '/exit' || cmd === '/quit') {
      exit();
    } else {
      append({ role: 'error', text: `Unknown command: ${cmd}` });
    }
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <Box flexDirection="column">
      <ChatView messages={messages} inFlight={inFlight && !approval} />
      {approval ? <ToolApproval request={approval} /> : null}
      <Box flexDirection="column">
        <TokenMeter inputTokens={usage.inputTokens} outputTokens={usage.outputTokens} />
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
