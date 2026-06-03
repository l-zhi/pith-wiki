import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { loadQueueDigest } from './dashboardData.js';

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

function countsEqual(a: Counts | null, b: Counts | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.pending === b.pending &&
    a.running === b.running &&
    a.completed === b.completed &&
    a.dead === b.dead
  );
}

function StatusBarImpl({
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
        const digest = loadQueueDigest(statePath);
        // 等值判断：每 tick 都重建一个 sum 对象，setCounts 看引用变化会重渲；
        // 实际数字没变时直接 noop，避免在 worker 空转的稳态下 2s 一次的无意义
        // re-render。这种重渲在终端尺寸偏紧时会被 Ink 当作新行写进 scrollback，
        // 表现为同一行 status bar 不停堆叠刷屏。
        setCounts((prev) => (countsEqual(prev, digest.counts) ? prev : digest.counts));
        setReadErr((prev) => (prev === null ? prev : null));
      } catch (err) {
        const msg = (err as Error).message;
        setReadErr((prev) => (prev === msg ? prev : msg));
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
      <PinnedRows>
        <Text color={C.pink}>queue: read error — {readErr}</Text>
      </PinnedRows>
    );
  }
  if (!counts) {
    return (
      <PinnedRows>
        <Text dimColor>queue: loading…</Text>
      </PinnedRows>
    );
  }

  const workerMode = renderMode(worker);
  const isWorking = counts.running > 0;
  const isError = worker.mode === 'error' || counts.dead > 0;
  const totalKnown = counts.pending + counts.running + counts.completed + counts.dead;
  const pct = totalKnown ? Math.round((100 * counts.completed) / totalKnown) : null;

  return (
    <PinnedRows>
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
          // 故意不用 ink-spinner：它默认 80ms 转一次帧，触发 StatusBar 每秒
          // ~12 次重渲，Ink 在重渲跟不上时会把每帧追加到 scrollback，
          // 表现为 status bar 在终端里疯狂刷屏堆叠。
          // 改用静态 ● 加 amber 上色：counts.running 数字本身随 worker 推进
          // 而变化就是最准的"还在动"信号，不需要再叠一层 spinner 动画。
          <>
            <Text color={C.amber}>● </Text>
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
      {/* 第二行：worker 错误优先（进程级失败，必须显眼）。dead 的具体错误日志
          不再主动展示——按需用 /queue dead 查询列表（完整堆栈在 queue/logs/<id>.log）。
          这里只留一条安静的查询提示，避免错误文本在 status bar 反复刷脸。
          两者都没就让 PinnedRows 的 minHeight 顶住空行，避免布局抖动。 */}
      {worker.mode === 'error' && worker.error ? (
        <Box>
          <Text color={C.pink}>worker: {worker.error}</Text>
        </Box>
      ) : counts.dead > 0 ? (
        <Box>
          <Text dimColor>dead {counts.dead} — /queue dead to list</Text>
        </Box>
      ) : null}
    </PinnedRows>
  );
}

/**
 * 锁 live 区高度 = 2 行的容器。
 *
 * 出现"长空白"的根因之一是 StatusBar 在不同状态下高度会变（worker error 多一行、
 * loading / readErr 只占一行、正常态一行）。每次高度变化都让 Ink 在重画时多/少
 * 擦一行；若同时 inFlight spinner / approval / slash 提示也在变，cursor 漂移就
 * 会在 scrollback 里留下空行。
 *
 * 用 minHeight=2 把所有分支统一到 2 行物理高度：极少数情况下 worker error 文本
 * 会被截断，但比"对话区上面留几屏空白"代价小得多。worker error 同时也会通过
 * setQueueWorkerStatus 触发一条独立的 system message，全文进 scrollback，不丢信息。
 */
function PinnedRows({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="column" minHeight={2}>
      {children}
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

/**
 * 浅比较 props：父组件（App）每次任意 state 变化都会重渲整棵子树，但 StatusBar
 * 自己的展示只关心 statePath / pollMs / worker / watched* 这几样。memo 后只要
 * 这些值未变就跳过整次渲染 —— 大幅减少 Ink 重绘次数，配合内部 setCounts 的等值
 * 判断把"刷屏 bug"双保险地堵掉。
 *
 * worker 是个对象，引用比较：父组件用 useState 维护它，没 setQueueWorkerStatus
 * 就引用稳定；arePropsEqual 显式比对字段，避免父组件偶尔传新对象引用导致漏命中。
 */
function arePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.statePath === next.statePath &&
    prev.pollMs === next.pollMs &&
    prev.watchedTargets === next.watchedTargets &&
    prev.totalWatchDirs === next.totalWatchDirs &&
    prev.worker.mode === next.worker.mode &&
    prev.worker.error === next.worker.error &&
    prev.worker.externalPid === next.worker.externalPid
  );
}

export const StatusBar = React.memo(StatusBarImpl, arePropsEqual);
