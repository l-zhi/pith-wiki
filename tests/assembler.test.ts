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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-asm-'));
  lib = new LibraryService(tmpDir);
  assembler = new ContextAssembler(lib);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: 'tech',
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? 'x',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

describe('ContextAssembler', () => {
  it('returns empty result for empty query', () => {
    const r = assembler.query('   ');
    expect(r.referencedEntries).toEqual([]);
  });

  it('scores title hits higher than content hits', () => {
    lib.put(entry({ id: 'agent', title: 'Agent retry policy', content: 'unrelated body' }));
    lib.put(entry({ id: 'other', title: 'Database', content: 'mentions agent retry once' }));
    const r = assembler.query('agent retry');
    expect(r.referencedEntries[0]).toBe('agent');
  });

  it('expands one hop along forward links from a seed', () => {
    lib.put(entry({ id: 'seed', title: 'Agent design', links: ['child'] }));
    lib.put(entry({ id: 'child', title: 'Tool use', summary: 'how agents call tools' }));
    lib.put(entry({ id: 'unrelated', title: 'Quicksort' }));
    const r = assembler.query('agent design');
    expect(r.referencedEntries).toContain('seed');
    expect(r.referencedEntries).toContain('child');
    expect(r.referencedEntries).not.toContain('unrelated');
  });

  it('respects token budget by truncating after first entry', () => {
    const big = 'x'.repeat(100_000);
    lib.put(entry({ id: 'a', title: 'budget agent', content: big }));
    lib.put(entry({ id: 'b', title: 'budget agent two', content: big }));
    const r = assembler.query('budget', 1000);
    expect(r.referencedEntries.length).toBe(1);
  });
});
