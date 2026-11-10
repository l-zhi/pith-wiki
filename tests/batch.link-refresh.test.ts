/**
 * Batch ingest must refresh link candidates after each successful put,
 * the same way the queue runner does. A later file in one `ingest --dir`
 * batch can then auto-link to an entry created earlier in that run.
 *
 * concurrency 1 makes the second job start only after the first put.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { HydrationService, HydrateInput } from '../src/wiki/hydration.js';
import type { Entry } from '../src/wiki/types.js';
import { runBatch } from '../src/wiki/batch.js';

let tmpDir: string;
let library: LibraryService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-batch-links-'));
  library = new LibraryService(tmpDir);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeFile(name: string, content = `content of ${name}`): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function makeFakeHydrator(): { hydrator: HydrationService; calls: HydrateInput[] } {
  const calls: HydrateInput[] = [];
  let callIndex = 0;
  const hydrator = {
    hydrate: async (input: HydrateInput): Promise<Entry> => {
      const idx = callIndex++;
      calls.push(input);
      const id = path.basename(input.source.value ?? `entry-${idx}`, '.md');
      return {
        id,
        collection: input.collectionId,
        title: id,
        summary: '',
        tags: [],
        links: [],
        content: `# ${id}\n\nfake content`,
        source: input.source,
        updated: new Date().toISOString(),
      };
    },
  } as unknown as HydrationService;
  return { hydrator, calls };
}

describe('runBatch — linkCandidates refresh', () => {
  it('a later job sees an entry created by an earlier job in the same batch', async () => {
    const fileA = makeFile('first.md');
    const fileB = makeFile('second.md');
    const { hydrator, calls } = makeFakeHydrator();

    await runBatch({
      files: [fileA, fileB],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].source.value).toBe(fileA);
    expect(calls[1].source.value).toBe(fileB);

    const firstIds = (calls[0].linkCandidates ?? []).map((e) => e.id);
    expect(firstIds).not.toContain('first');

    const secondIds = (calls[1].linkCandidates ?? []).map((e) => e.id);
    expect(secondIds).toContain('first');
  });
});
