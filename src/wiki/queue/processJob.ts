import path from 'node:path';
import fs from 'node:fs';
import type { HydrationService } from '../hydration.js';
import type { LibraryService } from '../library.js';
import type { Entry } from '../types.js';
import { ConverterRegistry } from '../converters/registry.js';
import type { ConverterCache, CacheKey } from '../converters/cache.js';
import { cacheKey, cacheKeyString, NullConverterCache } from '../converters/cache.js';
import { EmptyConversionError, type ConvertProgress } from '../converters/types.js';
import { defaultConverters } from '../converters/index.js';
import { writeCacheSidecar } from '../converters/sidecar.js';

/**
 * 走过 passthrough 转换器（源已经是 markdown / 纯文本）的不写 sidecar：
 * 源文件本身就是 LLM 可读的，再 copy 一份是冗余的，且 wiki_read_source 直接读
 * source.value 行为已经正确。
 */
const PASSTHROUGH_CONVERTERS = new Set(['markdown-passthrough', 'text-passthrough']);

let _defaultRegistrySingleton: ConverterRegistry | null = null;
/**
 * 缺省共享的转换器注册表（用于 ProcessJobCtx.converterRegistry 不显式传时）。
 * 懒构造 + 单例：避免每次 processJob 调用都重新注册一遍内置。
 */
function defaultRegistry(): ConverterRegistry {
  if (_defaultRegistrySingleton) return _defaultRegistrySingleton;
  const r = new ConverterRegistry();
  for (const c of defaultConverters()) r.register(c);
  _defaultRegistrySingleton = r;
  return r;
}

/**
 * 单文件 ingest 的核心处理：
 *   - 去重（基于 source.value 绝对路径）
 *   - 读字节 → 转换器（按扩展名 / 强指定）→ 命中 sha256 缓存就直接复用
 *   - hydrate（含 429 指数退避，单次 attempt 内）
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
  /** 走过的 converter 名字（命中缓存也会填）；纯失败时可能为空。 */
  convertedBy?: string;
  /** 该次 processJob 是否命中转换器缓存。 */
  cacheHit?: boolean;
  /**
   * 这次失败应该被永久标记吗？processJob 在 EmptyConversion / 缺缓存的转换器
   * 等"重试也无意义"的情况下设 true，调用方（runner）据此把 job 直接打 dead。
   */
  permanent?: boolean;
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
  /**
   * 转换器注册表。可选——缺省走内置默认（markdown / text / pdf / docx / html）。
   * REPL / 库消费者一般会传一份共享的实例（方便宿主注册自定义转换器）。
   */
  converterRegistry?: ConverterRegistry;
  /**
   * 转换器结果缓存。可选，缺省走 NullConverterCache（每次都重跑转换）。
   * 库消费者在 buildContext 时根据 config.cacheConverted 决定塞 FS 还是 Null。
   */
  cache?: ConverterCache;
  /** 强指定转换器名（绕过 ConverterRegistry 的扩展名解析）。 */
  converter?: string;
  /**
   * 推导 sidecar 相对路径的根。缺省时退化为 path.dirname(absFile)，sidecar 扁平
   * 落在 `<wikiRoot>/<collection>/.cache/<basename>.md`。
   * watcher 调用方应传 target.path；CLI subcommands 可以传 --source-root，或不传走扁平。
   */
  sourceRoot?: string;
  /** 长转换器进度回调，runner 桥到 queue events。 */
  onConvertProgress?(p: ConvertProgress): void;
  /** 用户取消（Ctrl+C / Electron 关页）。 */
  signal?: AbortSignal;
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
 * 处理单个文件：去重 → convert（可缓存）→ hydrate（带 429 重试）→ 解决 id 冲突 → 落盘。
 *
 * 重试 + 冲突避让的关键不变量：
 *   - attempts 永远反映真实尝试次数（含 429 重试），即使最终失败
 *   - --force 重新入库时，如果 hydrator 返回的 id 与"该文件之前对应的旧 entry id"相同，
 *     视为合法覆盖（不走 -2 避让）；否则按通用避让规则处理
 *
 * permanent 失败标识：转换器空输出（EmptyConversionError）和 UnknownConverterError
 * 不应该被退避重试——它们的根因是配置 / 内容问题，重跑结果不会变。runner 会据此
 * 直接打 dead 状态。
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

  // 读字节
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(absFile);
  } catch (err) {
    return {
      file: absFile,
      status: 'failed',
      reason: `read error: ${(err as Error).message}`,
      attempts: 0,
    };
  }

  // 解析转换器
  let converter;
  const registry = ctx.converterRegistry ?? defaultRegistry();
  try {
    converter = registry.resolve(absFile, { force: ctx.converter });
  } catch (err) {
    return {
      file: absFile,
      status: 'failed',
      reason: `converter resolution failed: ${(err as Error).message}`,
      attempts: 0,
      permanent: true,
    };
  }

  // 转换：先查缓存，miss 再调 convert()
  const cache = ctx.cache ?? new NullConverterCache();
  const key: CacheKey = cacheKey(bytes, converter.name, converter.version);
  let convOut: { content: string; meta?: Record<string, unknown> };
  let cacheHit = false;
  try {
    const cached = await cache.get(key);
    if (cached) {
      convOut = { content: cached.content, meta: cached.meta };
      cacheHit = true;
    } else {
      const result = await converter.convert(
        { filePath: absFile, bytes },
        { signal: ctx.signal, onProgress: ctx.onConvertProgress },
      );
      // 真空（length=0）或纯空白：抛 EmptyConversionError 让 runner 直接打 dead，
      // 不浪费 LLM 配额（典型场景：扫描 PDF 没 OCR、损坏文件解析失败）。
      // 只挡硬空——故意不挡"很短"，让用户拥有 ingest tiny markdown 的自由。
      if (!result.content || result.content.trim().length === 0) {
        throw new EmptyConversionError(
          `${converter.name} produced empty output for ${path.basename(absFile)}`,
        );
      }
      convOut = result;
      // 不阻塞主路径：缓存写失败不算转换失败
      await cache.put(key, { content: result.content, meta: result.meta }).catch(() => undefined);
    }
  } catch (err) {
    const isEmpty = err instanceof EmptyConversionError;
    return {
      file: absFile,
      status: 'failed',
      reason: isEmpty
        ? (err as Error).message
        : `convert (${converter.name}) failed: ${(err as Error).message}`,
      attempts: 0,
      convertedBy: converter.name,
      permanent: isEmpty,
    };
  }

  // sidecar：把转换后的 markdown 落地到 <wikiRoot>/<collection>/.cache/<rel>.md。
  // 仅对非 passthrough 转换器写（passthrough 源就是 markdown / text，sidecar 是冗余 copy）。
  // 即使 cache 命中也写：sidecar 可能被用户手动删过，每次都覆盖一次保持磁盘状态一致。
  // 失败不阻塞主路径：sidecar 是衍生品，丢了 wiki_read_source 回退到 source.value 也能用。
  let cachePath: string | undefined;
  if (!PASSTHROUGH_CONVERTERS.has(converter.name)) {
    try {
      cachePath = writeCacheSidecar({
        wikiRoot: ctx.library.getWikiRoot(),
        collection: ctx.collection,
        sourceRoot: ctx.sourceRoot,
        absFile,
        content: convOut.content,
      });
    } catch {
      cachePath = undefined;
    }
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
        rawContent: convOut.content,
        collectionId: ctx.collection,
        source: {
          type: 'file',
          value: absFile,
          convertedBy: converter.name,
          ...(cachePath ? { cachePath } : {}),
        },
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
      return {
        file: absFile,
        status: 'failed',
        reason,
        attempts,
        convertedBy: converter.name,
        cacheHit,
      };
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
      convertedBy: converter.name,
      cacheHit,
    };
  }

  return {
    file: absFile,
    status: 'ok',
    id: finalId,
    attempts,
    convertedBy: converter.name,
    cacheHit,
  };
}

export function formatResultLine(n: number, total: number, r: FileResult): string {
  const file = r.file;
  const counter = `[${n}/${total}]`;
  const retryNote =
    r.attempts > 1 ? `, ${r.attempts - 1} retr${r.attempts > 2 ? 'ies' : 'y'}` : '';
  const cacheNote = r.cacheHit ? ' (cache hit)' : '';
  switch (r.status) {
    case 'ok':
      return `${counter} ${file} ✓ ingested as ${r.id}${cacheNote}${retryNote}`;
    case 'skipped':
      return `${counter} ${file} ⊘ skipped (${r.reason ?? 'duplicate'})`;
    case 'failed': {
      const permTag = r.permanent ? ' [permanent]' : '';
      return `${counter} ${file} ✗ failed: ${r.reason ?? 'unknown'}${permTag}${retryNote}`;
    }
  }
}

/** 用记忆 cacheKey 字符串便于日志/调试。 */
export function describeCacheKey(bytes: Buffer, converterName: string, version?: string): string {
  return cacheKeyString(cacheKey(bytes, converterName, version));
}
