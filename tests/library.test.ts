import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { Entry } from '../src/wiki/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-lib-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? 'foo',
    collection: overrides.collection ?? 'tech',
    title: overrides.title ?? 'Foo',
    summary: overrides.summary ?? 'a foo entry',
    tags: overrides.tags ?? ['x'],
    links: overrides.links ?? [],
    content: overrides.content ?? '# Foo\n- bar',
    source: overrides.source ?? { type: 'inline' },
    updated: overrides.updated ?? new Date().toISOString(),
  };
}

describe('LibraryService', () => {
  it('round-trips an entry through put/get', () => {
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({ id: 'agent-design', tags: ['agent', 'arch'] });
    lib.put(entry);
    const fetched = lib.get('agent-design');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('agent-design');
    expect(fetched!.tags).toEqual(['agent', 'arch']);
  });

  it('builds backlinks lazily and invalidates on write', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', links: ['b', 'c'] }));
    lib.put(makeEntry({ id: 'b' }));
    lib.put(makeEntry({ id: 'c' }));

    const idx = lib.linkIndex();
    expect(idx.get('b')!.backward).toContain('a');
    expect(idx.get('c')!.backward).toContain('a');

    lib.put(makeEntry({ id: 'a', links: ['c'] }));
    const idx2 = lib.linkIndex();
    expect(idx2.get('b')!.backward).not.toContain('a');
    expect(idx2.get('c')!.backward).toContain('a');
  });

  it('lists entries by collection', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', collection: 'tech' }));
    lib.put(makeEntry({ id: 'b', collection: 'cooking' }));
    expect(lib.list('tech').map((e) => e.id)).toEqual(['a']);
    expect(lib.list('cooking').map((e) => e.id)).toEqual(['b']);
    expect(lib.list().length).toBe(2);
  });

  it('delete removes file and invalidates index', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a' }));
    expect(lib.get('a')).not.toBeNull();
    expect(lib.delete('a', 'tech')).toBe(true);
    expect(lib.get('a')).toBeNull();
    expect(lib.delete('a', 'tech')).toBe(false);
  });
});
