import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import os from 'node:os';
import path from 'node:path';
import type { DashboardData, CollectionRow, WatchRow } from './dashboardData.js';
import { visualWidth } from './dashboardData.js';

/**
 * REPL 启动 dashboard 的 Ink 渲染。
 *
 * 三段：
 *   1. TopBanner —— `● ready` + provider/model/root pill
 *   2. WatchLines —— 每个 watchDir 一行（路径 + 文件数 + collection 描述），尾部一行 exts
 *   3. UnifiedTable —— 按 collection 聚合的 8 列表格，含 ASCII 进度条 + watch 指示符 + 总计行
 *
 * 颜色口径对齐 design palette：
 *   green=done/ready · cyan=watch/system · amber=running/exts · pink/red=dead · purple=brand
 *
 * 用 Ink Box 的 flex 引擎按列布局：CJK 自动算 2 列；数字列 justifyContent="flex-end"。
 * 纯文本兜底（formatDashboard）见 dashboardData.ts，给 CLI `llm-wiki status` 和 transcript 用。
 */

/** 进程级队列 worker 状态，只在 REPL 模式下传入；CLI 子命令 `status` 不传 → 不渲染该 pill。 */
export interface WorkerInfo {
  mode: 'self' | 'external' | 'off' | 'error';
  externalPid?: number;
  error?: string;
}

interface Props {
  data: DashboardData;
  worker?: WorkerInfo;
}

// design palette → ink color name（ink 走 truecolor 时用 hex，否则 16 色 fallback）
const C = {
  green: '#34d399',
  cyan: '#67e8f9',
  amber: '#fbbf24',
  pink: '#f472b6',
  purple: '#a78bfa',
} as const;

const NUM_COL_W = 8;
const WATCH_COL_W = 7;

export function Dashboard({ data, worker }: Props) {
  return (
    <Box flexDirection="column">
      <TopBanner
        ready={data.ready}
        provider={data.provider}
        model={data.model}
        wikiRoot={data.wikiRoot}
        worker={worker}
      />
      <Box marginTop={1}>
        <WatchLines rows={data.watchDirs} extensions={data.registeredExtensions} />
      </Box>
      <Box marginTop={1}>
        <UnifiedTable rows={data.collections} />
      </Box>
    </Box>
  );
}

/* ───────────────────────── Top banner ───────────────────────── */

function TopBanner({
  ready,
  provider,
  model,
  wikiRoot,
  worker,
}: {
  ready: boolean;
  provider: string;
  model: string;
  wikiRoot: string;
  worker?: WorkerInfo;
}) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        <Box marginRight={3}>
          <Text color={ready ? C.green : C.pink}>● {ready ? 'ready' : 'not ready'}</Text>
        </Box>
        <Pill k="model" v={model} />
        <Pill k="provider" v={provider} />
        {worker ? <ModePill worker={worker} /> : null}
        <Pill k="root" v={shortPath(wikiRoot)} />
      </Box>
      {worker?.mode === 'error' && worker.error ? (
        <Box>
          <Text color={C.pink}>worker error: {worker.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ModePill({ worker }: { worker: WorkerInfo }) {
  // mode = worker 进程所有权状态，与 ready/provider 同一层级（顶部 banner）
  const { value, color } = (() => {
    switch (worker.mode) {
      case 'self':
        return { value: 'self', color: C.green };
      case 'external':
        return {
          value: worker.externalPid ? `external pid=${worker.externalPid}` : 'external',
          color: C.cyan,
        };
      case 'off':
        return { value: 'off', color: undefined };
      case 'error':
        return { value: 'error', color: C.pink };
    }
  })();
  return (
    <Box marginRight={3}>
      <Text dimColor>queue </Text>
      <Text color={color} dimColor={!color}>
        {value}
      </Text>
    </Box>
  );
}

function Pill({ k, v }: { k: string; v: string }) {
  return (
    <Box marginRight={3}>
      <Text dimColor>{k} </Text>
      <Text>{v}</Text>
    </Box>
  );
}

/* ───────────────────────── Watch lines ───────────────────────── */

function WatchLines({ rows, extensions }: { rows: WatchRow[]; extensions: string[] }) {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor bold>
            WATCH
          </Text>
          <Text dimColor>  (no watch dirs configured)</Text>
        </Box>
        <Text dimColor>       add one to ~/.llm-wiki/config.json → watchDirs[]</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {rows.map((w, i) => (
        <Box key={i} flexDirection="column">
          <Box>
            <Box width={7}>
              {i === 0 ? (
                <Text dimColor bold>
                  WATCH
                </Text>
              ) : (
                <Text> </Text>
              )}
            </Box>
            <Text color={C.cyan}>● </Text>
            <Text wrap="truncate-middle">{shortPath(w.path)}</Text>
            <Text dimColor>
              {'  · '}
              {w.count} files · {w.collection}
            </Text>
          </Box>
          {w.error ? (
            <Box marginLeft={9}>
              <Text color={C.pink}>⚠ {w.error}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
      <Box>
        <Box width={7}>
          <Text> </Text>
        </Box>
        <Text dimColor>exts </Text>
        {extensions.map((ext, i) => (
          <Text key={ext} color={C.amber}>
            {ext}
            {i < extensions.length - 1 ? ' ' : ''}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/* ───────────────────────── Unified table ───────────────────────── */

function UnifiedTable({ rows }: { rows: CollectionRow[] }) {
  const nameW = Math.max(
    visualWidth('collection') + 2,
    ...rows.map((r) => visualWidth(r.name) + 2),
    14,
  );

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Header nameW={nameW} />
        <Box marginLeft={2}>
          <Text dimColor>(no collections yet — ingest something or wait for watcher)</Text>
        </Box>
      </Box>
    );
  }

  const total = rows.reduce(
    (acc, r) => ({
      files: acc.files + r.files,
      pending: acc.pending + r.pending,
      running: acc.running + r.running,
      done: acc.done + r.done,
      dead: acc.dead + r.dead,
    }),
    { files: 0, pending: 0, running: 0, done: 0, dead: 0 },
  );
  const watching = rows.filter((r) => r.watch).length;

  // 估算 rule 宽度（与列宽之和对齐；fallback 80）
  const ruleW = Math.min(80, nameW + NUM_COL_W * 5 + WATCH_COL_W + 8);

  return (
    <Box flexDirection="column">
      <Header nameW={nameW} />
      {rows.map((r) => (
        <Row key={r.name} row={r} nameW={nameW} />
      ))}
      <Box>
        <Text dimColor>{'─'.repeat(ruleW)}</Text>
      </Box>
      <TotalRow nameW={nameW} total={total} watching={watching} rowCount={rows.length} />
    </Box>
  );
}

function Header({ nameW }: { nameW: number }) {
  return (
    <Box>
      <Cell width={nameW}>
        <Text dimColor>collection</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text dimColor>files</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text dimColor>pending</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text dimColor>running</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text dimColor>done</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text dimColor>dead</Text>
      </Cell>
      <Cell width={WATCH_COL_W} center>
        <Text dimColor>watch</Text>
      </Cell>
    </Box>
  );
}

function Row({ row, nameW }: { row: CollectionRow; nameW: number }) {
  const nameColor = row.danger ? C.pink : undefined;

  return (
    <Box>
      <Cell width={nameW}>
        <Text color={nameColor} wrap="truncate-end">
          {row.name}
        </Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {row.files ? <Text>{row.files}</Text> : <Text dimColor>—</Text>}
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <NumOrDot n={row.pending} />
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {row.running > 0 ? (
          <Text color={C.amber}>
            <Spinner type="dots" /> {row.running}
          </Text>
        ) : (
          <Text dimColor>·</Text>
        )}
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {row.done > 0 ? <Text color={C.green}>{row.done}</Text> : <Text dimColor>·</Text>}
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {row.dead > 0 ? <Text color={C.pink}>{row.dead}</Text> : <Text dimColor>·</Text>}
      </Cell>
      <Cell width={WATCH_COL_W} center>
        {row.watch ? <Text color={C.cyan}>●</Text> : <Text dimColor>○</Text>}
      </Cell>
    </Box>
  );
}

function TotalRow({
  nameW,
  total,
  watching,
  rowCount,
}: {
  nameW: number;
  total: { files: number; pending: number; running: number; done: number; dead: number };
  watching: number;
  rowCount: number;
}) {
  return (
    <Box>
      <Cell width={nameW}>
        <Text dimColor>total</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <Text bold>{total.files}</Text>
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        <NumOrDot n={total.pending} />
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {total.running > 0 ? (
          <Text color={C.amber} bold>
            {total.running}
          </Text>
        ) : (
          <Text dimColor>·</Text>
        )}
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {total.done > 0 ? (
          <Text color={C.green} bold>
            {total.done}
          </Text>
        ) : (
          <Text dimColor>·</Text>
        )}
      </Cell>
      <Cell width={NUM_COL_W} alignEnd>
        {total.dead > 0 ? (
          <Text color={C.pink} bold>
            {total.dead}
          </Text>
        ) : (
          <Text dimColor>·</Text>
        )}
      </Cell>
      <Cell width={WATCH_COL_W} center>
        <Text color={C.cyan}>{watching}</Text>
        <Text dimColor>/{rowCount}</Text>
      </Cell>
    </Box>
  );
}

function NumOrDot({ n }: { n: number }) {
  return n > 0 ? <Text>{n}</Text> : <Text dimColor>·</Text>;
}

/* ───────────────────────── 通用 Cell ───────────────────────── */

interface CellProps {
  children: React.ReactNode;
  width?: number;
  flexGrow?: number;
  alignEnd?: boolean;
  center?: boolean;
}

function Cell({ children, width, flexGrow, alignEnd, center }: CellProps) {
  return (
    <Box
      width={width}
      flexGrow={flexGrow}
      flexShrink={0}
      marginRight={1}
      justifyContent={alignEnd ? 'flex-end' : center ? 'center' : 'flex-start'}
    >
      {children}
    </Box>
  );
}

/* ───────────────────────── home 缩写 ───────────────────────── */

function shortPath(abs: string): string {
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}
