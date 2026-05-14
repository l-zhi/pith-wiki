import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastGlob from 'fast-glob';
import type { Config } from '../config.js';
import type { ConverterRegistry } from '../wiki/converters/registry.js';
import { readState, type JobStatus } from '../wiki/queue/state.js';

/**
 * REPL 启动时打的 dashboard。
 *
 * 设计要点：把"库存"和"在做什么"合并成一张按 collection 聚合的表：
 *   - 一行 = 一个 collection
 *   - files = pending + running + done + dead（队列各状态总和；空 collection 仍可展示）
 *   - done = wiki dir 里的 .md 数 ∪ queue.completed（持久化的 .md 是真理；队列事件可能被环形截断）
 *   - watch ●/○ = 该 collection 是否被任意 watchDir 跟踪
 *   - updated = collection 目录的 mtime（相对时间）
 *
 * 顶部 banner 显示 provider/model/ready，让用户一眼看到当前激活 provider 和 key 是否就绪。
 * 底部 watch 区按行展示每个 watchDir，加上注册扩展名（amber 高亮）。
 */

const QUEUE_STATUSES = ['pending', 'running', 'completed', 'dead'] as const;
type QueueStatusCount = Record<(typeof QUEUE_STATUSES)[number], number>;

export interface CollectionRow {
  name: string;
  files: number;
  pending: number;
  running: number;
  done: number;
  dead: number;
  watch: boolean;
  danger: boolean;
}

export interface WatchRow {
  path: string;
  collection: string;
  count: number;
  error?: string;
}

export interface DashboardData {
  wikiRoot: string;
  provider: string;
  model: string;
  ready: boolean;
  collections: CollectionRow[];
  watchDirs: WatchRow[];
  registeredExtensions: string[];
}

/* ───────────────────────── 收集层 ───────────────────────── */

/**
 * 同步扫 wikiRoot 一层得到 collection 列表 + 每个 collection 的 .md 数量。
 * 口径与 LibraryService.scanAll 一致：只看 `<wikiRoot>/<collection>/*.md` 一层。
 * 跳过 dotdir（.cache、.queue 等不是 collection）。
 */
function scanWikiCollections(wikiRoot: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(wikiRoot)) return out;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(wikiRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(wikiRoot, entry.name);
    let count = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) count += 1;
      }
    } catch {
      /* ignore */
    }
    out.set(entry.name, count);
  }
  return out;
}

export type CollectionQueueCount = QueueStatusCount;

/**
 * 读队列 state.json，按 collection 聚合各状态数量。
 * state 文件不存在或读不出 → 返回空 Map（dashboard 仍可只显示 wiki 库存）。
 *
 * 导出给 Dashboard 组件做 live polling 用（启动快照 + 2s 增量合并）。
 */
export function loadQueueCounts(queueStatePath: string): Map<string, QueueStatusCount> {
  const out = new Map<string, QueueStatusCount>();
  try {
    if (!fs.existsSync(queueStatePath)) return out;
    const state = readState(queueStatePath);
    for (const job of Object.values(state.jobs)) {
      const bucket =
        out.get(job.collection) ?? { pending: 0, running: 0, completed: 0, dead: 0 };
      bucket[job.status as JobStatus] += 1;
      out.set(job.collection, bucket);
    }
  } catch {
    /* 静默：dashboard 不能因为 state.json 坏掉就崩 */
  }
  return out;
}

/**
 * 哪些 collection 正在被 watcher 跟踪。
 * 三种来源：
 *   - 显式 `wd.collection`
 *   - `wd.fallbackCollection`
 *   - `wd.collectionFromSubdir=true` 时，扫一层子目录名（每个目录就是一个候选 collection）
 */
function watchedCollections(config: Config): Set<string> {
  const out = new Set<string>();
  for (const wd of config.watchDirs) {
    if (wd.collection) out.add(wd.collection);
    if (wd.fallbackCollection) out.add(wd.fallbackCollection);
    if (wd.collectionFromSubdir) {
      try {
        if (!fs.existsSync(wd.path)) continue;
        for (const ent of fs.readdirSync(wd.path, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          if (ent.name.startsWith('.')) continue;
          // subdirAlias 把源目录名映射成 collection 名
          out.add(wd.subdirAlias[ent.name] ?? ent.name);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function describeCollection(wd: Config['watchDirs'][number]): string {
  if (wd.collection) return wd.collection;
  if (wd.collectionFromSubdir) {
    return wd.fallbackCollection ? `subdir → ${wd.fallbackCollection}` : 'from-subdir';
  }
  return '(unconfigured)';
}

function buildExtensionGlob(exts: string[]): string {
  if (exts.length === 0) return '**/*.md';
  if (exts.length === 1) return `**/*${exts[0]}`;
  return `**/*.{${exts.map((e) => e.replace(/^\./, '')).join(',')}}`;
}

/**
 * 从 baseURL 提取显示用的 provider 名（fallback）：去 scheme 取 host 第一段。
 * 优先用 `activeProvider`（用户在 config 里命名的 key）。
 */
function deriveProviderLabel(config: Config): string {
  if (config.activeProvider) return config.activeProvider;
  try {
    const u = new URL(config.baseURL);
    return u.hostname.replace(/^www\./, '').split('.')[0] || u.hostname;
  } catch {
    return '(unknown)';
  }
}

export async function collectDashboardData(
  config: Config,
  registry: ConverterRegistry,
): Promise<DashboardData> {
  const wikiMap = scanWikiCollections(config.wikiRoot);
  const queueMap = loadQueueCounts(config.queueStatePath);
  const watchSet = watchedCollections(config);

  // 行集合 = (wiki 目录) ∪ (queue 提到过的 collection)
  // 设计稿里 `dead-letter` 这种"只存在于队列里"的虚拟 collection 也要出现。
  const names = new Set<string>([...wikiMap.keys(), ...queueMap.keys()]);
  const rows: CollectionRow[] = [];
  for (const name of names) {
    const wikiCount = wikiMap.get(name) ?? 0;
    const q = queueMap.get(name) ?? { pending: 0, running: 0, completed: 0, dead: 0 };
    // done 取 max：wiki 目录是持久化真理，但 queue.completed 在环形 buffer 截断之前能反映"刚完成"
    const done = Math.max(wikiCount, q.completed);
    const files = q.pending + q.running + done + q.dead;
    rows.push({
      name,
      files,
      pending: q.pending,
      running: q.running,
      done,
      dead: q.dead,
      watch: watchSet.has(name),
      danger: q.dead > 0,
    });
  }
  // 排序：先把异常（dead>0）顶上来；其次按 files 大→小；同 size 按 name
  rows.sort((a, b) => {
    if (a.danger !== b.danger) return a.danger ? -1 : 1;
    if (b.files !== a.files) return b.files - a.files;
    return a.name.localeCompare(b.name);
  });

  const exts = registry.extensions();
  const glob = buildExtensionGlob(exts);

  const watchRows: WatchRow[] = await Promise.all(
    config.watchDirs.map(async (wd) => {
      const collection = describeCollection(wd);
      try {
        if (!fs.existsSync(wd.path)) {
          return { path: wd.path, collection, count: 0, error: 'path missing' };
        }
        const files = await fastGlob(glob, {
          cwd: wd.path,
          absolute: false,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          ignore: [
            ...(wd.ignore ?? []),
            '**/node_modules/**',
            '**/wiki/**',
            '**/outputs/**',
            '**/.icloud',
          ],
        });
        return { path: wd.path, collection, count: files.length };
      } catch (err) {
        return { path: wd.path, collection, count: 0, error: (err as Error).message };
      }
    }),
  );

  return {
    wikiRoot: config.wikiRoot,
    provider: deriveProviderLabel(config),
    model: config.model,
    ready: config.apiKey.length > 0,
    collections: rows,
    watchDirs: watchRows,
    registeredExtensions: exts,
  };
}

/* ───────────────────────── 渲染：纯文本 ───────────────────────── */

/** home 目录前缀压成 `~`，其它原样。 */
function shortPath(abs: string): string {
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}

/** CJK 字符按 2 列计算视觉宽度，给 padEnd / padStart 对齐用。 */
export function visualWidth(s: string): number {
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

function vpad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
}

function vpadStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualWidth(s))) + s;
}

/** "·" 表示该列为零，与设计稿一致（避免一片 0 的视觉噪声）。 */
function num(n: number): string {
  return n > 0 ? String(n) : '·';
}

/** 给纯文本 banner 用的 worker 状态摘要。 */
export interface WorkerSummary {
  mode: 'self' | 'external' | 'off' | 'error';
  externalPid?: number;
  error?: string;
}

/** 文本表格输出，给 CLI `llm-wiki status` + REPL transcript 兜底用。 */
export function formatDashboard(data: DashboardData, worker?: WorkerSummary): string {
  const lines: string[] = [];

  // ── 顶部 banner：ready + provider/model/queue/root ──
  const readyTag = data.ready ? '● ready' : '● not ready';
  const parts = [
    readyTag,
    `model ${data.model}`,
    `provider ${data.provider}`,
  ];
  if (worker) {
    const v =
      worker.mode === 'external' && worker.externalPid
        ? `external pid=${worker.externalPid}`
        : worker.mode;
    parts.push(`queue ${v}`);
  }
  parts.push(`root ${shortPath(data.wikiRoot)}`);
  lines.push(parts.join('   '));
  if (worker?.mode === 'error' && worker.error) {
    lines.push(`worker error: ${worker.error}`);
  }
  lines.push('');

  // ── watch 区：每个 dir 一行，加 exts ──
  if (data.watchDirs.length === 0) {
    lines.push(
      'WATCH  (no watch dirs; add one to ~/.llm-wiki/config.json → watchDirs[])',
    );
  } else {
    for (let i = 0; i < data.watchDirs.length; i++) {
      const w = data.watchDirs[i];
      const head = i === 0 ? 'WATCH  ' : '       ';
      const errSuffix = w.error ? `  ⚠ ${w.error}` : '';
      lines.push(
        `${head}● ${shortPath(w.path)}  · ${w.count} files · ${w.collection}${errSuffix}`,
      );
    }
    lines.push(`       exts ${data.registeredExtensions.join(' ')}`);
  }
  lines.push('');

  // ── 统一表格 ──
  const nameW = Math.max(
    visualWidth('collection'),
    ...data.collections.map((c) => visualWidth(c.name)),
    10,
  );
  const numColW = 7; // pending/running/done/dead/files 用同一宽度，右对齐
  const filesW = Math.max(numColW, ...data.collections.map((c) => visualWidth(String(c.files))));

  const header =
    `${vpad('collection', nameW)}  ` +
    `${vpadStart('files', filesW)}  ` +
    `${vpadStart('pending', numColW)}  ` +
    `${vpadStart('running', numColW)}  ` +
    `${vpadStart('done', numColW)}  ` +
    `${vpadStart('dead', numColW)}  ` +
    `watch`;
  lines.push(header);

  if (data.collections.length === 0) {
    lines.push('(no collections yet)');
  } else {
    for (const r of data.collections) {
      lines.push(
        `${vpad(r.name, nameW)}  ` +
          `${vpadStart(String(r.files || '—'), filesW)}  ` +
          `${vpadStart(num(r.pending), numColW)}  ` +
          `${vpadStart(num(r.running), numColW)}  ` +
          `${vpadStart(num(r.done), numColW)}  ` +
          `${vpadStart(num(r.dead), numColW)}  ` +
          `  ${r.watch ? '●' : '○'}`,
      );
    }
    // 总计行：dashed rule 上方
    const total = data.collections.reduce(
      (acc, r) => ({
        files: acc.files + r.files,
        pending: acc.pending + r.pending,
        running: acc.running + r.running,
        done: acc.done + r.done,
        dead: acc.dead + r.dead,
      }),
      { files: 0, pending: 0, running: 0, done: 0, dead: 0 },
    );
    const watching = data.collections.filter((c) => c.watch).length;
    const ruleW = nameW + 2 + filesW + 2 + (numColW + 2) * 4 + 7 /* watch col */;
    lines.push('─'.repeat(ruleW));
    lines.push(
      `${vpad('total', nameW)}  ` +
        `${vpadStart(String(total.files), filesW)}  ` +
        `${vpadStart(num(total.pending), numColW)}  ` +
        `${vpadStart(num(total.running), numColW)}  ` +
        `${vpadStart(num(total.done), numColW)}  ` +
        `${vpadStart(num(total.dead), numColW)}  ` +
        ` ${watching}/${data.collections.length}`,
    );
  }

  return lines.join('\n');
}
