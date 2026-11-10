/**
 * Dashboard collection counts must follow LibraryService's walk:
 * nested `<collection>/sub/*.md` entries count, and `config.outputDir`
 * (raw transcripts) does not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { collectDashboardData } from '../src/cli/dashboardData.js';
import { ConverterRegistry } from '../src/wiki/converters/registry.js';
import { LibraryService } from '../src/wiki/library.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-dash-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeEntry(file: string, id: string, collection: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '---',
      `id: ${id}`,
      `collection: ${collection}`,
      `title: ${id}`,
      'summary: s',
      'tags: []',
      'links: []',
      'source:',
      '  type: inline',
      'updated: 2026-01-01T00:00:00.000Z',
      '---',
      `# ${id}`,
    ].join('\n'),
  );
}

describe('collectDashboardData wiki counts', () => {
  it('counts nested entries and skips transcripts under outputDir', async () => {
    const wikiRoot = tmpDir;
    const outputDir = path.join(wikiRoot, 'output', 'transcripts');
    writeEntry(path.join(wikiRoot, 'tech', 'top.md'), 'top', 'tech');
    writeEntry(path.join(wikiRoot, 'tech', 'sub', 'x.md'), 'x', 'tech');
    writeEntry(path.join(wikiRoot, 'output', 'digest.md'), 'digest', 'output');
    writeEntry(path.join(wikiRoot, 'output', 'notes', 'y.md'), 'y', 'output');
    // Valid entry on purpose: ID_RE would not save us; ignoredDirs must.
    writeEntry(path.join(outputDir, 'leaked-transcript.md'), 'leaked-transcript', 'output');

    const indexed = new LibraryService(wikiRoot, { persist: false, ignoredDirs: [outputDir] })
      .list()
      .reduce<Record<string, number>>((acc, entry) => {
        acc[entry.collection] = (acc[entry.collection] ?? 0) + 1;
        return acc;
      }, {});

    const data = await collectDashboardData(
      {
        wikiRoot,
        outputDir,
        queueStatePath: path.join(tmpDir, 'no-queue.json'),
        watchDirs: [],
        model: 'test-model',
        apiKey: '',
        baseURL: 'http://example.test',
      } as Config,
      new ConverterRegistry(),
    );
    const done = Object.fromEntries(data.collections.map((row) => [row.name, row.done]));

    expect(indexed).toEqual({ tech: 2, output: 2 });
    expect(done).toEqual(indexed);
  });
});
