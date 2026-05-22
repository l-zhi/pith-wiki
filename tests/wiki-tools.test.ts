/**
 * 新增 wiki 工具的单测：wiki_list、wiki_read_source。
 * 同时验证 wiki_query 结果里 references 字段（rich source info）的形状。
 *
 * 目标：把"模型可以浏览索引、可以读原文"这条新增的检索链路焊死，
 * 防止重构 assembler / library 时悄悄把工具回包破坏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextAssembler } from '../src/wiki/assembler.js';
import { LibraryService } from '../src/wiki/library.js';
import type { Entry } from '../src/wiki/types.js';
import { wikiListTool } from '../src/tools/wiki_list.js';
import { wikiReadSourceTool } from '../src/tools/wiki_read_source.js';
import { wikiQueryTool } from '../src/tools/wiki_query.js';
import type { ToolContext } from '../src/tools/index.js';
import type { Config } from '../src/config.js';

let tmpRoot: string;
let workspaceRoot: string;
let wikiRoot: string;
let library: LibraryService;
let ctx: ToolContext;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-tools-'));
  workspaceRoot = path.join(tmpRoot, 'workspace');
  wikiRoot = path.join(tmpRoot, 'wiki');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(wikiRoot, { recursive: true });
  library = new LibraryService(wikiRoot);

  const config = {
    workspaceRoot,
    wikiRoot,
    maxToolPayloadBytes: 100_000,
    readOnly: false,
    additionalReadPaths: [],
  } as unknown as Config;

  ctx = {
    config,
    library,
    assembler: new ContextAssembler(library),
    // 这两块不被本测试涉及；用最小占位让 ToolContext 类型契约满足
    hydrator: {} as never,
    approvedWritePaths: new Set(),
    requestApproval: async () => 'no',
  };
});

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function makeEntry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? '# x\n\nbody',
    source: o.source ?? { type: 'inline' },
    updated: o.updated ?? new Date().toISOString(),
  };
}

// ---- wiki_list ----

describe('wiki_list', () => {
  it('无参数 → 返回所有 entry，按 updated 降序', async () => {
    library.put(makeEntry({ id: 'old', updated: '2026-01-01T00:00:00.000Z' }));
    library.put(makeEntry({ id: 'mid', updated: '2026-04-01T00:00:00.000Z' }));
    library.put(makeEntry({ id: 'new', updated: '2026-05-01T00:00:00.000Z' }));

    const r = (await wikiListTool.handler({ limit: 50 }, ctx)) as {
      ok: boolean;
      total_matched: number;
      returned: number;
      truncated: boolean;
      items: { id: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.total_matched).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('collection 过滤', async () => {
    library.put(makeEntry({ id: 'a', collection: 'tech' }));
    library.put(makeEntry({ id: 'b', collection: 'tech' }));
    library.put(makeEntry({ id: 'c', collection: 'reading' }));

    const r = (await wikiListTool.handler({ collection: 'tech', limit: 50 }, ctx)) as {
      items: { id: string }[];
      total_matched: number;
    };
    expect(r.total_matched).toBe(2);
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('tags 过滤（OR 语义）', async () => {
    library.put(makeEntry({ id: 'a', tags: ['retry', 'agent'] }));
    library.put(makeEntry({ id: 'b', tags: ['retry'] }));
    library.put(makeEntry({ id: 'c', tags: ['unrelated'] }));

    const r = (await wikiListTool.handler({ tags: ['retry'], limit: 50 }, ctx)) as {
      items: { id: string }[];
    };
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('contains 子串过滤（id/title/summary 任一）', async () => {
    library.put(makeEntry({ id: 'a', title: 'Agent retry pattern' }));
    library.put(makeEntry({ id: 'b', title: 'Caching', summary: 'about agents' }));
    library.put(makeEntry({ id: 'c', title: 'Unrelated' }));

    const r = (await wikiListTool.handler({ contains: 'agent', limit: 50 }, ctx)) as {
      items: { id: string }[];
    };
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('limit 截断 + truncated=true', async () => {
    for (let i = 0; i < 10; i++) {
      library.put(makeEntry({ id: `e${i}`, updated: `2026-04-${String(i + 1).padStart(2, '0')}` }));
    }
    const r = (await wikiListTool.handler({ limit: 3 }, ctx)) as {
      total_matched: number;
      returned: number;
      truncated: boolean;
      items: { id: string }[];
    };
    expect(r.total_matched).toBe(10);
    expect(r.returned).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('items 不带 content（避免炸 context）', async () => {
    library.put(makeEntry({ id: 'a', content: 'x'.repeat(10000) }));
    const r = (await wikiListTool.handler({ limit: 10 }, ctx)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(r.items[0]).not.toHaveProperty('content');
    expect(r.items[0]).toHaveProperty('summary');
    expect(r.items[0]).toHaveProperty('source');
  });

  it('items 带 source（含 file path 时模型可拿来 wiki_read_source）', async () => {
    library.put(
      makeEntry({
        id: 'a',
        source: { type: 'file', value: '/abs/path/note.md' },
      }),
    );
    const r = (await wikiListTool.handler({ limit: 10 }, ctx)) as {
      items: Array<{ source: { type: string; value?: string } }>;
    };
    expect(r.items[0].source).toEqual({ type: 'file', value: '/abs/path/note.md' });
  });
});

// ---- wiki_read_source ----

describe('wiki_read_source', () => {
  it('source.type=file + 文件存在 + 沙箱内 → 返回原文', async () => {
    const original = path.join(workspaceRoot, 'note.md');
    fs.writeFileSync(original, '# Original\n\nFull detailed content.\n');
    library.put(
      makeEntry({
        id: 'noted',
        source: { type: 'file', value: original },
        content: 'compressed digest',
      }),
    );

    const r = (await wikiReadSourceTool.handler(
      { id: 'noted' },
      ctx,
    )) as { ok: boolean; id: string; source_path: string; content: string };
    expect(r.ok).toBe(true);
    expect(r.id).toBe('noted');
    expect(r.source_path).toBe(original);
    expect(r.content).toContain('Full detailed content');
  });

  it('entry 不存在 → ok=false', async () => {
    const r = (await wikiReadSourceTool.handler({ id: 'ghost' }, ctx)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('source.type=inline → ok=false（无原文可读）', async () => {
    library.put(makeEntry({ id: 'inline-src', source: { type: 'inline' } }));
    const r = (await wikiReadSourceTool.handler({ id: 'inline-src' }, ctx)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('source.type=inline');
  });

  it('source.type=url → ok=false（v1 不自动 fetch）', async () => {
    library.put(
      makeEntry({
        id: 'url-src',
        source: { type: 'url', value: 'https://example.com/post' },
      }),
    );
    const r = (await wikiReadSourceTool.handler({ id: 'url-src' }, ctx)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('source.type=url');
  });

  it('source 路径在沙箱外 → ok=false 报清楚', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const file = path.join(outside, 'note.md');
    fs.writeFileSync(file, 'sensitive');
    try {
      library.put(makeEntry({ id: 'bad', source: { type: 'file', value: file } }));
      const r = (await wikiReadSourceTool.handler({ id: 'bad' }, ctx)) as {
        ok: boolean;
        error?: string;
      };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/sandbox|PITH_WIKI_READ_PATHS/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('source 文件已删除（条目陈旧）→ ok=false 提示重新 ingest', async () => {
    const f = path.join(workspaceRoot, 'gone.md');
    fs.writeFileSync(f, 'x');
    library.put(makeEntry({ id: 'stale', source: { type: 'file', value: f } }));
    fs.unlinkSync(f);

    const r = (await wikiReadSourceTool.handler({ id: 'stale' }, ctx)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer exists|re-ingest/);
  });

  it('source.cachePath 存在 → 读 sidecar 而不是原始（二进制）source.value', async () => {
    // 模拟一个 PDF entry：source.value 指向 .pdf（这里只是占位，内容随便），
    // source.cachePath 指向 wikiRoot 下 .cache 里转换后的 markdown。
    const pdf = path.join(workspaceRoot, 'paper.pdf');
    fs.writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF magic bytes
    const cacheDir = path.join(wikiRoot, 'tech', '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const sidecar = path.join(cacheDir, 'paper.md');
    fs.writeFileSync(sidecar, '# Paper\n\nClean markdown extracted from PDF.');
    library.put(
      makeEntry({
        id: 'paper',
        source: {
          type: 'file',
          value: pdf,
          convertedBy: 'pdf-parse',
          cachePath: sidecar,
        },
      }),
    );

    const r = (await wikiReadSourceTool.handler({ id: 'paper' }, ctx)) as {
      ok: boolean;
      content: string;
      source_path: string;
      cache_path: string;
      read_from: string;
      converted_by: string;
    };
    expect(r.ok).toBe(true);
    expect(r.read_from).toBe('cache');
    expect(r.cache_path).toBe(sidecar);
    expect(r.source_path).toBe(pdf); // 原始路径仍然返回，用于溯源
    expect(r.converted_by).toBe('pdf-parse');
    expect(r.content).toContain('Clean markdown extracted');
  });

  it('source.cachePath 丢失 → 提示 sidecar 需重新生成（不静默回退）', async () => {
    const pdf = path.join(workspaceRoot, 'paper2.pdf');
    fs.writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const sidecar = path.join(wikiRoot, 'tech', '.cache', 'paper2.md');
    // 故意不创建 sidecar 文件
    library.put(
      makeEntry({
        id: 'paper2',
        source: {
          type: 'file',
          value: pdf,
          convertedBy: 'pdf-parse',
          cachePath: sidecar,
        },
      }),
    );

    const r = (await wikiReadSourceTool.handler({ id: 'paper2' }, ctx)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sidecar missing|re-ingest/i);
  });
});

// ---- wiki_query 新返回字段 ----

describe('wiki_query — 新增 references / total_entries_in_library 字段', () => {
  it('每个 referenced 都带 title / collection / source', async () => {
    library.put(
      makeEntry({
        id: 'agent',
        title: 'Agent design',
        collection: 'tech',
        source: { type: 'file', value: '/abs/agent.md' },
      }),
    );
    const r = (await wikiQueryTool.handler({ query: 'agent', max_tokens: 1000 }, ctx)) as {
      ok: boolean;
      references: Array<{
        id: string;
        title: string;
        collection: string;
        source: { type: string; value?: string };
      }>;
      referenced_entries: string[];
      total_entries_in_library: number;
    };
    expect(r.ok).toBe(true);
    expect(r.referenced_entries).toEqual(['agent']);
    expect(r.references).toHaveLength(1);
    expect(r.references[0]).toEqual({
      id: 'agent',
      title: 'Agent design',
      collection: 'tech',
      source: { type: 'file', value: '/abs/agent.md' },
    });
    expect(r.total_entries_in_library).toBe(1);
  });

  it('total_entries_in_library 包括没命中的条目（让模型知道库是否非空）', async () => {
    library.put(makeEntry({ id: 'a', title: 'unrelated A' }));
    library.put(makeEntry({ id: 'b', title: 'unrelated B' }));
    const r = (await wikiQueryTool.handler({ query: 'quantum', max_tokens: 1000 }, ctx)) as {
      references: unknown[];
      referenced_entries: string[];
      total_entries_in_library: number;
    };
    expect(r.referenced_entries).toEqual([]);
    expect(r.references).toEqual([]);
    expect(r.total_entries_in_library).toBe(2);
  });
});
