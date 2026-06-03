/**
 * `loadQueueDigest` 单元测试：覆盖 StatusBar 轮询用的计数快照。
 *
 * 关注：
 *   - state.json 缺失 → 安全返回零 counts
 *   - 正常 state → 按 status 聚合 counts（dead 详情不再进 digest——
 *     "新 dead 浮到对话流"的通知机制已移除，详情按需走 /queue dead 查询）
 *   - 坏 JSON 不抛
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
  it('文件缺失返回零 counts', () => {
    const d = loadQueueDigest(path.join(tmpDir, 'missing.json'));
    expect(d.counts).toEqual({ pending: 0, running: 0, completed: 0, dead: 0 });
  });

  it('按 status 聚合 counts（含多个 dead）', () => {
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
  });

  it('坏 JSON 不抛，返回零 counts', () => {
    fs.writeFileSync(statePath, '{ not valid', 'utf8');
    const d = loadQueueDigest(statePath);
    expect(d.counts).toEqual({ pending: 0, running: 0, completed: 0, dead: 0 });
  });
});
