import path from 'node:path';
import PQueue from 'p-queue';
import type { HydrationService } from './hydration.js';
import type { LibraryService } from './library.js';
import type { Entry } from './types.js';
import type { ConverterRegistry } from './converters/registry.js';
import type { ConverterCache } from './converters/cache.js';
import {
  processJob,
  resolveSourcePath,
  formatResultLine,
  type FileResult,
} from './queue/processJob.js';

/**
 * 给一个文件计算它在 collection 内的 subpath（POSIX 形式）。
 * 单个 batchRoot 下，subpath = 文件 dirname 相对 batchRoot；落根 → undefined。
 * 用于 CLI `--dir` 类批量入库：dir 当作 collection 物理根，子目录镜像为 subpath。
 */
function deriveSubpathFromRoot(absFile: string, batchRoot: string): string | undefined {
  const rel = path.relative(batchRoot, path.dirname(absFile));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const segs = rel.split(path.sep).filter((s) => s && !s.startsWith('.'));
  if (segs.length === 0) return undefined;
  return segs.join('/');
}

/**
 * 批量 ingest 编排器（一次性、内存内）。
 *
 * 职责：
 *   1. 拿到一组绝对路径文件 → 跟现有 entry 的 source.value 对比做去重
 *   2. 用 p-queue 并发跑 hydration（单文件逻辑复用 queue/processJob.ts）
 *   3. 处理 LLM 偶尔产出重复 id 的情况：批内维护一个 claimedIds Set
 *   4. 每个成功 job 后刷新 linkCandidates（同 queue runner），让后面的文件
 *      能链接到本批刚写入的条目。claimedIds 仍是整批共享的一个 Set。
 *
 * 不在本模块责任内：
 *   - 文件枚举（glob/dir 由 subcommands.ts 处理后传入 absolute paths 数组）
 *   - 用户输出格式（log 函数由调用方注入）
 *   - 跨进程持久化（持久化队列见 src/wiki/queue/）
 */

export type { FileResult } from './queue/processJob.js';

export interface BatchOptions {
  /** 已枚举的绝对路径列表。空数组合法，调用方自己处理"0 匹配"。 */
  files: string[];
  collection: string;
  /** true → 跳过去重检查、强制重脱水覆盖。 */
  force: boolean;
  concurrency: number;
  hydrator: HydrationService;
  library: LibraryService;
  /**
   * 转换器注册表。可选——缺省由 processJob 用内置默认转换器单例兜底。
   * 想用自定义/host 注入的转换器时传一份。
   */
  converterRegistry?: ConverterRegistry;
  /** 转换结果缓存。可选；默认 NullConverterCache（不缓存）。 */
  cache?: ConverterCache;
  /** 强指定转换器名（适用于整批文件强走同一个转换器，比如 --converter）。 */
  converter?: string;
  /**
   * 派生 subpath 的批根目录。常见做法：把 ingest --dir 的目录传进来，
   * 每个文件 dirname 相对它推出 subpath；缺省 = 所有 entry 落 collection 根。
   */
  batchRoot?: string;
  /** 单行日志回调；调用方决定怎么输出（chalk / 普通 console.log / 测试 spy）。 */
  log: (line: string) => void;
}

export interface BatchSummary {
  results: FileResult[];
  ok: number;
  skipped: number;
  failed: number;
}

export async function runBatch(opts: BatchOptions): Promise<BatchSummary> {
  // linkCandidates 随成功 put 刷新，后启动的 job 才能链到刚写入的条目。
  // claimedIds 整批共享：processJob 在返回前同步 add，换一份 Set 会让尚在飞的
  // job 和后启动的 job 各看各的占用。
  let existingEntries: Entry[] = opts.library.list(opts.collection);
  const existingPaths = new Set<string>();
  const claimedIds = new Set<string>();
  for (const e of existingEntries) {
    const abs = resolveSourcePath(e.source?.value);
    if (abs) existingPaths.add(abs);
    claimedIds.add(e.id);
  }

  const total = opts.files.length;
  const results: FileResult[] = [];
  const queue = new PQueue({ concurrency: opts.concurrency });
  // 完成计数：按完成顺序生成 [N/Total]，与启动顺序解耦。
  let completed = 0;

  for (const absFile of opts.files) {
    queue.add(async () => {
      // CLI --dir 下，每个文件相对 batchRoot 的 dirname 直接派生为 subpath
      // → entry 落 <collection>/<subpath>/<id>.md，sidecar 落 .../.cache/<basename>.md
      const subpath = opts.batchRoot ? deriveSubpathFromRoot(absFile, opts.batchRoot) : undefined;
      const result = await processJob(absFile, {
        collection: opts.collection,
        force: opts.force,
        hydrator: opts.hydrator,
        library: opts.library,
        existingEntries,
        existingPaths,
        claimedIds,
        converterRegistry: opts.converterRegistry,
        cache: opts.cache,
        converter: opts.converter,
        subpath,
      });
      if (result.status === 'ok') {
        existingEntries = opts.library.list(opts.collection);
      }
      completed += 1;
      results.push(result);
      opts.log(formatResultLine(completed, total, result));
    });
  }

  await queue.onIdle();

  // results 的顺序 = 完成顺序，不是输入顺序。这是有意为之——summary 用 counts 聚合即可。
  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  return { results, ok, skipped, failed };
}
