/**
 * 定时任务核心层单元测试（src/schedule/）。
 *
 * 覆盖：
 *  - cron：解析/校验、nextFireAfter 的分时日周语义、dom/dow OR、步长/范围
 *  - ScheduleService CRUD + id 派生 + 唯一化
 *  - computeDue 的 catch-up 决策（一次性迟到补跑 / cron 折叠 / 停机跳过）
 *
 * 不覆盖：engine tick 与 agent 执行（属 integration，桌面端 deep module 测）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidCron, nextFireAfter, fireTimesBetween, parseCron } from '../src/schedule/cron.js';
import { ScheduleStore } from '../src/schedule/store.js';
import { ScheduleService, deriveId } from '../src/schedule/service.js';

describe('cron', () => {
  it('rejects malformed expressions', () => {
    expect(isValidCron('0 9 * *')).toBe(false); // 4 fields
    expect(isValidCron('60 0 * * *')).toBe(false); // minute out of range
    expect(isValidCron('0 24 * * *')).toBe(false); // hour out of range
    expect(isValidCron('0 0 0 * *')).toBe(false); // dom min is 1
    expect(isValidCron('* * * * 8')).toBe(false); // dow max is 7
    expect(() => parseCron('a b c d e')).toThrow();
  });

  it('accepts standard forms incl. ranges/lists/steps and dow=7', () => {
    expect(isValidCron('0 9 * * 1')).toBe(true);
    expect(isValidCron('*/15 0-6 1,15 * *')).toBe(true);
    expect(isValidCron('0 0 * * 7')).toBe(true); // 7 = Sunday
  });

  it('nextFireAfter: daily 09:00', () => {
    const after = new Date(2026, 5, 17, 8, 0, 0); // local
    const next = nextFireAfter('0 9 * * *', after)!;
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(17);
  });

  it('nextFireAfter: rolls to next day when past', () => {
    const after = new Date(2026, 5, 17, 10, 0, 0);
    const next = nextFireAfter('0 9 * * *', after)!;
    expect(next.getDate()).toBe(18);
    expect(next.getHours()).toBe(9);
  });

  it('nextFireAfter: Monday 09:00 lands on a Monday', () => {
    const after = new Date(2026, 5, 17, 0, 0, 0); // Wed 2026-06-17
    const next = nextFireAfter('0 9 * * 1', after)!;
    expect(next.getDay()).toBe(1);
  });

  it('dom/dow OR semantics: fires on the 1st OR on Mondays', () => {
    // "0 0 1 * 1" → midnight on day-1 or any Monday
    const fires = fireTimesBetween(
      '0 0 1 * 1',
      new Date(2026, 5, 1, 0, 0, 1), // just after Jun 1
      new Date(2026, 5, 30, 23, 59),
    );
    // every Monday in June + (Jun 1 already passed) — all should be day===1 or dow===1
    expect(fires.length).toBeGreaterThan(0);
    for (const f of fires) {
      expect(f.getDate() === 1 || f.getDay() === 1).toBe(true);
    }
  });

  it('returns null for impossible date (Feb 30)', () => {
    expect(nextFireAfter('0 0 30 2 *', new Date(2026, 0, 1))).toBeNull();
  });
});

describe('deriveId', () => {
  it('slugs ascii and CJK, strips punctuation, no leading hyphen', () => {
    expect(deriveId('Summarize my notes!')).toBe('summarize-my-notes');
    expect(deriveId('每天汇总')).toBe('每天汇总');
    expect(deriveId('  ***  ')).toBe('task');
    expect(deriveId('/weread sync')).toBe('weread-sync');
  });
});

describe('ScheduleService', () => {
  let dir: string;
  let svc: ScheduleService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    svc = new ScheduleService(new ScheduleStore(path.join(dir, 'state.json')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates, lists, updates, deletes', () => {
    const t = svc.create({
      input: 'do a thing',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    });
    expect(t.id).toBe('do-a-thing');
    expect(svc.list()).toHaveLength(1);

    const u = svc.update(t.id, { enabled: false });
    expect(u.enabled).toBe(false);

    expect(svc.delete(t.id)).toBe(true);
    expect(svc.delete(t.id)).toBe(false);
    expect(svc.list()).toHaveLength(0);
  });

  it('uniquifies colliding ids', () => {
    const a = svc.create({
      input: 'task',
      schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
    });
    const b = svc.create({
      input: 'task',
      schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
    });
    expect(a.id).toBe('task');
    expect(b.id).toBe('task-2');
  });

  it('rejects invalid cron at create', () => {
    expect(() =>
      svc.create({ input: 'x', schedule: { kind: 'cron', expr: 'nope', tz: 'UTC' } }),
    ).toThrow();
  });

  it('once: not due before time, due once at/after time', () => {
    const at = new Date(2026, 5, 20, 9, 0, 0);
    const createdAt = new Date(2026, 5, 19, 0, 0, 0); // 显式，避免依赖真实墙钟
    const t = svc.create(
      { input: 'one shot', schedule: { kind: 'once', at: at.toISOString() } },
      createdAt,
    );

    expect(svc.computeDue(new Date(2026, 5, 20, 8, 59, 0))).toHaveLength(0);

    // first-ever tick (no lastTickAt) at/after the time → run, status ok
    const due = svc.computeDue(new Date(2026, 5, 20, 9, 0, 30));
    expect(due).toEqual([expect.objectContaining({ taskId: t.id, action: 'run', status: 'ok' })]);
  });

  it('once: missed during downtime → catchUp run; with catchUp:false → skip', () => {
    const at = new Date(2026, 5, 20, 9, 0, 0).toISOString();
    const createdAt = new Date(2026, 5, 18, 0, 0, 0); // 显式，避免依赖真实墙钟
    const t1 = svc.create(
      { input: 'late ok', schedule: { kind: 'once', at }, catchUp: true },
      createdAt,
    );
    // simulate a prior tick long before, then a tick well after (downtime)
    svc.markTick(new Date(2026, 5, 19, 0, 0, 0));
    const due1 = svc.computeDue(new Date(2026, 5, 21, 0, 0, 0));
    expect(due1.find((d) => d.taskId === t1.id)).toMatchObject({
      action: 'run',
      status: 'catchUp',
    });

    const t2 = svc.create(
      { input: 'late skip', schedule: { kind: 'once', at }, catchUp: false },
      createdAt,
    );
    const due2 = svc.computeDue(new Date(2026, 5, 21, 0, 0, 0));
    expect(due2.find((d) => d.taskId === t2.id)).toMatchObject({
      action: 'skip',
      status: 'skipped',
    });
  });

  it('cron: collapses multiple missed fires into one catchUp run', () => {
    const t = svc.create(
      { input: 'hourly', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } },
      new Date(2026, 5, 17, 9, 0, 0), // 显式 createdAt，避免依赖真实墙钟
    );
    // baseline tick, then jump 5 hours later (5 missed fires)
    svc.markTick(new Date(2026, 5, 17, 10, 0, 5));
    const due = svc.computeDue(new Date(2026, 5, 17, 15, 30, 0));
    const d = due.find((x) => x.taskId === t.id)!;
    expect(d.action).toBe('run');
    expect(d.status).toBe('catchUp'); // downtime
    // collapsed to the latest occurrence (15:00)
    expect(new Date(d.fireTime).getHours()).toBe(15);
  });

  it('recordRun advances lastFiredAt so the same occurrence does not re-fire', () => {
    const t = svc.create(
      { input: 'hourly', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } },
      new Date(2026, 5, 17, 9, 0, 0), // 显式 createdAt，避免依赖真实墙钟
    );
    svc.markTick(new Date(2026, 5, 17, 10, 0, 5));
    const now = new Date(2026, 5, 17, 11, 0, 30);
    const [d] = svc.computeDue(now);
    svc.recordRun(
      t.id,
      { runId: 'r1', sessionId: 's1', firedAt: d.fireTime, status: d.status },
      d.fireTime,
    );
    // immediately re-evaluating at the same now → no longer due
    expect(svc.computeDue(now).find((x) => x.taskId === t.id)).toBeUndefined();
  });

  it('disabled tasks never fire', () => {
    const t = svc.create({
      input: 'paused',
      schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
      enabled: false,
    });
    expect(
      svc.computeDue(new Date(2026, 5, 17, 12, 0, 30)).find((x) => x.taskId === t.id),
    ).toBeUndefined();
  });
});
