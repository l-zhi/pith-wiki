import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConvertMeta } from './types.js';

/**
 * 转换器结果缓存。
 *
 * key = sha256(原始字节) + ':' + converter.name + '@' + (converter.version ?? '1')
 *
 *   - sha256：原文变了缓存就该失效
 *   - converter.name + version：换了实现/版本也要失效（同一个 PDF 用 pdf-parse
 *     和将来的 pdf-pdfjs 出来的文本不同）
 *
 * 落盘 `<wikiRoot>/.cache/converters/<sha>.<converter>.json`，结构：
 *   { content: string, meta?: ConvertMeta, cachedAt: ISO 时间戳 }
 *
 * 原子写沿用 `.tmp + rename`（与 LibraryService.put / queue/state.ts 同源）。
 */

export interface CacheEntry {
  content: string;
  meta?: ConvertMeta;
  cachedAt: string;
}

export interface ConverterCache {
  get(key: CacheKey): Promise<CacheEntry | null>;
  put(key: CacheKey, value: { content: string; meta?: ConvertMeta }): Promise<void>;
}

export interface CacheKey {
  sha: string;
  converter: string;
  version: string;
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function cacheKey(bytes: Buffer, converterName: string, version?: string): CacheKey {
  return { sha: sha256(bytes), converter: converterName, version: version ?? '1' };
}

export function cacheKeyString(key: CacheKey): string {
  return `${key.sha}:${key.converter}@${key.version}`;
}

/**
 * 默认实现：文件落盘缓存。多 worker 并发写同 key 走 .tmp + rename，
 * 后写者会覆盖前写者，但内容相同（key 决定）所以不撕。
 */
export class FileSystemConverterCache implements ConverterCache {
  constructor(private readonly rootDir: string) {}

  private filePath(key: CacheKey): string {
    // 文件名用 <sha>.<converter>.json：sha 全长 64 hex 过滤碰撞，converter 名做后缀
    // 同时让 ls 一眼看出哪个转换器产出的
    const safeName = key.converter.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.rootDir, `${key.sha}.${safeName}.json`);
  }

  async get(key: CacheKey): Promise<CacheEntry | null> {
    const file = this.filePath(key);
    if (!fs.existsSync(file)) return null;
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 缓存文件损坏：当作 miss，让上层重跑。下次 put 会覆盖。
      return null;
    }
    if (!isCacheEntry(parsed)) return null;
    if (parsed.version !== key.version) {
      // 版本不匹配（罕见——文件名带 sha+name，但极端情况下 version 嵌在 JSON 里），
      // 视为 miss
      return null;
    }
    return { content: parsed.content, meta: parsed.meta, cachedAt: parsed.cachedAt };
  }

  async put(key: CacheKey, value: { content: string; meta?: ConvertMeta }): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const file = this.filePath(key);
    // 同进程内多并发 put 同一 key：tmp 名要带随机后缀，避免一个 rename 完后
    // 把 tmp 删了，下一个 rename 因找不到 tmp 文件而 ENOENT。
    // pid + 高精度时间 + 随机数足够避碰。
    const unique = `${process.pid}.${Date.now().toString(36)}.${Math.floor(Math.random() * 1e9).toString(36)}`;
    const tmp = `${file}.${unique}.tmp`;
    const payload: StoredEntry = {
      version: key.version,
      converter: key.converter,
      content: value.content,
      meta: value.meta,
      cachedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.promises.rename(tmp, file);
  }
}

/**
 * 一个总是 miss 的缓存实现，给 `--no-cache` / 测试用。
 */
export class NullConverterCache implements ConverterCache {
  async get(): Promise<CacheEntry | null> {
    return null;
  }
  async put(): Promise<void> {
    /* no-op */
  }
}

interface StoredEntry {
  version: string;
  converter: string;
  content: string;
  meta?: ConvertMeta;
  cachedAt: string;
}

function isCacheEntry(v: unknown): v is StoredEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === 'string' &&
    typeof o.converter === 'string' &&
    typeof o.content === 'string' &&
    typeof o.cachedAt === 'string'
  );
}
