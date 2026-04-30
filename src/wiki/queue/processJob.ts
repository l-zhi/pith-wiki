import path from 'node:path';
import type { HydrationService } from '../hydration.js';
import type { LibraryService } from '../library.js';
import type { Entry } from '../types.js';

/**
 * 单文件 ingest 的核心处理：
 *   - 去重（基于 source.value 绝对路径）
 *   - 读文件 → hydrate（含 429 指数退避，单次 attempt 内）
 *   - id 冲突避让（claimUniqueId 自动加 -2 / -3 后缀）
 *   - LibraryService.put 落盘
 *
 * 同时被 `batch.runBatch`（一次性批量）和 `queue.runner`（持久化队列）复用。
 * 这里只负责"把一个文件变成 entry"——批次/队列管理（计数、去重 jobId、状态机）
 * 在调用方完成。
 */

export interface FileResult {
  /** 绝对路径。 */
  file: string;
  status: 'ok' | 'skipped' | 'failed';
  /** ok 时存在；如果发生 id 冲突，这是去重后的最终 id（可能带 -N 后缀）。 */
  id?: string;
  /** 跳过 / 失败时的原因。 */
  reason?: string;
  /**
   * hydrate 实际尝试次数（含成功的那次）。429 重试后这里会大于 1。
   * 注意：这是单次 processJob 调用内的 attempt 数，与队列级 attempts 不同。
   */
  attempts: number;
}

export interface ProcessJobCtx {
  collection: string;
  force: boolean;
  hydrator: HydrationService;
  library: LibraryService;
  /** 调用方持有的当前 collection entry 快照；hydrator 用于 linkCandidates。 */
  existingEntries: Entry[];
  /** 与 existingEntries 同步：源路径已存在则跳过（non-force）。 */
  existingPaths: Set<string>;
  /** id 命名空间；冲突时自动追加 -2 / -3 后缀，并把最终 id 写回。 */
  claimedIds: Set<string>;
}

/**
 * 把 entry.source.value 解析成绝对路径——兼容 v0.1 时代以相对路径写入的旧条目。
 * 对相对路径用 cwd 兜底，反正比对的是 candidate 自己的绝对路径，能匹配上即可。
 */
export function resolveSourcePath(value: string | undefined): string | null {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/** 在 claimedIds 里给 base 找一个空闲的派生 id：base、base-2、base-3、…… */
export function claimUniqueId(base: string, claimedIds: Set<string>): string {
  if (!claimedIds.has(base)) return base;
  let suffix = 2;
  while (claimedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * 处理单个文件：去重 → hydrate（带 429 重试）→ 解决 id 冲突 → 落盘。
 *
 * 重试 + 冲突避让的关键不变量：
 *   - attempts 永远反映真实尝试次数（含 429 重试），即使最终失败
 *   - --force 重新入库时，如果 hydrator 返回的 id 与"该文件之前对应的旧 entry id"相同，
 *     视为合法覆盖（不走 -2 避让）；否则按通用避让规则处理
 */
export async function processJob(absFile: string, ctx: ProcessJobCtx): Promise<FileResult> {
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
    throw new Error('processJob: unreachable hydrate fallthrough');
  }

  // id 冲突避让：
  //   - 如果是 --force 覆盖同一个文件、且新 id 与旧 id 相同 → 直接用，不避让
  //   - 否则：把已有 id 视作占用，自动追加 -2 / -3 后缀
  const isOverwriteOfSelf = priorEntry?.id === entry.id;
  const finalId = isOverwriteOfSelf ? entry.id : claimUniqueId(entry.id, ctx.claimedIds);
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

export function formatResultLine(n: number, total: number, r: FileResult): string {
  const file = r.file;
  const counter = `[${n}/${total}]`;
  const retryNote =
    r.attempts > 1 ? `, ${r.attempts - 1} retr${r.attempts > 2 ? 'ies' : 'y'}` : '';
  switch (r.status) {
    case 'ok':
      return `${counter} ${file} ✓ ingested as ${r.id}${retryNote}`;
    case 'skipped':
      return `${counter} ${file} ⊘ skipped (${r.reason ?? 'duplicate'})`;
    case 'failed':
      return `${counter} ${file} ✗ failed: ${r.reason ?? 'unknown'}${retryNote}`;
  }
}
