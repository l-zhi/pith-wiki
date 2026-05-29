/**
 * `loadQueueDigest` 单元测试：覆盖 StatusBar 拿来做 dead 通知的快照逻辑。
 *
 * 关注：
 *   - state.json 缺失 → 安全返回零 counts、无 dead
 *   - 多个 dead 事件 → 选 events 数组里最末尾那个
 *   - latestDeadJob 只在 jobs 表里仍是 dead 时返回（jobs 被 clear-dead 删除时只剩 event.msg）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStateAtomic, type QueueState } from '../src/wiki/queue/state.js';
import { loadQueueDigest } from '../src/cli/dashboardData.js';

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-digest-'));
  statePath = path.join(tmpDir, 'state.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('loadQueueDigest', () => {
  it('文件缺失返回零 counts 且无 dead 字段', () => {
    const d = loadQueueDigest(path.join(tmpDir, 'missing.json'));
    expect(d.counts).toEqual({ pending: 0, running: 0, completed: 0, dead: 0 });
    expect(d.latestDeadEvent).toBeUndefined();
    expect(d.latestDeadJob).toBeUndefined();
  });

  it('聚合 counts 并返回 events 中最末尾的 dead 事件 + 对应 job', () => {
    const state: QueueState = {
      version: 1,
      jobs: {
        a: {
          id: 'a',
          file: '/abs/a.md',
          collection: 'tech',
          force: false,
          status: 'dead',
          attempts: 3,
          lastError: 'boom-a',
          enqueuedAt: '2026-05-01T00:00:00.000Z',
        },
        b: {
          id: 'b',
          file: '/abs/b.md',
          collection: 'life',
          force: false,
          status: 'dead',
          attempts: 3,
          lastError: 'boom-b',
          enqueuedAt: '2026-05-01T00:00:00.000Z',
        },
        c: {
          id: 'c',
          file: '/abs/c.md',
          collection: 'life',
          force: false,
          status: 'pending',
          attempts: 0,
          enqueuedAt: '2026-05-01T00:00:00.000Z',
        },
      },
      events: [
        { ts: '2026-05-01T00:00:01.000Z', jobId: 'a', kind: 'dead', msg: 'boom-a' },
        { ts: '2026-05-01T00:00:02.000Z', jobId: 'a', kind: 'reset' },
        { ts: '2026-05-01T00:00:03.000Z', jobId: 'b', kind: 'dead', msg: 'boom-b' },
      ],
    };
    writeStateAtomic(statePath, state);

    const d = loadQueueDigest(statePath);
    expect(d.counts).toEqual({ pending: 1, running: 0, completed: 0, dead: 2 });
    expect(d.latestDeadEvent?.jobId).toBe('b');
    expect(d.latestDeadJob?.id).toBe('b');
    expect(d.latestDeadJob?.lastError).toBe('boom-b');
    expect(d.latestDeadJob?.file).toBe('/abs/b.md');
    expect(d.latestDeadJob?.collection).toBe('life');
  });

  it('job 被清理掉后只剩 event.msg 这一条线索', () => {
    const state: QueueState = {
      version: 1,
      jobs: {}, // /queue clear-dead 之后
      events: [
        { ts: '2026-05-01T00:00:03.000Z', jobId: 'b', kind: 'dead', msg: 'gone-but-logged' },
      ],
    };
    writeStateAtomic(statePath, state);

    const d = loadQueueDigest(statePath);
    expect(d.counts.dead).toBe(0);
    expect(d.latestDeadEvent?.msg).toBe('gone-but-logged');
    expect(d.latestDeadJob).toBeUndefined();
  });

  it('坏 JSON 不抛，返回零 counts', () => {
    fs.writeFileSync(statePath, '{ not valid', 'utf8');
    const d = loadQueueDigest(statePath);
    expect(d.counts).toEqual({ pending: 0, running: 0, completed: 0, dead: 0 });
    expect(d.latestDeadEvent).toBeUndefined();
  });
});
