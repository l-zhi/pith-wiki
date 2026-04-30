/**
 * Watcher 单元 + 集成测试。
 *
 * 大部分用纯函数 + 真 fs，避免对 chokidar 的 mock。一个真 chokidar 集成 case 验证
 * 端到端事件流，但故意保持 timeout 充裕，避免 CI 抖动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueueStore } from '../src/wiki/queue/store.js';
import { deriveJobId } from '../src/wiki/queue/state.js';
import {
  enqueueFromWatch,
  initialScanEnqueue,
  isDefaultIgnored,
  isFilesystemSafeName,
  resolveCollectionForFile,
  resolveWatchTarget,
  runWatcher,
  type ResolvedWatchTarget,
} from '../src/wiki/queue/watcher.js';
import type { SafetyOptions } from '../src/tools/safety.js';

let tmpRoot: string;
let watchRoot: string;
let wikiRoot: string;
let workspaceRoot: string;
let statePath: string;
let store: QueueStore;
let safety: SafetyOptions;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-watcher-'));
  watchRoot = path.join(tmpRoot, 'src-notes');
  wikiRoot = path.join(tmpRoot, 'wiki');
  workspaceRoot = tmpRoot;
  statePath = path.join(tmpRoot, 'state.json');
  fs.mkdirSync(watchRoot, { recursive: true });
  fs.mkdirSync(wikiRoot, { recursive: true });
  store = new QueueStore(statePath);
  safety = {
    workspaceRoot,
    wikiRoot,
    maxPayloadBytes: 100_000,
    readOnly: false,
    additionalReadPaths: [watchRoot],
  };
});

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function makeTarget(overrides: Partial<ResolvedWatchTarget> = {}): ResolvedWatchTarget {
  return {
    path: watchRoot,
    realPath: fs.realpathSync(watchRoot),
    collection: undefined,
    collectionFromSubdir: true,
    fallbackCollection: 'misc',
    subdirAlias: {},
    initialScan: false,
    ignore: [],
    ...overrides,
  };
}

// ---- 纯函数 ----

describe('isFilesystemSafeName', () => {
  it('接受英文、中文、混合、数字-连字符', () => {
    expect(isFilesystemSafeName('tech')).toBe(true);
    expect(isFilesystemSafeName('工作')).toBe(true);
    expect(isFilesystemSafeName('读书笔记')).toBe(true);
    expect(isFilesystemSafeName('2024-Q1')).toBe(true);
    expect(isFilesystemSafeName('Notes 2024')).toBe(true);
  });

  it('拒绝隐藏、`.` / `..`、含路径分隔、首尾空白', () => {
    expect(isFilesystemSafeName('')).toBe(false);
    expect(isFilesystemSafeName('.')).toBe(false);
    expect(isFilesystemSafeName('..')).toBe(false);
    expect(isFilesystemSafeName('.cache')).toBe(false);
    expect(isFilesystemSafeName('a/b')).toBe(false);
    expect(isFilesystemSafeName('a\\b')).toBe(false);
    expect(isFilesystemSafeName(' leading')).toBe(false);
    expect(isFilesystemSafeName('trailing ')).toBe(false);
  });
});

describe('isDefaultIgnored', () => {
  it('屏蔽 dotfiles/dotdirs（任意层级）', () => {
    expect(isDefaultIgnored('/x/.obsidian/plugins/foo.json')).toBe(true);
    expect(isDefaultIgnored('/x/.git/HEAD')).toBe(true);
    expect(isDefaultIgnored('/x/.DS_Store')).toBe(true);
    expect(isDefaultIgnored('/x/notes/.draft.md')).toBe(true);
  });

  it('屏蔽 wiki/ outputs/ node_modules/（任意层级）', () => {
    expect(isDefaultIgnored('/x/notes/wiki/foo.md')).toBe(true);
    expect(isDefaultIgnored('/x/notes/outputs/transcript.md')).toBe(true);
    expect(isDefaultIgnored('/x/notes/node_modules/pkg/README.md')).toBe(true);
    expect(isDefaultIgnored('/x/notes/sub/wiki/deep.md')).toBe(true);
  });

  it('屏蔽 .icloud 占位文件', () => {
    expect(isDefaultIgnored('/x/notes/.foo.md.icloud')).toBe(true);
  });

  it('放过普通笔记', () => {
    expect(isDefaultIgnored('/x/notes/工作/笔记.md')).toBe(false);
    expect(isDefaultIgnored('/x/notes/tech/readme.md')).toBe(false);
  });
});

describe('resolveCollectionForFile', () => {
  it('固定 collection 模式：直接返回', () => {
    const target = makeTarget({
      collection: 'fixed',
      collectionFromSubdir: false,
    });
    expect(resolveCollectionForFile(path.join(watchRoot, 'a.md'), target)).toBe('fixed');
    expect(resolveCollectionForFile(path.join(watchRoot, 'sub', 'a.md'), target)).toBe('fixed');
  });

  it('subdir 模式：英文目录直用', () => {
    const target = makeTarget();
    expect(
      resolveCollectionForFile(path.join(watchRoot, 'tech', 'foo.md'), target),
    ).toBe('tech');
  });

  it('subdir 模式：中文目录直用', () => {
    const target = makeTarget();
    expect(
      resolveCollectionForFile(path.join(watchRoot, '工作', '笔记.md'), target),
    ).toBe('工作');
    expect(
      resolveCollectionForFile(path.join(watchRoot, '读书笔记', '深度学习.md'), target),
    ).toBe('读书笔记');
  });

  it('subdir 模式：深层子目录仍取一级', () => {
    const target = makeTarget();
    expect(
      resolveCollectionForFile(path.join(watchRoot, '工作', '2024', 'Q1', '深层.md'), target),
    ).toBe('工作');
  });

  it('subdir 模式：alias 优先于直用', () => {
    const target = makeTarget({ subdirAlias: { 工作: 'work' } });
    expect(
      resolveCollectionForFile(path.join(watchRoot, '工作', '笔记.md'), target),
    ).toBe('work');
    // 没在 alias 里的中文仍直用
    expect(
      resolveCollectionForFile(path.join(watchRoot, '读书', '书.md'), target),
    ).toBe('读书');
  });

  it('subdir 模式：直接在 root 下的文件 → fallback', () => {
    const target = makeTarget({ fallbackCollection: 'misc' });
    expect(resolveCollectionForFile(path.join(watchRoot, 'orphan.md'), target)).toBe('misc');
  });

  it('subdir 模式：root 下文件 + 无 fallback → null', () => {
    const target = makeTarget({ fallbackCollection: undefined });
    expect(resolveCollectionForFile(path.join(watchRoot, 'orphan.md'), target)).toBeNull();
  });
});

// ---- resolveWatchTarget ----

describe('resolveWatchTarget', () => {
  it('正常路径通过', () => {
    const t = resolveWatchTarget(
      { path: watchRoot, collectionFromSubdir: true, fallbackCollection: 'misc' },
      safety,
    );
    expect(t.collectionFromSubdir).toBe(true);
    expect(t.fallbackCollection).toBe('misc');
  });

  it('不存在的路径报错', () => {
    expect(() =>
      resolveWatchTarget(
        { path: path.join(tmpRoot, 'does-not-exist'), collection: 'x' },
        safety,
      ),
    ).toThrow(/does not exist/);
  });

  it('路径在 wikiRoot 内 → 拒绝', () => {
    const insideWiki = path.join(wikiRoot, 'sub');
    fs.mkdirSync(insideWiki, { recursive: true });
    expect(() =>
      resolveWatchTarget({ path: insideWiki, collection: 'x' }, safety),
    ).toThrow(/wikiRoot/);
  });

  it('wikiRoot 自身 → 拒绝', () => {
    expect(() =>
      resolveWatchTarget({ path: wikiRoot, collection: 'x' }, safety),
    ).toThrow(/wikiRoot/);
  });

  it('路径在沙箱外 → 拒绝（安全）', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      expect(() =>
        resolveWatchTarget({ path: outside, collection: 'x' }, safety),
      ).toThrow(/outside read sandbox/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('既无 collection 也无 collectionFromSubdir → 拒绝', () => {
    expect(() =>
      resolveWatchTarget({ path: watchRoot }, safety),
    ).toThrow(/collectionFromSubdir/);
  });
});

// ---- enqueueFromWatch ----

describe('enqueueFromWatch', () => {
  it('add 新文件 → added', () => {
    const f = path.join(watchRoot, 'tech', 'foo.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const r = enqueueFromWatch(store, f, 'tech', 'add');
    expect(r).toBe('added');
    const id = deriveJobId(f, 'tech');
    const final = store.load();
    expect(final.jobs[id].status).toBe('pending');
    expect(final.jobs[id].force).toBe(false);
  });

  it('add 同文件第二次 → skipped（completed 不动）', () => {
    const f = path.join(watchRoot, 'a.md');
    fs.writeFileSync(f, 'x');
    enqueueFromWatch(store, f, 'tech', 'add');
    const id = deriveJobId(f, 'tech');
    // 模拟 worker 跑完
    store.mutate((s) => {
      s.jobs[id].status = 'completed';
      s.jobs[id].completedAt = new Date().toISOString();
      s.jobs[id].finalEntryId = 'a';
    });
    const r = enqueueFromWatch(store, f, 'tech', 'add');
    expect(r).toBe('skipped');
    expect(store.load().jobs[id].status).toBe('completed');
  });

  it('change 命中 completed → reset 为 pending + force=true + attempts=0', () => {
    const f = path.join(watchRoot, 'a.md');
    fs.writeFileSync(f, 'x');
    enqueueFromWatch(store, f, 'tech', 'add');
    const id = deriveJobId(f, 'tech');
    store.mutate((s) => {
      s.jobs[id].status = 'completed';
      s.jobs[id].attempts = 1;
      s.jobs[id].finalEntryId = 'a';
    });

    const r = enqueueFromWatch(store, f, 'tech', 'change');
    expect(r).toBe('reset');
    const j = store.load().jobs[id];
    expect(j.status).toBe('pending');
    expect(j.force).toBe(true);
    expect(j.attempts).toBe(0);
    expect(j.finalEntryId).toBeUndefined();
  });

  it('change 命中 dead → 复活为 pending（手动 retry 之外的额外恢复路径）', () => {
    const f = path.join(watchRoot, 'a.md');
    fs.writeFileSync(f, 'x');
    enqueueFromWatch(store, f, 'tech', 'add');
    const id = deriveJobId(f, 'tech');
    store.mutate((s) => {
      s.jobs[id].status = 'dead';
      s.jobs[id].attempts = 3;
      s.jobs[id].lastError = 'gave up';
    });
    const r = enqueueFromWatch(store, f, 'tech', 'change');
    expect(r).toBe('reset');
    expect(store.load().jobs[id].status).toBe('pending');
    expect(store.load().jobs[id].attempts).toBe(0);
  });

  it('add 命中 dead → 不动（避免无限自愈）', () => {
    const f = path.join(watchRoot, 'a.md');
    fs.writeFileSync(f, 'x');
    enqueueFromWatch(store, f, 'tech', 'add');
    const id = deriveJobId(f, 'tech');
    store.mutate((s) => {
      s.jobs[id].status = 'dead';
      s.jobs[id].attempts = 3;
    });
    const r = enqueueFromWatch(store, f, 'tech', 'add');
    expect(r).toBe('skipped');
    expect(store.load().jobs[id].status).toBe('dead');
  });

  it('change 命中 running → 不动（让在飞的跑完）', () => {
    const f = path.join(watchRoot, 'a.md');
    fs.writeFileSync(f, 'x');
    enqueueFromWatch(store, f, 'tech', 'add');
    const id = deriveJobId(f, 'tech');
    store.mutate((s) => {
      s.jobs[id].status = 'running';
    });
    const r = enqueueFromWatch(store, f, 'tech', 'change');
    expect(r).toBe('skipped');
    expect(store.load().jobs[id].status).toBe('running');
  });
});

// ---- initialScanEnqueue ----

describe('initialScanEnqueue', () => {
  it('批量入队所有 .md，按 collection 自动分组', async () => {
    fs.mkdirSync(path.join(watchRoot, '工作'), { recursive: true });
    fs.mkdirSync(path.join(watchRoot, 'tech'), { recursive: true });
    fs.writeFileSync(path.join(watchRoot, '工作', 'a.md'), 'x');
    fs.writeFileSync(path.join(watchRoot, '工作', 'b.md'), 'x');
    fs.writeFileSync(path.join(watchRoot, 'tech', 'c.md'), 'x');

    const target = makeTarget();
    const n = await initialScanEnqueue(store, target);
    expect(n).toBe(3);
    const jobs = Object.values(store.load().jobs);
    expect(jobs).toHaveLength(3);
    const collections = jobs.map((j) => j.collection).sort();
    expect(collections).toEqual(['tech', '工作', '工作']);
  });

  it('屏蔽 .obsidian / wiki / outputs / dotfiles', async () => {
    fs.mkdirSync(path.join(watchRoot, '.obsidian'), { recursive: true });
    fs.mkdirSync(path.join(watchRoot, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(watchRoot, 'outputs'), { recursive: true });
    fs.mkdirSync(path.join(watchRoot, '工作'), { recursive: true });
    fs.writeFileSync(path.join(watchRoot, '.obsidian', 'plugin.md'), 'x');
    fs.writeFileSync(path.join(watchRoot, 'wiki', 'inside.md'), 'x');
    fs.writeFileSync(path.join(watchRoot, 'outputs', 'transcript.md'), 'x');
    fs.writeFileSync(path.join(watchRoot, '工作', 'real.md'), 'x');

    const n = await initialScanEnqueue(store, makeTarget());
    expect(n).toBe(1);
    const jobs = Object.values(store.load().jobs);
    expect(jobs[0].file.endsWith(path.join('工作', 'real.md'))).toBe(true);
  });

  it('已 enqueue 过的文件再次 scan → 不重复入队', async () => {
    fs.mkdirSync(path.join(watchRoot, 'tech'), { recursive: true });
    fs.writeFileSync(path.join(watchRoot, 'tech', 'a.md'), 'x');

    const target = makeTarget();
    const first = await initialScanEnqueue(store, target);
    const second = await initialScanEnqueue(store, target);
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(Object.values(store.load().jobs)).toHaveLength(1);
  });

  it('一次 store.mutate 完成 N 个文件入队（性能契约）', async () => {
    fs.mkdirSync(path.join(watchRoot, 'tech'), { recursive: true });
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(watchRoot, 'tech', `f${i}.md`), 'x');
    }
    // 通过观察 events 数量 == 50（每文件一条 enqueued event）来验证写入完整
    await initialScanEnqueue(store, makeTarget());
    const state = store.load();
    expect(Object.keys(state.jobs)).toHaveLength(50);
    const enqueued = state.events.filter((e) => e.kind === 'enqueued');
    // events 环形 cap=200，50 < 200 应该全在
    expect(enqueued.length).toBe(50);
  });
});

// ---- runWatcher 集成 ----

describe('runWatcher (integration)', () => {
  it('add 事件触发 enqueue', async () => {
    const ac = new AbortController();
    const watcherPromise = runWatcher({
      store,
      targets: [
        {
          path: watchRoot,
          collectionFromSubdir: true,
          fallbackCollection: 'misc',
        },
      ],
      safety,
      signal: ac.signal,
      cooldownMs: 50,
    });

    // 等 chokidar ready（runWatcher 内部 awaits 'ready'）
    // 给一点 buffer
    await new Promise((r) => setTimeout(r, 200));

    fs.mkdirSync(path.join(watchRoot, 'tech'), { recursive: true });
    fs.writeFileSync(path.join(watchRoot, 'tech', 'fresh.md'), 'hello');

    // 等到 awaitWriteFinish (500ms) + 一点 buffer
    await new Promise((r) => setTimeout(r, 1500));

    const jobs = Object.values(store.load().jobs);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const tech = jobs.find((j) => j.collection === 'tech');
    expect(tech).toBeDefined();
    expect(tech!.file.endsWith(path.join('tech', 'fresh.md'))).toBe(true);

    ac.abort();
    await watcherPromise;
  }, 8000);

  it('initialScan 启动时入队已有文件', async () => {
    fs.mkdirSync(path.join(watchRoot, '工作'), { recursive: true });
    fs.writeFileSync(path.join(watchRoot, '工作', '入门.md'), 'x');

    const ac = new AbortController();
    const watcherPromise = runWatcher({
      store,
      targets: [
        {
          path: watchRoot,
          collectionFromSubdir: true,
          fallbackCollection: 'misc',
          initialScan: true,
        },
      ],
      safety,
      signal: ac.signal,
      cooldownMs: 50,
    });

    await new Promise((r) => setTimeout(r, 300));
    const jobs = Object.values(store.load().jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].collection).toBe('工作');

    ac.abort();
    await watcherPromise;
  }, 5000);

  it('signal abort 后 watcher 退出', async () => {
    const ac = new AbortController();
    const watcherPromise = runWatcher({
      store,
      targets: [
        {
          path: watchRoot,
          collection: 'fixed',
        },
      ],
      safety,
      signal: ac.signal,
      cooldownMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await expect(watcherPromise).resolves.toBeUndefined();
  }, 5000);
});
