import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectionFolders } from '../src/engine/collectionFolders.js';

const dirs: string[] = [];
const makeDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-folder-menu-'));
  dirs.push(root);
  return {
    root,
    wikiRoot: makeDir(path.join(root, 'wiki')),
    source: makeDir(path.join(root, 'notes')),
  };
}
const watch = (dir: string) => ({
  path: dir,
  collectionFromSubdir: true,
  subdirAlias: {},
  initialScan: false,
  ignore: [],
});
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('collection folders for Finder', () => {
  it('reveals watched source directories, including renamed collections, instead of digests', () => {
    const { wikiRoot, source } = fixture();
    const folder = makeDir(path.join(source, '原始记录'));
    makeDir(path.join(wikiRoot, '记录片'));
    expect(
      collectionFolders(
        {
          wikiRoot,
          digestCollection: 'output',
          watchDirs: [{ ...watch(source), subdirAlias: { 原始记录: '记录片' } }],
        },
        '记录片',
      ),
    ).toEqual([folder]);
  });

  it('offers each distinct source when several watch roots feed one collection', () => {
    const { root, wikiRoot, source } = fixture();
    const other = makeDir(path.join(root, 'more-notes'));
    const config = {
      wikiRoot,
      digestCollection: 'output',
      watchDirs: [source, other, source].map((dir) => ({ ...watch(dir), collection: 'work' })),
    };
    expect(collectionFolders(config, 'work')).toEqual([source, other]);
  });

  it('uses the wiki directory for output, manual collections and missing watch folders', () => {
    const { wikiRoot, source } = fixture();
    const output = makeDir(path.join(wikiRoot, 'output'));
    const manual = makeDir(path.join(wikiRoot, 'manual'));
    makeDir(path.join(source, 'output'));
    const config = {
      wikiRoot,
      digestCollection: 'output',
      watchDirs: [watch(source), { ...watch('/missing-pith-folder'), collection: 'manual' }],
    };
    expect(collectionFolders(config, 'output')).toEqual([output]);
    expect(collectionFolders(config, 'manual')).toEqual([manual]);
    expect(collectionFolders(config, 'missing')).toEqual([]);
  });

  it('reveals the watch root for fallback entries without allowing path traversal', () => {
    const { wikiRoot, source, root } = fixture();
    const config = {
      wikiRoot,
      digestCollection: 'output',
      watchDirs: [{ ...watch(source), fallbackCollection: 'inbox' }],
    };
    expect(collectionFolders(config, 'inbox')).toEqual([source]);
    expect(collectionFolders(config, '../notes')).toEqual([]);
    expect(collectionFolders(config, root)).toEqual([]);
  });
});
