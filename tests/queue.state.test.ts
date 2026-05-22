/**
 * 持久化队列 state 模块单元测试。
 *
 * 关注：
 *   - deriveJobId 稳定且 (file, collection) 之外不串
 *   - readState / writeStateAtomic 的原子性与版本校验
 *   - pushEvent 的环形缓冲行为
 *   - QueueStore.acquireLock 的单写者语义和陈旧 lock 接管
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveJobId,
  emptyState,
  pushEvent,
  readState,
  writeStateAtomic,
  type QueueState,
} from '../src/wiki/queue/state.js';
import { QueueLockedError, QueueStore } from '../src/wiki/queue/store.js';

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-queue-state-'));
  statePath = path.join(tmpDir, 'state.json');
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('deriveJobId', () => {
  it('对相同 (file, collection) 返回相同 id', () => {
    const a = deriveJobId('/abs/path/foo.md', 'tech');
    const b = deriveJobId('/abs/path/foo.md', 'tech');
    expect(a).toBe(b);
  });

  it('不同 file 产生不同 id', () => {
    const a = deriveJobId('/abs/path/foo.md', 'tech');
    const b = deriveJobId('/abs/path/bar.md', 'tech');
    expect(a).not.toBe(b);
  });

  it('不同 collection 产生不同 id（避免跨 collection 撞 jobId）', () => {
    const a = deriveJobId('/abs/path/foo.md', 'tech');
    const b = deriveJobId('/abs/path/foo.md', 'reading');
    expect(a).not.toBe(b);
  });

  it('id 格式是 12 位 hex', () => {
    const id = deriveJobId('/abs/x.md', 'c');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('readState / writeStateAtomic', () => {
  it('文件不存在时返回 emptyState', () => {
    expect(readState(statePath)).toEqual({ version: 1, jobs: {}, events: [] });
  });

  it('round-trip: write 后 read 还原原始数据', () => {
    const state: QueueState = {
      version: 1,
      jobs: {
        abc123: {
          id: 'abc123',
          file: '/abs/x.md',
          collection: 'tech',
          force: false,
          status: 'pending',
          attempts: 0,
          enqueuedAt: '2026-04-29T00:00:00.000Z',
        },
      },
      events: [
        { ts: '2026-04-29T00:00:00.000Z', jobId: 'abc123', kind: 'enqueued' },
      ],
    };
    writeStateAtomic(statePath, state);
    expect(readState(statePath)).toEqual(state);
  });

  it('不写直接残留 .tmp 也不影响读取（.tmp 是中间产物）', () => {
    fs.writeFileSync(`${statePath}.tmp`, '{ malformed', 'utf8');
    // 目标文件没有 → 仍返回 emptyState
    expect(readState(statePath)).toEqual({ version: 1, jobs: {}, events: [] });
  });

  it('版本不匹配时抛错', () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 999, jobs: {}, events: [] }));
    expect(() => readState(statePath)).toThrow();
  });

  it('JSON 损坏时抛错', () => {
    fs.writeFileSync(statePath, '{ not valid');
    expect(() => readState(statePath)).toThrow(/not valid JSON/i);
  });
});

describe('pushEvent — 环形缓冲', () => {
  it('容量内全部保留', () => {
    const s = emptyState();
    for (let i = 0; i < 50; i++) {
      pushEvent(s, { ts: `t${i}`, jobId: 'x', kind: 'enqueued' });
    }
    expect(s.events).toHaveLength(50);
  });

  it('超过 cap 时丢弃最早的，保留最新 200 条', () => {
    const s = emptyState();
    for (let i = 0; i < 250; i++) {
      pushEvent(s, { ts: `t${i}`, jobId: 'x', kind: 'enqueued' });
    }
    expect(s.events).toHaveLength(200);
    // 最新 200 条对应 i ∈ [50, 249]
    expect(s.events[0].ts).toBe('t50');
    expect(s.events[s.events.length - 1].ts).toBe('t249');
  });
});

describe('QueueStore.mutate', () => {
  it('支持 mutate 入参', () => {
    const store = new QueueStore(statePath);
    store.mutate((s) => {
      s.jobs['x'] = {
        id: 'x',
        file: '/a.md',
        collection: 'c',
        force: false,
        status: 'pending',
        attempts: 0,
        enqueuedAt: 't',
      };
    });
    expect(store.load().jobs['x']).toBeDefined();
  });

  it('支持 mutate 返回 next state', () => {
    const store = new QueueStore(statePath);
    store.mutate(() => {
      const next = emptyState();
      next.jobs['y'] = {
        id: 'y',
        file: '/b.md',
        collection: 'c',
        force: false,
        status: 'pending',
        attempts: 0,
        enqueuedAt: 't',
      };
      return next;
    });
    expect(store.load().jobs['y']).toBeDefined();
  });
});

describe('QueueStore.acquireLock', () => {
  it('成功取锁后写入 pid 文件', () => {
    const store = new QueueStore(statePath);
    const release = store.acquireLock();
    try {
      const raw = fs.readFileSync(`${statePath}.lock`, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.ts).toBe('string');
    } finally {
      release();
    }
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('已有 lock 且 owner 进程仍在时抛 QueueLockedError', () => {
    const store = new QueueStore(statePath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // 写一份"还活着的"lock：用当前进程 pid 不行（会被认作 self-stale），
    // 用 init 的 pid（1，POSIX 上常驻）来模拟另一个活进程。
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: 1, ts: new Date().toISOString() }),
    );
    expect(() => store.acquireLock()).toThrow(QueueLockedError);
  });

  it('陈旧 lock（pid 不存在）会被自动接管', () => {
    const store = new QueueStore(statePath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // pid=2^31-1 几乎肯定不存在
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: 2147483647, ts: new Date().toISOString() }),
    );
    const release = store.acquireLock();
    try {
      const raw = fs.readFileSync(`${statePath}.lock`, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.pid).toBe(process.pid);
    } finally {
      release();
    }
  });
});
