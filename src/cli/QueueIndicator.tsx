import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { QueueStore } from '../wiki/queue/store.js';
import type { QueueState } from '../wiki/queue/state.js';

export interface QueueWorkerStatus {
  /** 'self'：本进程持锁、正在跑 worker；'external'：另一个进程持锁、本 REPL 只读状态；
   *  'off'：用户用 --no-auto-queue 关掉了；'error'：起 worker 失败，详情在 error 字段 */
  mode: 'self' | 'external' | 'off' | 'error';
  error?: string;
  /** external 模式下持锁的对方 pid，仅供显示。 */
  externalPid?: number;
}

interface Props {
  statePath: string;
  workerStatus: QueueWorkerStatus;
  /** 多久 poll 一次状态。默认 2s，UI 刷新成本可忽略。 */
  pollMs?: number;
}

/**
 * REPL 底部一行的队列状态指示器。
 * 自己 poll state.json，与 worker 解耦——即使 worker 起在另一个终端也能正常显示。
 */
export function QueueIndicator({ statePath, workerStatus, pollMs = 2000 }: Props) {
  const [state, setState] = useState<QueueState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const store = new QueueStore(statePath);
    let alive = true;
    function tick(): void {
      if (!alive) return;
      try {
        setState(store.load());
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message);
      }
    }
    tick(); // 立即跑一次，避免空白
    const handle = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [statePath, pollMs]);

  if (loadError) {
    return (
      <Box>
        <Text color="red">queue: read error — {loadError}</Text>
      </Box>
    );
  }
  if (!state) {
    return (
      <Box>
        <Text color="gray">queue: loading…</Text>
      </Box>
    );
  }

  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    dead: 0,
  };
  for (const j of Object.values(state.jobs)) counts[j.status] += 1;

  const modeLabel = (() => {
    switch (workerStatus.mode) {
      case 'self':
        return <Text color="green">worker</Text>;
      case 'external':
        return (
          <Text color="cyan">
            external worker
            {workerStatus.externalPid ? ` (pid=${workerStatus.externalPid})` : ''}
          </Text>
        );
      case 'off':
        return <Text color="gray">auto-queue off</Text>;
      case 'error':
        return <Text color="red">worker error</Text>;
    }
  })();

  return (
    <Box>
      <Text color="gray">queue: </Text>
      {modeLabel}
      <Text color="gray">
        {' · '}
        <Text color="cyan">{counts.pending}</Text> pending ·{' '}
        <Text color="yellow">{counts.running}</Text> running ·{' '}
        <Text color="green">{counts.completed}</Text> done
        {counts.dead > 0 ? (
          <>
            {' · '}
            <Text color="red">{counts.dead}</Text> dead
          </>
        ) : null}
      </Text>
      {workerStatus.mode === 'error' && workerStatus.error ? (
        <Text color="red"> — {workerStatus.error}</Text>
      ) : null}
    </Box>
  );
}
