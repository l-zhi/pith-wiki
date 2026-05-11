import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { loadQueueCounts } from './dashboardData.js';

/**
 * 底部常驻的 1 行 live status bar。
 *
 * Dashboard 是启动快照（写进 `<Static>` 进 scrollback，不会 re-render），所以
 * 需要这一行来反映 queue 进展。每 `pollMs` 读一次 `state.json`，按总和展示：
 *
 *   queue self · pend 3 · ⠏ 1 run · done 84 · dead 10  · watch 5/7 · 89%
 *
 * 三态视觉（对齐设计稿 status bar showcase）：
 *   - idle    pending+running=0 → 灰底 + "idle"
 *   - working running>0          → amber spinner + 高亮 running
 *   - error   worker.mode='error' 或 dead>0 → pink 警示
 *
 * 这里不做"重试倒计时"这种花活，按需在后续 PR 里加。
 */

export interface QueueWorkerStatus {
  mode: 'self' | 'external' | 'off' | 'error';
  error?: string;
  externalPid?: number;
}

const C = {
  green: '#34d399',
  cyan: '#67e8f9',
  amber: '#fbbf24',
  pink: '#f472b6',
} as const;

interface Props {
  statePath: string;
  worker: QueueWorkerStatus;
  /** 用于 watch 列右侧的 "N/M"：M = 已配置 watchDir 数，N = 当前活跃数。 */
  watchedTargets?: number;
  totalWatchDirs?: number;
  pollMs?: number;
}

interface Counts {
  pending: number;
  running: number;
  completed: number;
  dead: number;
}

export function StatusBar({
  statePath,
  worker,
  watchedTargets,
  totalWatchDirs,
  pollMs = 2000,
}: Props) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    function tick(): void {
      if (!alive) return;
      try {
        // loadQueueCounts 已按 collection 分组，这里把所有 collection 合并求总和
        const grouped = loadQueueCounts(statePath);
        const sum: Counts = { pending: 0, running: 0, completed: 0, dead: 0 };
        for (const v of grouped.values()) {
          sum.pending += v.pending;
          sum.running += v.running;
          sum.completed += v.completed;
          sum.dead += v.dead;
        }
        setCounts(sum);
        setReadErr(null);
      } catch (err) {
        setReadErr((err as Error).message);
      }
    }
    tick();
    const handle = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [statePath, pollMs]);

  if (readErr) {
    return (
      <Box>
        <Text color={C.pink}>queue: read error — {readErr}</Text>
      </Box>
    );
  }
  if (!counts) {
    return (
      <Box>
        <Text dimColor>queue: loading…</Text>
      </Box>
    );
  }

  const workerMode = renderMode(worker);
  const isWorking = counts.running > 0;
  const isError = worker.mode === 'error' || counts.dead > 0;
  const totalKnown = counts.pending + counts.running + counts.completed + counts.dead;
  const pct = totalKnown ? Math.round((100 * counts.completed) / totalKnown) : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>queue </Text>
        <Text color={workerMode.color}>{workerMode.value}</Text>
        <Sep />

        {/* idle 态：完全没活儿就标注一下 */}
        {!isWorking && counts.pending === 0 && counts.dead === 0 ? (
          <>
            <Text dimColor>idle</Text>
            <Sep />
          </>
        ) : null}

        <Text dimColor>pend </Text>
        <NumOrDot n={counts.pending} />
        <Sep />

        {isWorking ? (
          <>
            <Text color={C.amber}>
              <Spinner type="dots" />{' '}
            </Text>
            <Text color={C.amber}>{counts.running} run</Text>
          </>
        ) : (
          <>
            <Text dimColor>run </Text>
            <Text dimColor>·</Text>
          </>
        )}
        <Sep />

        <Text dimColor>done </Text>
        {counts.completed > 0 ? (
          <Text color={C.green}>{counts.completed}</Text>
        ) : (
          <Text dimColor>·</Text>
        )}
        <Sep />

        <Text dimColor>dead </Text>
        {counts.dead > 0 ? (
          <Text color={C.pink}>{counts.dead}</Text>
        ) : (
          <Text dimColor>·</Text>
        )}

        {typeof watchedTargets === 'number' && typeof totalWatchDirs === 'number' ? (
          <>
            <Sep />
            <Text dimColor>watch </Text>
            <Text color={watchedTargets > 0 ? C.cyan : undefined} dimColor={watchedTargets === 0}>
              {watchedTargets}
            </Text>
            <Text dimColor>/{totalWatchDirs}</Text>
          </>
        ) : null}

        {pct !== null ? (
          <>
            <Sep />
            <Text color={isError ? C.pink : isWorking ? C.amber : C.green}>{pct}%</Text>
          </>
        ) : null}
      </Box>
      {worker.mode === 'error' && worker.error ? (
        <Box>
          <Text color={C.pink}>worker: {worker.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Sep() {
  return <Text dimColor>{'  ·  '}</Text>;
}

function NumOrDot({ n }: { n: number }) {
  return n > 0 ? <Text>{n}</Text> : <Text dimColor>·</Text>;
}

function renderMode(w: QueueWorkerStatus): { value: string; color: string | undefined } {
  switch (w.mode) {
    case 'self':
      return { value: 'self', color: C.green };
    case 'external':
      return {
        value: w.externalPid ? `external pid=${w.externalPid}` : 'external',
        color: C.cyan,
      };
    case 'off':
      return { value: 'off', color: undefined };
    case 'error':
      return { value: 'error', color: C.pink };
  }
}
