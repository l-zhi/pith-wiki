import React from 'react';
import { Box, Text } from 'ink';
import os from 'node:os';
import path from 'node:path';
import type { DashboardData, CollectionRow, WatchRow } from './dashboardData.js';

/**
 * REPL 启动 dashboard 的 Ink 表格渲染。
 *
 * 用 Ink Box 的 flex 引擎按列布局：
 *   - 每个 cell 是 `<Box width={N}>`，自带终端列宽对齐（CJK 自动算 2 列）
 *   - 数字列用 `justifyContent="flex-end"` 右对齐，避免 padStart 在 CJK 下错位
 *   - 长路径用 `<Text wrap="truncate-middle">` 中段省略，不破坏行布局
 *
 * 文本版（formatDashboard）保留给 CLI `llm-wiki status`（一次性 stdout 不需要 flex）。
 */
interface Props {
  data: DashboardData;
}

export function Dashboard({ data }: Props) {
  return (
    <Box flexDirection="column">
      <WikiSection wikiRoot={data.wikiRoot} rows={data.collections} />
      <Box marginTop={1}>
        <WatchSection rows={data.watchDirs} extensions={data.registeredExtensions} />
      </Box>
    </Box>
  );
}

function WikiSection({ wikiRoot, rows }: { wikiRoot: string; rows: CollectionRow[] }) {
  // 列宽：collection 名足够容纳"collection"标题 + 实际最长的 entry 名（CJK 按 2 算）
  const nameW = Math.max(
    visualWidth('collection') + 2,
    ...rows.map((r) => visualWidth(r.name) + 2),
    18,
  );
  const numW = 8;
  const total = rows.reduce((s, r) => s + r.count, 0);

  return (
    <Box flexDirection="column">
      {/* 标题 */}
      <Box>
        <Text>📚 Wiki  </Text>
        <Text color="cyan">{shortPath(wikiRoot)}</Text>
      </Box>
      {/* 表头 */}
      <Cells>
        <Cell width={nameW}>
          <Text dimColor>collection</Text>
        </Cell>
        <Cell width={numW} alignEnd>
          <Text dimColor>entries</Text>
        </Cell>
      </Cells>
      {rows.length === 0 ? (
        <Box marginLeft={2}>
          <Text dimColor>(no collections yet)</Text>
        </Box>
      ) : (
        <>
          {rows.map((r) => (
            <Cells key={r.name}>
              <Cell width={nameW}>
                <Text wrap="truncate-end">{r.name}</Text>
              </Cell>
              <Cell width={numW} alignEnd>
                <Text>{r.count}</Text>
              </Cell>
            </Cells>
          ))}
          <Cells>
            <Cell width={nameW}>
              <Text bold dimColor>
                total
              </Text>
            </Cell>
            <Cell width={numW} alignEnd>
              <Text bold>{total}</Text>
            </Cell>
          </Cells>
        </>
      )}
    </Box>
  );
}

function WatchSection({ rows, extensions }: { rows: WatchRow[]; extensions: string[] }) {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>👁  No watch directories configured</Text>
        <Text dimColor>
          {'   '}Add one to ~/.llm-wiki/config.json → watchDirs[]
        </Text>
      </Box>
    );
  }
  // 列宽：collection 名够长（CJK 计宽）；path 用 flexGrow 吃剩余空间，长了中段省略
  const collW = Math.max(
    visualWidth('collection') + 2,
    ...rows.map((r) => visualWidth(r.collection) + 2),
    18,
  );
  const numW = 7;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>👁  Watching {rows.length} dir(s)  </Text>
        <Text dimColor>exts: {extensions.join(' ')}</Text>
      </Box>
      <Cells>
        <Cell flexGrow={1}>
          <Text dimColor>path</Text>
        </Cell>
        <Cell width={collW}>
          <Text dimColor>collection</Text>
        </Cell>
        <Cell width={numW} alignEnd>
          <Text dimColor>files</Text>
        </Cell>
      </Cells>
      {rows.map((r, i) => (
        <Box key={i} flexDirection="column">
          <Cells>
            <Cell flexGrow={1}>
              <Text wrap="truncate-middle">{shortPath(r.path)}</Text>
            </Cell>
            <Cell width={collW}>
              <Text>{r.collection}</Text>
            </Cell>
            <Cell width={numW} alignEnd>
              <Text>{r.count}</Text>
            </Cell>
          </Cells>
          {r.error ? (
            <Box marginLeft={3}>
              <Text color="red">⚠ {r.error}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

/* ───── 小组件：表格行 / 表格 cell ───── */

function Cells({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="row" marginLeft={2}>
      {children}
    </Box>
  );
}

interface CellProps {
  children: React.ReactNode;
  width?: number;
  flexGrow?: number;
  alignEnd?: boolean;
}

function Cell({ children, width, flexGrow, alignEnd }: CellProps) {
  return (
    <Box
      width={width}
      flexGrow={flexGrow}
      flexShrink={0}
      marginRight={1}
      justifyContent={alignEnd ? 'flex-end' : 'flex-start'}
    >
      {children}
    </Box>
  );
}

/* ───── 工具函数：home 缩写 + CJK 宽度 ───── */

function shortPath(abs: string): string {
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      c > 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0x9fff) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6))
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}
