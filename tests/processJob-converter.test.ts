/**
 * processJob 与转换器层 / 缓存层的集成测试。
 *
 * 关注：
 *   - 默认按扩展名解析 → 内置 markdown-passthrough
 *   - --converter <name> 强指定（绕过扩展名）
 *   - 缓存命中：第二次 ingest 同文件不再调 converter
 *   - hydrate 看到的 source 含 convertedBy
 *   - 转换器空输出 → permanent 失败
 *
 * mock 一个假 hydrator，避免真实 LLM 调用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { HydrationService, HydrateInput } from '../src/wiki/hydration.js';
import type { Entry } from '../src/wiki/types.js';
import {
  ConverterRegistry,
  defaultConverters,
  FileSystemConverterCache,
  type Converter,
} from '../src/wiki/converters/index.js';
import { processJob } from '../src/wiki/queue/processJob.js';

let tmpDir: string;
let library: LibraryService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-pj-conv-'));
  library = new LibraryService(tmpDir);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

interface FakeHydratorOpts {
  errorOnce?: unknown;
}

function makeFakeHydrator(opts: FakeHydratorOpts = {}): {
  hydrator: HydrationService;
  calls: HydrateInput[];
} {
  const calls: HydrateInput[] = [];
  let triggered = false;
  const hydrator = {
    hydrate: async (input: HydrateInput): Promise<Entry> => {
      calls.push(input);
      if (opts.errorOnce && !triggered) {
        triggered = true;
        throw opts.errorOnce;
      }
      const id = path.basename(input.source.value ?? 'inline', '.md');
      return {
        id,
        collection: input.collectionId,
        title: id,
        summary: '',
        tags: [],
        links: [],
        content: input.rawContent,
        source: input.source,
        updated: new Date().toISOString(),
      };
    },
  } as unknown as HydrationService;
  return { hydrator, calls };
}

function makeRegistry(): ConverterRegistry {
  const r = new ConverterRegistry();
  for (const c of defaultConverters()) r.register(c);
  return r;
}

describe('processJob + converter pipeline', () => {
  it('按扩展名解析 → markdown-passthrough，hydrate 收到含 convertedBy 的 source', async () => {
    const file = path.join(tmpDir, 'a.md');
    fs.writeFileSync(file, '# heading\n\nbody', 'utf8');
    const { hydrator, calls } = makeFakeHydrator();
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: makeRegistry(),
    });
    expect(result.status).toBe('ok');
    expect(result.convertedBy).toBe('markdown-passthrough');
    expect(calls).toHaveLength(1);
    expect(calls[0].source.convertedBy).toBe('markdown-passthrough');
    expect(calls[0].rawContent).toBe('# heading\n\nbody');
  });

  it('--converter 强指定绕过扩展名解析', async () => {
    const file = path.join(tmpDir, 'a.md');
    fs.writeFileSync(file, 'plain text', 'utf8');
    const { hydrator, calls } = makeFakeHydrator();
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: makeRegistry(),
      converter: 'text-passthrough',
    });
    expect(result.status).toBe('ok');
    expect(result.convertedBy).toBe('text-passthrough');
    expect(calls[0].source.convertedBy).toBe('text-passthrough');
  });

  it('未知 converter 名 → permanent 失败（不该被退避重试）', async () => {
    const file = path.join(tmpDir, 'a.md');
    fs.writeFileSync(file, 'x', 'utf8');
    const { hydrator } = makeFakeHydrator();
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: makeRegistry(),
      converter: 'no-such',
    });
    expect(result.status).toBe('failed');
    expect(result.permanent).toBe(true);
    expect(result.reason).toMatch(/unknown converter "no-such"/);
  });

  it('转换器输出纯空白 → EmptyConversionError + permanent', async () => {
    const file = path.join(tmpDir, 'a.weird');
    fs.writeFileSync(file, '   \t\n   ', 'utf8');
    const reg = new ConverterRegistry();
    const blank: Converter = {
      name: 'blank',
      extensions: ['.weird'],
      async convert({ bytes }) {
        return { content: bytes.toString('utf8') };
      },
    };
    reg.register(blank);
    const { hydrator } = makeFakeHydrator();
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: reg,
    });
    expect(result.status).toBe('failed');
    expect(result.permanent).toBe(true);
    expect(result.reason).toMatch(/produced empty output/);
  });

  it('缓存命中：第二次跑同文件转换器不再被调用', async () => {
    const file = path.join(tmpDir, 'cache-target.md');
    fs.writeFileSync(file, 'cached body content', 'utf8');
    const reg = new ConverterRegistry();
    let convertCount = 0;
    const counted: Converter = {
      name: 'counted',
      version: '1',
      extensions: ['.md'],
      priority: 100, // 覆盖内置 markdown-passthrough
      async convert({ bytes }) {
        convertCount += 1;
        return { content: bytes.toString('utf8'), meta: { pages: 1 } };
      },
    };
    for (const c of defaultConverters()) reg.register(c);
    reg.register(counted);
    const cacheDir = path.join(tmpDir, '.cache');
    const cache = new FileSystemConverterCache(cacheDir);
    const { hydrator } = makeFakeHydrator();

    // 第一次：convert 被调用 1 次
    const r1 = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: reg,
      cache,
    });
    expect(r1.status).toBe('ok');
    expect(r1.cacheHit).toBe(false);
    expect(convertCount).toBe(1);

    // 第二次（force=true 让 hydrate 重跑、跳过去重）：convert 不再被调，命中缓存
    const r2 = await processJob(file, {
      collection: 'tech',
      force: true,
      hydrator,
      library,
      existingEntries: library.list('tech'),
      existingPaths: new Set([file]),
      claimedIds: new Set(library.list('tech').map((e) => e.id)),
      converterRegistry: reg,
      cache,
    });
    expect(r2.status).toBe('ok');
    expect(r2.cacheHit).toBe(true);
    expect(convertCount).toBe(1); // 没增长
  });

  it('非 passthrough 转换器 + subpath：sidecar 落 <wikiRoot>/<collection>/<subpath>/.cache/<basename>.md', async () => {
    const file = path.join(tmpDir, 'src', 'a.weird');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'raw bytes', 'utf8');
    const reg = new ConverterRegistry();
    const fake: Converter = {
      name: 'fake-pdf',
      extensions: ['.weird'],
      async convert({ bytes }) {
        return { content: `# extracted\n\n${bytes.toString('utf8')}` };
      },
    };
    reg.register(fake);
    const calls: HydrateInput[] = [];
    const hydrator = {
      hydrate: async (input: HydrateInput): Promise<Entry> => {
        calls.push(input);
        return {
          id: 'paper-a',
          collection: input.collectionId,
          title: 'paper-a',
          summary: '',
          tags: [],
          links: [],
          content: input.rawContent,
          source: input.source,
          updated: new Date().toISOString(),
        };
      },
    } as unknown as HydrationService;
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: reg,
      subpath: 'sub',
    });
    expect(result.status).toBe('ok');
    const expectedCache = path.join(tmpDir, 'tech', 'sub', '.cache', 'a.md');
    expect(calls[0].source.cachePath).toBe(expectedCache);
    expect(fs.existsSync(expectedCache)).toBe(true);
    expect(fs.readFileSync(expectedCache, 'utf8')).toBe('# extracted\n\nraw bytes');
    const saved = library.get('paper-a');
    expect(saved?.source.cachePath).toBe(expectedCache);
    expect(saved?.source.value).toBe(file);
  });

  it('subpath 缺省时 sidecar 落 <wikiRoot>/<collection>/.cache/<basename>.md', async () => {
    const file = path.join(tmpDir, 'root.weird');
    fs.writeFileSync(file, 'r', 'utf8');
    const reg = new ConverterRegistry();
    reg.register({
      name: 'fake',
      extensions: ['.weird'],
      async convert({ bytes }) {
        return { content: `# ${bytes.toString('utf8')}` };
      },
    });
    const hydrator = {
      hydrate: async (input: HydrateInput): Promise<Entry> => ({
        id: 'root-entry',
        collection: input.collectionId,
        title: 'root',
        summary: '',
        tags: [],
        links: [],
        content: input.rawContent,
        source: input.source,
        updated: new Date().toISOString(),
      }),
    } as unknown as HydrationService;
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: reg,
    });
    expect(result.status).toBe('ok');
    const expected = path.join(tmpDir, 'tech', '.cache', 'root.md');
    expect(fs.existsSync(expected)).toBe(true);
    const saved = library.get('root-entry');
    expect(saved?.source.cachePath).toBe(expected);
  });

  it('ctx.subpath 被钉到 entry 上，落盘到 <wikiRoot>/<collection>/<subpath>/<id>.md', async () => {
    const file = path.join(tmpDir, 'note.md');
    fs.writeFileSync(file, '# body', 'utf8');
    const calls: HydrateInput[] = [];
    const hydrator = {
      hydrate: async (input: HydrateInput): Promise<Entry> => {
        calls.push(input);
        return {
          id: 'mirrored',
          collection: input.collectionId,
          title: 'mirrored',
          summary: '',
          tags: [],
          links: [],
          content: input.rawContent,
          source: input.source,
          updated: new Date().toISOString(),
        };
      },
    } as unknown as HydrationService;
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: makeRegistry(),
      subpath: 'a/b',
    });
    expect(result.status).toBe('ok');
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'a', 'b', 'mirrored.md'))).toBe(true);
    const saved = library.get('mirrored');
    expect(saved?.subpath).toBe('a/b');
  });

  it('markdown-passthrough → 不写 sidecar，cachePath 留空', async () => {
    const file = path.join(tmpDir, 'a.md');
    fs.writeFileSync(file, '# direct markdown', 'utf8');
    const { hydrator, calls } = makeFakeHydrator();
    const result = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      converterRegistry: makeRegistry(),
    });
    expect(result.status).toBe('ok');
    expect(calls[0].source.cachePath).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'tech', '.cache'))).toBe(false);
  });

  it('未提供 converterRegistry → 走默认单例（仍能处理 .md）', async () => {
    const file = path.join(tmpDir, 'a.md');
    fs.writeFileSync(file, 'hello md', 'utf8');
    const { hydrator } = makeFakeHydrator();
    const r = await processJob(file, {
      collection: 'tech',
      force: false,
      hydrator,
      library,
      existingEntries: [],
      existingPaths: new Set(),
      claimedIds: new Set(),
      // 故意不传 converterRegistry
    });
    expect(r.status).toBe('ok');
    expect(r.convertedBy).toBe('markdown-passthrough');
  });
});
