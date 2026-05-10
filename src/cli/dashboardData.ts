import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastGlob from 'fast-glob';
import type { Config } from '../config.js';
import type { ConverterRegistry } from '../wiki/converters/registry.js';

/**
 * REPL 启动时打的 dashboard：
 *
 *   📚 Wiki  ~/.llm-wiki/wiki-data
 *      collection   entries
 *      tech              42
 *      life              18
 *      total             60
 *
 *   👁  Watching 2 dir(s)  exts: .md .pdf .docx ...
 *      path                       collection    files
 *      ~/notes/记录片             记录片            156
 *      ~/notes/Clippings          from-subdir       342
 *
 * 让用户一眼看到：wiki 在哪、各 collection 多大、watcher 实际盯着哪些目录、
 * 每个目录里有多少可处理文件。watcher 没配 → 提示用户去 config.json 里加。
 */

export interface CollectionRow {
  name: string;
  count: number;
}

export interface WatchRow {
  path: string;
  collection: string;
  count: number;
  error?: string;
}

export interface DashboardData {
  wikiRoot: string;
  collections: CollectionRow[];
  watchDirs: WatchRow[];
  registeredExtensions: string[];
}

/**
 * 同步扫 wikiRoot 一层得到 collection 列表 + 每个 collection 的 .md 数量。
 * 口径与 LibraryService.scanAll 一致：只看 `<wikiRoot>/<collection>/*.md` 一层。
 * 跳过 dotdir（.cache、.queue 等不是 collection）。
 */
function scanWikiCollections(wikiRoot: string): CollectionRow[] {
  if (!fs.existsSync(wikiRoot)) return [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(wikiRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CollectionRow[] = [];
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // .cache / .queue 不计
    const dir = path.join(wikiRoot, entry.name);
    let count = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) count += 1;
      }
    } catch {
      /* ignore */
    }
    out.push({ name: entry.name, count });
  }
  // 大的在前，方便一眼看见主力 collection
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
 * 异步收集所有面板数据。watchDir 扫描走 fast-glob（与 watcher 同款）；
 * 与 watcher 黑名单口径同步：忽略 dotdir / node_modules / wiki / outputs / .icloud
 * + 用户自定义的 ignore globs。
 */
export async function collectDashboardData(
  config: Config,
  registry: ConverterRegistry,
): Promise<DashboardData> {
  const collections = scanWikiCollections(config.wikiRoot);
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
    collections,
    watchDirs: watchRows,
    registeredExtensions: exts,
  };
}

/* ───────────────────────── 渲染 ───────────────────────── */

/** home 目录前缀压成 `~`，其它原样。 */
function shortPath(abs: string): string {
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}

/** CJK 字符按 2 列计算视觉宽度，给 padEnd / padStart 对齐用。 */
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

function vpad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
}

function vpadStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualWidth(s))) + s;
}

/** 文本表格输出，给 ChatView 的 system 消息渲染用。 */
export function formatDashboard(data: DashboardData): string {
  const lines: string[] = [];

  // Wiki 区块
  lines.push(`📚 Wiki  ${shortPath(data.wikiRoot)}`);
  if (data.collections.length === 0) {
    lines.push('   (no collections yet)');
  } else {
    const nameW = Math.max(
      10,
      visualWidth('collection'),
      ...data.collections.map((c) => visualWidth(c.name)),
    );
    const countW = Math.max(
      7,
      ...data.collections.map((c) => visualWidth(String(c.count))),
    );
    lines.push(`   ${vpad('collection', nameW)}  ${vpadStart('entries', countW)}`);
    for (const c of data.collections) {
      lines.push(`   ${vpad(c.name, nameW)}  ${vpadStart(String(c.count), countW)}`);
    }
    const total = data.collections.reduce((s, c) => s + c.count, 0);
    lines.push(`   ${vpad('total', nameW)}  ${vpadStart(String(total), countW)}`);
  }

  lines.push('');

  // Watch 区块
  if (data.watchDirs.length === 0) {
    lines.push(
      '👁  No watch directories configured. ' +
        '(Add one to `~/.llm-wiki/config.json` → watchDirs[])',
    );
  } else {
    lines.push(
      `👁  Watching ${data.watchDirs.length} dir(s)  exts: ${data.registeredExtensions.join(' ')}`,
    );
    const pathLabels = data.watchDirs.map((w) => shortPath(w.path));
    const pathW = Math.max(visualWidth('path'), ...pathLabels.map(visualWidth));
    const collW = Math.max(
      visualWidth('collection'),
      ...data.watchDirs.map((w) => visualWidth(w.collection)),
    );
    const countW = Math.max(
      visualWidth('files'),
      ...data.watchDirs.map((w) => visualWidth(String(w.count))),
    );
    lines.push(
      `   ${vpad('path', pathW)}  ${vpad('collection', collW)}  ${vpadStart('files', countW)}`,
    );
    for (let i = 0; i < data.watchDirs.length; i++) {
      const w = data.watchDirs[i];
      const errSuffix = w.error ? `  ⚠ ${w.error}` : '';
      lines.push(
        `   ${vpad(pathLabels[i], pathW)}  ${vpad(w.collection, collW)}  ${vpadStart(String(w.count), countW)}${errSuffix}`,
      );
    }
  }

  return lines.join('\n');
}
