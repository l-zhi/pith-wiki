/**
 * ContextAssembler 的 scope 参数（@-mention 收窄检索）单测。
 *
 * 覆盖：
 *   - 集合 scope：只在指定集合内召回
 *   - entryIds 钉死：强制注入（即使打分 0 / 跨集合），且排最前
 *   - 空 query + entryIds：跳过早退，仍返回钉死条目
 *   - 集合 scope 下链接扩展不越界
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import { ContextAssembler } from '../src/wiki/assembler.js';
import type { Entry } from '../src/wiki/types.js';

let tmpDir: string;
let lib: LibraryService;
let assembler: ContextAssembler;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-asm-scope-'));
  lib = new LibraryService(tmpDir);
  assembler = new ContextAssembler(lib);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    subpath: o.subpath,
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? 'x',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

describe('ContextAssembler — 集合 scope', () => {
  it('只在指定集合内召回，集合外同名命中被排除', () => {
    lib.put(entry({ id: 'in-tech', collection: 'tech', title: 'agent design' }));
    lib.put(entry({ id: 'in-life', collection: 'life', title: 'agent design' }));

    const r = assembler.query('agent design', 4000, { collections: ['tech'] });
    expect(r.referencedEntries).toContain('in-tech');
    expect(r.referencedEntries).not.toContain('in-life');
  });

  it('多集合 = 并集', () => {
    lib.put(entry({ id: 'a', collection: 'tech', title: 'agent' }));
    lib.put(entry({ id: 'b', collection: 'life', title: 'agent' }));
    lib.put(entry({ id: 'c', collection: 'misc', title: 'agent' }));

    const r = assembler.query('agent', 4000, { collections: ['tech', 'life'] });
    expect(r.referencedEntries).toEqual(expect.arrayContaining(['a', 'b']));
    expect(r.referencedEntries).not.toContain('c');
  });

  it('链接扩展不越出 scope 集合', () => {
    lib.put(entry({ id: 'seed', collection: 'tech', title: 'agent', links: ['out', 'in'] }));
    lib.put(entry({ id: 'in', collection: 'tech', title: '同集合邻居' }));
    lib.put(entry({ id: 'out', collection: 'life', title: '跨集合邻居' }));

    const r = assembler.query('agent', 4000, { collections: ['tech'] });
    expect(r.referencedEntries).toContain('seed');
    expect(r.referencedEntries).toContain('in');
    expect(r.referencedEntries).not.toContain('out'); // 跨集合链接被挡
  });
});

describe('ContextAssembler — 子文件夹 scope（folders）', () => {
  it('只召回 subpath 前缀下的条目（含目录本身及子孙）', () => {
    lib.put(entry({ id: 'q1', collection: 'work', subpath: '2024/q1', title: 'agent' }));
    lib.put(entry({ id: 'q2', collection: 'work', subpath: '2024/q2', title: 'agent' }));
    lib.put(entry({ id: 'old', collection: 'work', subpath: '2023', title: 'agent' }));
    lib.put(entry({ id: 'root', collection: 'work', title: 'agent' })); // 集合根，无 subpath

    const r = assembler.query('agent', 4000, { folders: [{ collection: 'work', subpath: '2024' }] });
    expect(r.referencedEntries).toEqual(expect.arrayContaining(['q1', 'q2']));
    expect(r.referencedEntries).not.toContain('old');
    expect(r.referencedEntries).not.toContain('root');
  });

  it('前缀按目录段匹配，不误伤同前缀的兄弟目录', () => {
    lib.put(entry({ id: 'in', collection: 'work', subpath: '2024', title: 'agent' }));
    lib.put(entry({ id: 'sibling', collection: 'work', subpath: '20240', title: 'agent' }));

    const r = assembler.query('agent', 4000, { folders: [{ collection: 'work', subpath: '2024' }] });
    expect(r.referencedEntries).toContain('in');
    expect(r.referencedEntries).not.toContain('sibling'); // '20240' 不是 '2024' 的子目录
  });

  it('folders 与 collections 取并集', () => {
    lib.put(entry({ id: 'f', collection: 'work', subpath: '2024', title: 'agent' }));
    lib.put(entry({ id: 'c', collection: 'tech', title: 'agent' }));
    lib.put(entry({ id: 'out', collection: 'work', subpath: '2023', title: 'agent' }));

    const r = assembler.query('agent', 4000, {
      collections: ['tech'],
      folders: [{ collection: 'work', subpath: '2024' }],
    });
    expect(r.referencedEntries).toEqual(expect.arrayContaining(['f', 'c']));
    expect(r.referencedEntries).not.toContain('out');
  });

  it('链接扩展不越出子文件夹 scope', () => {
    lib.put(
      entry({ id: 'seed', collection: 'work', subpath: '2024', title: 'agent', links: ['near', 'far'] }),
    );
    lib.put(entry({ id: 'near', collection: 'work', subpath: '2024/detail', title: '同目录邻居' }));
    lib.put(entry({ id: 'far', collection: 'work', subpath: '2023', title: '目录外邻居' }));

    const r = assembler.query('agent', 4000, { folders: [{ collection: 'work', subpath: '2024' }] });
    expect(r.referencedEntries).toContain('seed');
    expect(r.referencedEntries).toContain('near');
    expect(r.referencedEntries).not.toContain('far');
  });
});

describe('ContextAssembler — entryIds 钉死', () => {
  it('强制注入指定条目，即使查询不命中它', () => {
    lib.put(entry({ id: 'pinned', collection: 'tech', title: '量子加密', content: '无关内容' }));
    lib.put(entry({ id: 'hit', collection: 'tech', title: 'agent design' }));

    const r = assembler.query('agent design', 4000, { entryIds: ['pinned'] });
    expect(r.referencedEntries).toContain('pinned');
    // 钉死条目排在最前
    expect(r.referencedEntries[0]).toBe('pinned');
  });

  it('跨集合钉死也保留（钉死优先于集合过滤）', () => {
    lib.put(entry({ id: 'pinned', collection: 'life', title: '日记' }));
    lib.put(entry({ id: 'scoped', collection: 'tech', title: 'agent' }));

    const r = assembler.query('agent', 4000, { collections: ['tech'], entryIds: ['pinned'] });
    expect(r.referencedEntries).toContain('pinned');
    expect(r.referencedEntries).toContain('scoped');
  });

  it('空 query + entryIds：跳过早退，仍渲染钉死条目', () => {
    lib.put(entry({ id: 'pinned', collection: 'tech', title: '钉死标题', content: '正文内容' }));

    const r = assembler.query('   ', 4000, { entryIds: ['pinned'] });
    expect(r.referencedEntries).toEqual(['pinned']);
    expect(r.context).toContain('钉死标题');
  });

  it('钉死不存在的 id 被静默跳过', () => {
    lib.put(entry({ id: 'real', collection: 'tech', title: 'agent' }));
    const r = assembler.query('agent', 4000, { entryIds: ['ghost'] });
    expect(r.referencedEntries).toContain('real');
    expect(r.referencedEntries).not.toContain('ghost');
  });
});

describe('ContextAssembler — 无 scope 时保持整库行为', () => {
  it('不传 scope 等价于旧行为', () => {
    lib.put(entry({ id: 'a', collection: 'tech', title: 'agent' }));
    lib.put(entry({ id: 'b', collection: 'life', title: 'agent' }));
    const r = assembler.query('agent');
    expect(r.referencedEntries).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
