/**
 * 转换器缓存层测试。
 *
 * 关键不变量：
 *   - put → get 命中
 *   - sha 不同 → miss
 *   - converter.version 不同 → miss（不混用旧产物）
 *   - converter.name 不同 → miss（隔离）
 *   - 损坏文件 → miss（不 throw，返回 null）
 *   - put 是原子写（.tmp + rename），并发不撕
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSystemConverterCache,
  NullConverterCache,
  cacheKey,
  cacheKeyString,
  sha256,
} from '../src/wiki/converters/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-conv-cache-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('同字节 + 同名 + 同版本 → 同 key', () => {
    const k1 = cacheKey(Buffer.from('hello'), 'pdf-parse', '1');
    const k2 = cacheKey(Buffer.from('hello'), 'pdf-parse', '1');
    expect(cacheKeyString(k1)).toBe(cacheKeyString(k2));
  });

  it('字节 / 名字 / 版本任一不同 → 不同 key', () => {
    const a = cacheKeyString(cacheKey(Buffer.from('hello'), 'pdf-parse', '1'));
    const b = cacheKeyString(cacheKey(Buffer.from('world'), 'pdf-parse', '1'));
    const c = cacheKeyString(cacheKey(Buffer.from('hello'), 'docx-mammoth', '1'));
    const d = cacheKeyString(cacheKey(Buffer.from('hello'), 'pdf-parse', '2'));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('sha256 直接调用也产出 64 hex', () => {
    expect(sha256(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('FileSystemConverterCache', () => {
  it('put → get 命中并返回原值（含 meta）', async () => {
    const cache = new FileSystemConverterCache(tmpDir);
    const key = cacheKey(Buffer.from('abc'), 'pdf-parse', '1');
    await cache.put(key, { content: 'page1\npage2', meta: { pages: 2 } });
    const got = await cache.get(key);
    expect(got).not.toBeNull();
    expect(got?.content).toBe('page1\npage2');
    expect(got?.meta).toEqual({ pages: 2 });
    expect(typeof got?.cachedAt).toBe('string');
  });

  it('未写过 → null', async () => {
    const cache = new FileSystemConverterCache(tmpDir);
    const key = cacheKey(Buffer.from('xyz'), 'pdf-parse', '1');
    expect(await cache.get(key)).toBeNull();
  });

  it('版本变化 → 旧 key 仍能读，新 key miss', async () => {
    const cache = new FileSystemConverterCache(tmpDir);
    const v1 = cacheKey(Buffer.from('abc'), 'pdf-parse', '1');
    const v2 = cacheKey(Buffer.from('abc'), 'pdf-parse', '2');
    await cache.put(v1, { content: 'old' });
    expect((await cache.get(v1))?.content).toBe('old');
    expect(await cache.get(v2)).toBeNull();
  });

  it('JSON 损坏 → 当作 miss（不 throw）', async () => {
    const cache = new FileSystemConverterCache(tmpDir);
    const key = cacheKey(Buffer.from('abc'), 'pdf-parse', '1');
    await cache.put(key, { content: 'ok' });
    // 找出实际写入的文件并破坏它
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    fs.writeFileSync(path.join(tmpDir, files[0]), '{not json');
    expect(await cache.get(key)).toBeNull();
  });

  it('并发 put 不撕：同一 key 多次写后内容仍可读', async () => {
    const cache = new FileSystemConverterCache(tmpDir);
    const key = cacheKey(Buffer.from('abc'), 'pdf-parse', '1');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        cache.put(key, { content: `v${i}` }),
      ),
    );
    const got = await cache.get(key);
    expect(got).not.toBeNull();
    expect(got!.content).toMatch(/^v[0-7]$/);
  });
});

describe('NullConverterCache', () => {
  it('总是 miss 且 put 是 no-op', async () => {
    const c = new NullConverterCache();
    const key = cacheKey(Buffer.from('abc'), 'x', '1');
    await c.put(key, { content: 'whatever' });
    expect(await c.get(key)).toBeNull();
  });
});
