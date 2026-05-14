import path from 'node:path';
import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import fastGlob from 'fast-glob';
import { resolveSafePath, SafetyError, type SafetyOptions } from '../../tools/safety.js';
import { deriveJobId, pushEvent, type QueueJob, type QueueState } from './state.js';
import { QueueStore } from './store.js';

/**
 * 目录监听 watcher。
 *
 * 设计要点：
 *   - 引擎用 chokidar：跨平台递归 + awaitWriteFinish 自动合并编辑器多次保存事件
 *   - 自身**不取队列锁**：只 enqueue（mutate state.json），不跑 hydrate。worker 仍由
 *     `queue run` / REPL 自动起的那个负责，watcher 与 worker 解耦
 *   - **拒绝监听 wikiRoot 子树**：否则 library.put 写完会触发 watcher → 死循环
 *   - 沙箱校验复用 resolveSafePath('read', ...)，watch 路径必须落在
 *     workspaceRoot ∪ wikiRoot ∪ additionalReadPaths（即 LLM 可读范围之内）
 *   - collection 解析支持两种模式：固定 `collection` 或 `collectionFromSubdir`
 *     （一级子目录名 → collection）。中文/英文目录名直用，subdirAlias 是可选改名工具
 *   - 内存级 1s cooldown 兜底防抖；chokidar 的 awaitWriteFinish 已经吃掉绝大部分多次事件
 */

export interface WatchTargetConfig {
  path: string;
  collection?: string;
  collectionFromSubdir?: boolean;
  fallbackCollection?: string;
  subdirAlias?: Record<string, string>;
  initialScan?: boolean;
  ignore?: string[];
}

export interface ResolvedWatchTarget {
  /** 绝对路径（已 ~/ 展开 + path.resolve）。 */
  path: string;
  /** 经 realpathSync 后的真实路径，用于 isWithin 判断。 */
  realPath: string;
  collection?: string;
  collectionFromSubdir: boolean;
  fallbackCollection?: string;
  subdirAlias: Record<string, string>;
  initialScan: boolean;
  ignore: string[];
}

export interface RunWatcherOptions {
  store: QueueStore;
  targets: WatchTargetConfig[];
  /** 用于 wikiRoot 自写循环防御 + 沙箱校验。 */
  safety: SafetyOptions;
  signal: AbortSignal;
  /** 控制台事件回调；REPL 内传 noop，CLI watch 命令打 stderr。 */
  log?: (line: string) => void;
  /** 1s 防抖窗口（重复事件去重）。测试可调短。 */
  cooldownMs?: number;
  /**
   * 监听的文件扩展名列表（小写、含点，如 '.md' / '.pdf'）。
   * 默认 `['.md']` 兼容旧行为；调用方一般传 `converterRegistry.extensions()`。
   */
  extensions?: string[];
}

/**
 * 默认 ignored 集（path 段或文件名匹配任意一条即跳过）。
 *
 * - 任意层级的 dotfile/dotdir：覆盖 `.obsidian/`, `.git/`, `.DS_Store`, `.icloud` 等
 * - 任意层级的 wiki/ outputs/ node_modules/：避免和 wikiRoot/transcripts 输出循环
 * - chokidar `ignored` 接收 (path, stats?) → boolean 函数；这套正则一起喂给它
 */
const DEFAULT_IGNORED_PATTERNS: RegExp[] = [
  /(?:^|[\\/])\.[^\\/]+/,
  /(?:^|[\\/])(?:node_modules|wiki|outputs)(?:[\\/]|$)/,
  /\.icloud$/,
];

export function isDefaultIgnored(p: string): boolean {
  return DEFAULT_IGNORED_PATTERNS.some((re) => re.test(p));
}

/** 子目录名是否文件系统安全：拒绝 path 分隔符、null、`.`/`..`、隐藏、首尾空白。 */
export function isFilesystemSafeName(name: string): boolean {
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\\/\0]/.test(name)) return false;
  if (name.trim() !== name) return false;
  return true;
}

/**
 * 给定文件绝对路径，决定它该入哪个 collection。返回 null 表示跳过（无 fallback 兜底）。
 *
 * 决策树：
 *   1. 固定 collection 模式 → 直接返回
 *   2. 文件直接在 watch root 下（无子目录）→ fallbackCollection 或 null
 *   3. 一级子目录名命中 alias → 用 alias
 *   4. 一级子目录名文件系统安全 → 直用（中文/英文/混合都行）
 *   5. 兜底 → fallbackCollection 或 null
 */
export function resolveCollectionForFile(
  absFile: string,
  target: ResolvedWatchTarget,
): string | null {
  if (target.collection) return target.collection;

  const rel = path.relative(target.path, absFile);
  if (!rel || rel.startsWith('..')) {
    // absFile 不在 target.path 下；不应该发生（chokidar 不会触发），保守返回 null
    return null;
  }
  const segs = rel.split(path.sep);
  if (segs.length <= 1) {
    // 文件直接挂在 watch root：没有子目录可作为 collection
    return target.fallbackCollection ?? null;
  }
  const firstSeg = segs[0];
  if (target.subdirAlias[firstSeg]) return target.subdirAlias[firstSeg];
  if (isFilesystemSafeName(firstSeg)) return firstSeg;
  return target.fallbackCollection ?? null;
}

/**
 * 给定 (target, absFile) 返回 entry 在 collection 内的 subpath（POSIX 形式）。
 *
 * 计算方式：先确定文件物理路径相对 watch root 的中间目录段，去掉第一段（已经被
 * resolveCollectionForFile 消费成 collection）和最后一段（文件名），剩下的拼起来就是
 * subpath。
 *
 *   <watch>/人生大事/希区柯克/2024/note.pdf
 *           └─collection─┘ └────subpath────┘ filename
 *                        ↓
 *                  subpath = '希区柯克/2024'
 *
 * 边界：
 *   - 固定 collection 模式：subpath = 文件 dirname 相对 target.path（不吃任何段）。
 *     例：watch=/inbox + collection=tech + file=/inbox/sub/a.md → subpath='sub'
 *   - subdir 模式下文件直挂 watch root（走 fallbackCollection）→ 没有可派生的 subpath
 *   - 文件直接在 collection 根下：subpath = undefined（不是 ''，让落盘走旧 flat 路径）
 *   - 越界 / 含 dotdir 段 → 返回 undefined（保守落到 collection 根，避免污染 .cache 等）
 */
export function deriveSubpath(target: ResolvedWatchTarget, absFile: string): string | undefined {
  const rel = path.relative(target.path, absFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const segs = rel.split(path.sep);
  if (segs.length < 1) return undefined;
  // 去掉最后一段（文件名）
  const dirSegs = segs.slice(0, -1);
  // subdir 模式：去掉第一段（已是 collection）
  const middleSegs = target.collectionFromSubdir ? dirSegs.slice(1) : dirSegs;
  if (middleSegs.length === 0) return undefined;
  // dotdir 防御：任一段以 `.` 开头则视为非法 subpath（与 LibraryService scan 同步）
  for (const s of middleSegs) {
    if (!s || s.startsWith('.')) return undefined;
  }
  return middleSegs.join('/');
}

/**
 * 给定 (target, absFile) 返回 sidecar 计算 rel 时用的 sourceRoot。
 *
 * - 固定 collection 模式：直接返回 target.path（rel = 文件相对 watch root 的全路径）。
 * - collectionFromSubdir 模式：吃掉物理第一级目录段——这段在 resolveCollectionForFile
 *   里已经被消费成 collection 名，再镜像进 .cache/ 就是重复（rel 第一段 == collection）。
 *   注意：用 path.relative 取到的是**物理**目录名，对 subdirAlias 也正确——
 *   即便 alias 把 `荔枝AI圈` 映射成 `lizhi-ai`，要 strip 的也是物理段 `荔枝AI圈`。
 * - subdir 模式但文件直接挂在 watch root 下（走 fallbackCollection）：没有可吃的子目录，
 *   返回 target.path。
 */
export function effectiveSourceRoot(
  target: ResolvedWatchTarget,
  absFile: string,
): string {
  if (!target.collectionFromSubdir) return target.path;
  const rel = path.relative(target.path, absFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return target.path;
  const segs = rel.split(path.sep);
  if (segs.length <= 1) return target.path;
  return path.join(target.path, segs[0]);
}

/**
 * 沙箱化 + 自写循环防御后，把 WatchTargetConfig 解析成 ResolvedWatchTarget。
 * 失败抛 Error，调用方负责打印（启动期 fail-fast）。
 */
export function resolveWatchTarget(
  cfg: WatchTargetConfig,
  safety: SafetyOptions,
): ResolvedWatchTarget {
  const abs = path.resolve(cfg.path);
  if (!fs.existsSync(abs)) {
    throw new Error(`watch path does not exist: ${abs}`);
  }

  // 沙箱：必须在可读范围内
  let safe: string;
  try {
    safe = resolveSafePath(abs, 'read', safety);
  } catch (err) {
    if (err instanceof SafetyError) {
      throw new Error(
        `watch path outside read sandbox: ${abs} — add it to additionalReadPaths (LLM_WIKI_READ_PATHS)`,
      );
    }
    throw err;
  }

  // 自写循环防御：拒绝监听 wikiRoot 或其子目录
  // 用 realpath 比较，防止 symlink 绕过（macOS /var → /private/var 之类）
  let realWiki = safety.wikiRoot;
  try {
    realWiki = fs.realpathSync(safety.wikiRoot);
  } catch {
    // wikiRoot 还不存在也无所谓，下面 isWithin 用绝对路径就行
  }
  if (isWithin(realWiki, safe) || isWithin(safe, realWiki)) {
    throw new Error(
      `watch path overlaps wikiRoot (${realWiki}): refusing to watch — would cause self-write loop`,
    );
  }

  if (!cfg.collection && !cfg.collectionFromSubdir) {
    throw new Error(
      `watch target ${abs} must set either "collection" or "collectionFromSubdir: true"`,
    );
  }

  return {
    path: abs,
    realPath: safe,
    collection: cfg.collection,
    collectionFromSubdir: !!cfg.collectionFromSubdir,
    fallbackCollection: cfg.fallbackCollection,
    subdirAlias: cfg.subdirAlias ?? {},
    initialScan: !!cfg.initialScan,
    ignore: cfg.ignore ?? [],
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把单个文件入队（add 或 change）。已存在的 job：
 *   - change（force=true）：reset 为 pending、attempts=0、force=true，让 worker 必重跑
 *   - add（force=false）：completed 不动；dead 不动（避免无限自愈）；其他状态保持
 *
 * 返回新增/重置/跳过的标记，便于上层日志统计。
 */
export type EnqueueResult = 'added' | 'reset' | 'skipped';

export function enqueueFromWatch(
  store: QueueStore,
  absFile: string,
  collection: string,
  kind: 'add' | 'change',
  sourceRoot?: string,
  subpath?: string,
): EnqueueResult {
  const force = kind === 'change';
  const id = deriveJobId(absFile, collection);
  let outcome: EnqueueResult = 'skipped';
  store.mutate((s: QueueState) => {
    const existing = s.jobs[id];
    if (!existing) {
      const job: QueueJob = {
        id,
        file: absFile,
        collection,
        force,
        status: 'pending',
        attempts: 0,
        enqueuedAt: new Date().toISOString(),
        ...(sourceRoot ? { sourceRoot } : {}),
        ...(subpath ? { subpath } : {}),
      };
      s.jobs[id] = job;
      pushEvent(s, {
        ts: job.enqueuedAt,
        jobId: id,
        kind: 'enqueued',
        msg: `watcher:${kind}`,
      });
      outcome = 'added';
      return;
    }
    if (existing.status === 'running') {
      // 在飞，让它跑完。当前内容如果还会变，下次 change 会再触发。
      outcome = 'skipped';
      return;
    }
    if (force) {
      // change 事件：强制 reset 让 worker 重跑（即使原状态是 dead 也复活）
      existing.status = 'pending';
      existing.attempts = 0;
      existing.force = true;
      existing.lastError = undefined;
      existing.startedAt = undefined;
      existing.completedAt = undefined;
      existing.finalEntryId = undefined;
      existing.nextEarliestRunAt = undefined;
      // 如果有新的 sourceRoot（target 可能改了），更新；缺省保留旧值（initial-scan 来的 add 没传 sourceRoot 就不要把旧的清掉）
      if (sourceRoot) existing.sourceRoot = sourceRoot;
      // subpath 同样：change 事件可能因为源文件被移动而改了子路径，得跟着更新
      if (subpath !== undefined) existing.subpath = subpath;
      else delete existing.subpath;
      pushEvent(s, {
        ts: new Date().toISOString(),
        jobId: id,
        kind: 'enqueued',
        msg: 'watcher:change → reset',
      });
      outcome = 'reset';
      return;
    }
    // add 命中已有 job：不动（completed 跳过 = 幂等；dead 等用户手动 retry）
    outcome = 'skipped';
  });
  return outcome;
}

/**
 * 把 target 路径下已有的 .md 全量批量入队。一次 store.mutate 完成 N 次写入，
 * 避免 N 个原子 rename。已存在的 job 走 add 语义（不 reset force）。
 *
 * 返回 added 的条目数。
 */
export async function initialScanEnqueue(
  store: QueueStore,
  target: ResolvedWatchTarget,
  extensions: string[] = ['.md'],
): Promise<number> {
  const glob = extensionsToGlob(extensions);
  const files = await fastGlob(glob, {
    cwd: target.path,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: target.ignore,
  });
  let added = 0;
  store.mutate((s: QueueState) => {
    for (const abs of files) {
      // 默认 ignored 双重过滤（fast-glob 已经吃了 dotfiles，但这里兜底覆盖
      // outputs/wiki/node_modules/.icloud）
      if (isDefaultIgnored(abs)) continue;
      const collection = resolveCollectionForFile(abs, target);
      if (!collection) continue;
      const id = deriveJobId(abs, collection);
      if (s.jobs[id]) continue;
      const ts = new Date().toISOString();
      const sub = deriveSubpath(target, abs);
      s.jobs[id] = {
        id,
        file: abs,
        collection,
        force: false,
        status: 'pending',
        attempts: 0,
        enqueuedAt: ts,
        sourceRoot: effectiveSourceRoot(target, abs),
        ...(sub ? { subpath: sub } : {}),
      };
      pushEvent(s, { ts, jobId: id, kind: 'enqueued', msg: 'watcher:initial-scan' });
      added += 1;
    }
  });
  return added;
}

interface RunningWatcher {
  watcher: FSWatcher;
  target: ResolvedWatchTarget;
}

/**
 * 起所有 watcher 并阻塞直到 signal.aborted。Promise resolve 时所有 chokidar 实例都已 close。
 *
 * 启动顺序：
 *   1. 解析所有 target（沙箱、wikiRoot 重叠校验）→ 任一失败立即抛
 *   2. 对每个 target，可选先做 initialScan
 *   3. 起 chokidar，subscribe 'add' / 'change'
 *   4. 等 signal.aborted → 关所有 watcher → 退出
 */
export async function runWatcher(opts: RunWatcherOptions): Promise<void> {
  const {
    store,
    targets,
    safety,
    signal,
    log = () => {},
    cooldownMs = 1000,
    extensions = ['.md'],
  } = opts;
  if (targets.length === 0) return;
  // 规范化：小写 + 含点
  const exts = extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());

  const resolved: ResolvedWatchTarget[] = [];
  for (const t of targets) {
    resolved.push(resolveWatchTarget(t, safety));
  }

  const running: RunningWatcher[] = [];
  // 文件级 cooldown：chokidar awaitWriteFinish 已经吃掉绝大多数重复事件，这层
  // 兜底防御编辑器异常或多 watcher 监听同一目录的情况。
  const lastSeen = new Map<string, number>();
  function recentlySeen(abs: string): boolean {
    const prev = lastSeen.get(abs) ?? 0;
    const now = Date.now();
    if (now - prev < cooldownMs) return true;
    lastSeen.set(abs, now);
    return false;
  }

  for (const target of resolved) {
    if (target.initialScan) {
      const n = await initialScanEnqueue(store, target, exts);
      log(`[watch] initial-scan ${target.path} → enqueued ${n} new file(s)`);
    }

    // chokidar `ignored` 接受 RegExp / glob / 函数。我们用函数把
    // DEFAULT_IGNORED_PATTERNS + 用户 globs 合一处。
    const userGlobs = target.ignore;
    const watcher = chokidar.watch(target.path, {
      ignored: (testPath: string): boolean => {
        if (isDefaultIgnored(testPath)) return true;
        if (userGlobs.length === 0) return false;
        // chokidar 会把 user globs 也喂给我们的函数，但人手写 glob 自己匹配较麻烦；
        // 退化做法：相对路径前缀匹配 + 简单通配。生产里更准确的方案是引入
        // micromatch，但当前依赖里没有，先用基础匹配兜住常见场景。
        const rel = path.relative(target.path, testPath);
        return userGlobs.some((g) => simpleGlobMatch(rel, g));
      },
      ignoreInitial: true, // initialScan 是我们自己做的，chokidar 不要再发 add
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      // 启用 polling 由调用方在测试里通过 chokidar 自己的 env 覆盖；生产默认用 native
    });

    function dispatch(kind: 'add' | 'change', file: string): void {
      const abs = path.resolve(file);
      const ext = path.extname(abs).toLowerCase();
      if (!exts.includes(ext)) return;
      if (isDefaultIgnored(abs)) return;
      // 兜底：再次确认不在 wikiRoot 之内（即使配置正确，也防止 symlink/realpath 漂移）
      const realWiki = (() => {
        try {
          return fs.realpathSync(safety.wikiRoot);
        } catch {
          return safety.wikiRoot;
        }
      })();
      if (isWithin(realWiki, abs)) return;
      if (recentlySeen(abs)) return;

      const collection = resolveCollectionForFile(abs, target);
      if (!collection) {
        log(`[watch] skip ${abs} (no collection — direct child of root with no fallback?)`);
        return;
      }
      const result = enqueueFromWatch(
        store,
        abs,
        collection,
        kind,
        effectiveSourceRoot(target, abs),
        deriveSubpath(target, abs),
      );
      if (result !== 'skipped') {
        log(`[watch] ${kind} ${abs} → ${collection} (${result})`);
      }
    }

    watcher.on('add', (file) => dispatch('add', file));
    watcher.on('change', (file) => dispatch('change', file));
    watcher.on('error', (err) => {
      log(`[watch] error on ${target.path}: ${(err as Error).message}`);
    });

    // 等到 ready 一次，确保 initialScan 之外新加的文件不会漏
    await new Promise<void>((res) => {
      watcher.once('ready', () => res());
    });
    log(`[watch] ready ${target.path}`);
    running.push({ watcher, target });
  }

  // 等 abort
  await new Promise<void>((res) => {
    if (signal.aborted) return res();
    signal.addEventListener('abort', () => res(), { once: true });
  });

  // 关所有 watcher
  await Promise.all(running.map((r) => r.watcher.close()));
}

/**
 * 把扩展名列表（'.md', '.pdf'...）拼成 fast-glob 用的"选 N 选 1"模式。
 *  - 0 个 → 没意义，退化为 `**\/*.md` 兜底（不应该出现）
 *  - 1 个 → `**\/*.md`
 *  - N 个 → `**\/*.{md,pdf,docx}`
 */
export function extensionsToGlob(exts: string[]): string {
  const cleaned = Array.from(
    new Set(exts.map((e) => (e.startsWith('.') ? e.slice(1) : e).toLowerCase()).filter(Boolean)),
  );
  if (cleaned.length === 0) return '**/*.md';
  if (cleaned.length === 1) return `**/*.${cleaned[0]}`;
  return `**/*.{${cleaned.join(',')}}`;
}

/**
 * 一个超简化的 glob 匹配：仅支持 `*` 和 `**`（不含 `?` / `[...]` / `{a,b}`）。
 * 想要更准确请引入 micromatch。当前依赖里没有，避免临时增包。
 */
function simpleGlobMatch(input: string, pattern: string): boolean {
  // 把 glob 转 regex：** → .*, * → [^/]*
  const re =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__GLOBSTAR__/g, '.*') +
    '$';
  return new RegExp(re).test(input);
}
