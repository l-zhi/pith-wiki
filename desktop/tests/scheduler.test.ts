import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleService } from '../../src/schedule/service.js';
import { ScheduleStore } from '../../src/schedule/store.js';
import { Scheduler } from '../src/engine/scheduler.js';
import type { SessionManager } from '../src/engine/sessionManager.js';

/**
 * Scheduler 编排测试：tick → run/skip 记录、lastFiredAt 推进、同任务重叠跳过。
 * catch-up 分类本身在 src/schedule 的单测里覆盖；这里只验证 engine 侧的胶水。
 */
describe('Scheduler', () => {
  let dir: string;
  let svc: ScheduleService;

  const fakeSessions = (runScheduled: SessionManager['runScheduled']): SessionManager =>
    ({ runScheduled }) as unknown as SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-eng-'));
    svc = new ScheduleService(new ScheduleStore(path.join(dir, 'state.json')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs a due once task, records ok, advances lastFiredAt (no re-run)', async () => {
    const task = svc.create({
      input: 'x',
      schedule: { kind: 'once', at: '2026-06-20T09:00:00.000Z' },
    });
    const runScheduled = vi.fn(async () => ({
      sessionId: 'sess1',
      status: 'ok' as const,
      preview: 'done',
    }));
    const sched = new Scheduler(
      svc,
      fakeSessions(runScheduled),
      () => {},
      () => {},
    );

    sched.tick(new Date('2026-06-20T09:01:00Z'));
    await sched.drain();

    expect(runScheduled).toHaveBeenCalledTimes(1);
    const after = svc.get(task.id)!;
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ status: 'ok', sessionId: 'sess1', preview: 'done' });
    expect(after.lastFiredAt).toBeDefined();

    // 再 tick：同一 occurrence 已 fired → 不重跑
    sched.tick(new Date('2026-06-20T09:02:00Z'));
    await sched.drain();
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });

  it('records failed when the turn errors', async () => {
    const task = svc.create({
      input: 'x',
      schedule: { kind: 'once', at: '2026-06-20T09:00:00.000Z' },
    });
    const runScheduled = vi.fn(async () => ({
      sessionId: 's',
      status: 'failed' as const,
      error: 'boom',
    }));
    const sched = new Scheduler(
      svc,
      fakeSessions(runScheduled),
      () => {},
      () => {},
    );

    sched.tick(new Date('2026-06-20T09:01:00Z'));
    await sched.drain();

    expect(svc.get(task.id)!.runs[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('skips (records skipped) when catchUp=false and a fire was missed during downtime', async () => {
    const task = svc.create({
      input: 'x',
      schedule: { kind: 'once', at: '2026-06-20T09:00:00.000Z' },
      catchUp: false,
    });
    const runScheduled = vi.fn(async () => ({ sessionId: 's', status: 'ok' as const }));
    const sched = new Scheduler(
      svc,
      fakeSessions(runScheduled),
      () => {},
      () => {},
    );

    // 先标一拍很早的 tick，再隔很久 tick（停机窗口）
    svc.markTick(new Date('2026-06-19T00:00:00Z'));
    sched.tick(new Date('2026-06-21T00:00:00Z'));
    await sched.drain();

    expect(runScheduled).not.toHaveBeenCalled();
    expect(svc.get(task.id)!.runs[0]).toMatchObject({ status: 'skipped' });
  });

  it('does not double-run the same task while a run is in flight', async () => {
    svc.create(
      { input: 'x', schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' } },
      new Date('2026-06-20T09:00:00Z'), // 显式 createdAt，早于下面的 tick，避免依赖真实墙钟
    );
    let resolveRun!: () => void;
    const gate = new Promise<void>((r) => (resolveRun = r));
    const runScheduled = vi.fn(async () => {
      await gate;
      return { sessionId: 's', status: 'ok' as const };
    });
    const sched = new Scheduler(
      svc,
      fakeSessions(runScheduled),
      () => {},
      () => {},
    );

    sched.tick(new Date('2026-06-20T10:00:30Z')); // 触发，run 卡在 gate
    sched.tick(new Date('2026-06-20T10:01:30Z')); // 仍在跑 → 本拍应跳过该任务
    expect(runScheduled).toHaveBeenCalledTimes(1);

    resolveRun();
    await sched.drain();
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });
});
