/**
 * wiki_list 的日期过滤：added_*（入库时间）与 date_*（内容自身日期）。
 * 这是「整理某天新增的内容」能确定性命中的关键。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import { wikiListTool } from '../src/tools/wiki_list.js';
import type { ToolContext } from '../src/tools/index.js';
import type { Entry } from '../src/wiki/types.js';

let tmpDir: string;
let lib: LibraryService;

const entry = (o: Partial<Entry>): Entry => ({
  id: o.id ?? 'x',
  collection: o.collection ?? 'tech',
  title: o.title ?? 'T',
  summary: '',
  tags: [],
  links: [],
  content: 'body',
  source: { type: 'inline' },
  updated: o.updated ?? '2026-06-17T00:00:00.000Z',
  ingestedAt: o.ingestedAt,
  date: o.date,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wikilist-'));
  lib = new LibraryService(tmpDir);
  // a: 入库 6/16；b: 入库 6/17；c: 入库 6/17 但内容日期 6/15（模拟「今天导入的旧内容」）
  lib.put(entry({ id: 'a', ingestedAt: '2026-06-16T08:00:00.000Z' }));
  lib.put(entry({ id: 'b', ingestedAt: '2026-06-17T09:00:00.000Z' }));
  lib.put(entry({ id: 'c', ingestedAt: '2026-06-17T09:30:00.000Z', date: '2026-06-15' }));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ctx = () => ({ library: lib }) as unknown as ToolContext;
const ids = (r: unknown) => (r as { items: { id: string }[] }).items.map((i) => i.id).sort();

describe('wiki_list date filters', () => {
  it('added_after/added_before：按入库日期命中（含两端）', async () => {
    const r = await wikiListTool.handler(
      { added_after: '2026-06-16', added_before: '2026-06-16', limit: 50 } as never,
      ctx(),
    );
    expect(ids(r)).toEqual(['a']);
  });

  it('added 范围跨两天', async () => {
    const r = await wikiListTool.handler(
      { added_after: '2026-06-16', added_before: '2026-06-17', limit: 50 } as never,
      ctx(),
    );
    expect(ids(r)).toEqual(['a', 'b', 'c']);
  });

  it('date_after/date_before：按内容自身日期命中（无 date 的条目不匹配）', async () => {
    const r = await wikiListTool.handler(
      { date_after: '2026-06-15', date_before: '2026-06-15', limit: 50 } as never,
      ctx(),
    );
    expect(ids(r)).toEqual(['c']); // 只有 c 有 date=6/15；a/b 无内容日期被排除
  });

  it('items 暴露 ingestedAt 与 date', async () => {
    const r = (await wikiListTool.handler({ contains: 'c', limit: 50 } as never, ctx())) as {
      items: { id: string; ingestedAt: string; date?: string }[];
    };
    const c = r.items.find((i) => i.id === 'c')!;
    expect(c.ingestedAt).toBe('2026-06-17T09:30:00.000Z');
    expect(c.date).toBe('2026-06-15');
  });
});
