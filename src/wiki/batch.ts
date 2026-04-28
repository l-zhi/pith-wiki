import path from 'node:path';
import PQueue from 'p-queue';
import type { HydrationService } from './hydration.js';
import type { LibraryService } from './library.js';
import type { Entry } from './types.js';

/**
 * 批量 ingest 编排器。
 *
 * 职责：
 *   1. 拿到一组绝对路径文件 → 跟现有 entry 的 source.value 对比做去重
 *   2. 用 p-queue 并发跑 hydration，每个失败的请求带 429 指数退避重试
 *   3. 处理 LLM 偶尔产出重复 id 的情况：批内维护一个 claimedIds Set，碰撞时
 *      自动追加 `-2`、`-3`、… 后缀
 *   4. 批量场景下让 hydration 复用一次 snapshot 的 linkCandidates，避免
 *      LibraryService 反链索引被高频 invalidate 拖慢
 *
 * 不在本模块责任内：
 *   - 文件枚举（glob/dir 由 subcommands.ts 处理后传入 absolute paths 数组）
 *   - 用户输出格式（log 函数由调用方注入）
 *   - 子进程 / Ctrl-C 优雅退出（v0.2 best-effort，靠 process 信号）
 */

export interface BatchOptions {
  /** 已枚举的绝对路径列表。空数组合法，调用方自己处理"0 匹配"。 */
  files: string[];
  collection: string;
  /** true → 跳过去重检查、强制重脱水覆盖。 */
  force: boolean;
  concurrency: number;
  hydrator: HydrationService;
  library: LibraryService;
  /** 单行日志回调；调用方决定怎么输出（chalk / 普通 console.log / 测试 spy）。 */
  log: (line: string) => void;
}

export interface FileResult {
  /** 绝对路径。 */
  file: string;
  status: 'ok' | 'skipped' | 'failed';
  /** ok 时存在；如果发生 id 冲突，这是去重后的最终 id（可能带 -N 后缀）。 */
  id?: string;
  /** 跳过 / 失败时的原因。 */
  reason?: string;
  /** hydrate 实际尝试次数（含成功的那次）。429 重试后这里会大于 1。 */
  attempts: number;
}

export interface BatchSummary {
  results: FileResult[];
  ok: number;
  skipped: number;
  failed: number;
}

/**
 * 把 entry.source.value 解析成绝对路径——兼容 v0.1 时代以相对路径写入的旧条目。
 * 对相对路径用 cwd 兜底，反正比对的是 candidate 自己的绝对路径，能匹配上即可。
 */
function resolveSourcePath(value: string | undefined): string | null {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/** 在 claimedIds 里给 base 找一个空闲的派生 id：base、base-2、base-3、…… */
function claimUniqueId(base: string, claimedIds: Set<string>): string {
  if (!claimedIds.has(base)) return base;
  let suffix = 2;
  while (claimedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export async function runBatch(opts: BatchOptions): Promise<BatchSummary> {
  // 1. 一次性 snapshot 现有条目：candidates 用作 linkCandidates、existingPaths 用作去重、
  //    claimedIds 用作 id 命名空间。三者只在批次开始前读一次。
  const existingEntries: Entry[] = opts.library.list(opts.collection);
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
      const result = await processOne(absFile, {
        collection: opts.collection,
        force: opts.force,
        hydrator: opts.hydrator,
        library: opts.library,
        existingEntries,
        existingPaths,
        claimedIds,
      });
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

interface ProcessOneCtx {
  collection: string;
  force: boolean;
  hydrator: HydrationService;
  library: LibraryService;
  existingEntries: Entry[];
  existingPaths: Set<string>;
  claimedIds: Set<string>;
}

/**
 * 处理单个文件：去重 → hydrate（带 429 重试）→ 解决 id 冲突 → 落盘。
 *
 * 重试 + 冲突避让的关键不变量：
 *   - attempts 永远反映真实尝试次数（含 429 重试），即使最终失败
 *   - --force 重新入库时，如果 hydrator 返回的 id 与"该文件之前对应的旧 entry id"相同，
 *     视为合法覆盖（不走 -2 避让）；否则按通用避让规则处理
 */
async function processOne(absFile: string, ctx: ProcessOneCtx): Promise<FileResult> {
  // 同源路径之前对应的 entry（可能不存在）。
  const priorEntry = ctx.existingEntries.find(
    (e) => resolveSourcePath(e.source?.value) === absFile,
  );

  // 去重：non-force 模式下，源路径已存在的文件直接跳过。
  if (!ctx.force && priorEntry) {
    return {
      file: absFile,
      status: 'skipped',
      reason: `already ingested as ${priorEntry.id}`,
      id: priorEntry.id,
      attempts: 0,
    };
  }

  // 读文件
  let raw: string;
  try {
    raw = await readFileUtf8(absFile);
  } catch (err) {
    return {
      file: absFile,
      status: 'failed',
      reason: `read error: ${(err as Error).message}`,
      attempts: 0,
    };
  }

  // hydrate（带 429 退避）。把重试逻辑内联是为了让 attempts 在失败路径也能正确传出。
  const filename = path.basename(absFile);
  const maxRetries = 3;
  let attempts = 0;
  let entry: Entry | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    attempts = attempt;
    try {
      entry = await ctx.hydrator.hydrate({
        rawContent: raw,
        collectionId: ctx.collection,
        source: { type: 'file', value: absFile },
        linkCandidates: ctx.existingEntries,
        filenameHint: filename,
      });
      break;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 429 && attempt <= maxRetries) {
        // 1s, 2s, 4s ...
        await new Promise((r) => setTimeout(r, 2 ** (attempt - 1) * 1000));
        continue;
      }
      const reason = status
        ? `hydration failed (status ${status}): ${(err as Error).message}`
        : `hydration failed: ${(err as Error).message}`;
      return { file: absFile, status: 'failed', reason, attempts };
    }
  }
  if (!entry) {
    // 类型守卫：循环要么 break（entry 被赋值）要么 return，永远走不到这里。
    throw new Error('processOne: unreachable hydrate fallthrough');
  }

  // id 冲突避让：
  //   - 如果是 --force 覆盖同一个文件、且新 id 与旧 id 相同 → 直接用，不避让
  //   - 否则：把已有 id 视作占用，自动追加 -2 / -3 后缀
  const isOverwriteOfSelf = priorEntry?.id === entry.id;
  const finalId = isOverwriteOfSelf
    ? entry.id
    : claimUniqueId(entry.id, ctx.claimedIds);
  if (finalId !== entry.id) {
    entry = { ...entry, id: finalId };
  }
  ctx.claimedIds.add(finalId);

  try {
    ctx.library.put(entry);
  } catch (err) {
    return {
      file: absFile,
      status: 'failed',
      reason: `library.put failed: ${(err as Error).message}`,
      attempts,
    };
  }

  return {
    file: absFile,
    status: 'ok',
    id: finalId,
    attempts,
  };
}

async function readFileUtf8(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(file, 'utf8');
}

function formatResultLine(n: number, total: number, r: FileResult): string {
  const file = r.file;
  const counter = `[${n}/${total}]`;
  const retryNote = r.attempts > 1 ? `, ${r.attempts - 1} retr${r.attempts > 2 ? 'ies' : 'y'}` : '';
  switch (r.status) {
    case 'ok':
      return `${counter} ${file} ✓ ingested as ${r.id}${retryNote}`;
    case 'skipped':
      return `${counter} ${file} ⊘ skipped (${r.reason ?? 'duplicate'})`;
    case 'failed':
      return `${counter} ${file} ✗ failed: ${r.reason ?? 'unknown'}${retryNote}`;
  }
}
