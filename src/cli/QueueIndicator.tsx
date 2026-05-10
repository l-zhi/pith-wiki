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

/**
 * 简化的 watcher 状态：只展示当前监听的 target 数量 + 是否报错。
 * watcher 不取锁、不影响队列消费，所以不需要复杂状态机。
 */
export interface WatchStatusSummary {
  /** 当前活跃 target 数量；0 = 未起 watcher（含未配置 / autoWatch=off）。 */
  targets: number;
  error?: string;
}

interface Props {
  statePath: string;
  workerStatus: QueueWorkerStatus;
  /** 可选 watcher 状态。CLI 模式下可不传。 */
  watchStatus?: WatchStatusSummary;
  /** 多久 poll 一次状态。默认 2s，UI 刷新成本可忽略。 */
  pollMs?: number;
}

/**
 * REPL 底部一行的队列状态指示器。
 * 自己 poll state.json，与 worker 解耦——即使 worker 起在另一个终端也能正常显示。
 */
export function QueueIndicator({ statePath, workerStatus, watchStatus, pollMs = 2000 }: Props) {
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

  // mode 列：值文本 + 显示色。列宽自适应（mode 文本长度参差，统一打成 column flex）
  const modeCell = (() => {
    switch (workerStatus.mode) {
      case 'self':
        return { value: 'self', color: 'green' as const };
      case 'external':
        return {
          value: `external${workerStatus.externalPid ? ` (pid=${workerStatus.externalPid})` : ''}`,
          color: 'cyan' as const,
        };
      case 'off':
        return { value: 'off', color: 'gray' as const };
      case 'error':
        return { value: 'error', color: 'red' as const };
    }
  })();

  // 数值列零值用 dim 色，让有意义的数字突出，不再"全是数字看不清重点"
  const numCell = (n: number, color: 'cyan' | 'yellow' | 'green' | 'red' | 'magenta') =>
    n === 0
      ? { value: '0', color: 'gray' as const }
      : { value: String(n), color };

  // 6 列固定顺序，标题/值同列号 → 用相同 minWidth 自然对齐
  const cols: Array<{
    header: string;
    value: string;
    color: 'gray' | 'cyan' | 'yellow' | 'green' | 'red' | 'magenta';
    width: number;
  }> = [
    { header: 'mode', ...modeCell, width: Math.max(6, modeCell.value.length) },
    { header: 'pending', ...numCell(counts.pending, 'cyan'), width: 8 },
    { header: 'running', ...numCell(counts.running, 'yellow'), width: 8 },
    { header: 'done', ...numCell(counts.completed, 'green'), width: 6 },
    { header: 'dead', ...numCell(counts.dead, 'red'), width: 5 },
    {
      header: 'watch',
      value: watchStatus ? String(watchStatus.targets) : '0',
      color: watchStatus?.error
        ? 'red'
        : !watchStatus || watchStatus.targets === 0
          ? 'gray'
          : 'magenta',
      width: 6,
    },
  ];

  return (
    <Box flexDirection="column">
      {/* 标题行 */}
      <Box>
        <Text color="gray">queue  </Text>
        {cols.map((c, i) => (
          <Box key={`h-${i}`} width={c.width} marginRight={1}>
            <Text dimColor>{c.header}</Text>
          </Box>
        ))}
      </Box>
      {/* 数值行 */}
      <Box>
        <Text color="gray">       </Text>
        {cols.map((c, i) => (
          <Box key={`v-${i}`} width={c.width} marginRight={1}>
            <Text color={c.color}>{c.value}</Text>
          </Box>
        ))}
        {workerStatus.mode === 'error' && workerStatus.error ? (
          <Text color="red"> — {workerStatus.error}</Text>
        ) : null}
        {watchStatus?.error ? (
          <Text color="red"> watch err: {watchStatus.error}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
