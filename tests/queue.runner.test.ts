/**
 * 持久化队列 runner 集成测试。
 *
 * 用真 LibraryService + 真 QueueStore + 真 fs；只 stub hydrator 来避免 LLM 调用。
 *
 * 关注：
 *   - 队列状态机（pending → running → completed / dead / pending+backoff）
 *   - 崩溃恢复（启动时把上轮残留的 running 重置为 pending，attempts 不动）
 *   - linkCandidates 在每次成功 put 后刷新
 *   - id 冲突避让（两文件同 id → 第二个走 -2）
 *   - AbortSignal 触发后等在飞的完成、写 cancelled event
 *   - backoff 闸门：失败后 nextEarliestRunAt 之前不会被拉起
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { HydrationService, HydrateInput } from '../src/wiki/hydration.js';
import type { Entry } from '../src/wiki/types.js';
import {
  deriveJobId,
  pushEvent,
  type QueueJob,
} from '../src/wiki/queue/state.js';
import { QueueStore } from '../src/wiki/queue/store.js';
import { runQueue } from '../src/wiki/queue/runner.js';

let tmpRoot: string;
let wikiRoot: string;
let logDir: string;
let statePath: string;
let library: LibraryService;
let store: QueueStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-queue-runner-'));
  wikiRoot = path.join(tmpRoot, 'wiki');
  logDir = path.join(tmpRoot, 'logs');
  statePath = path.join(tmpRoot, 'state.json');
  fs.mkdirSync(wikiRoot, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  library = new LibraryService(wikiRoot);
  store = new QueueStore(statePath);
});

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function makeFile(name: string, content = `content of ${name}`): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

interface FakeHydrator {
  hydrator: HydrationService;
  calls: HydrateInput[];
}

interface FakeOpts {
  idFor?: (input: HydrateInput, callIndex: number) => string;
  errorFor?: (input: HydrateInput, callIndex: number) => unknown | null;
  delayMs?: number;
}

function makeFakeHydrator(opts: FakeOpts = {}): FakeHydrator {
  const calls: HydrateInput[] = [];
  let callIndex = 0;
  const hydrator = {
    hydrate: async (input: HydrateInput): Promise<Entry> => {
      const idx = callIndex++;
      calls.push(input);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const err = opts.errorFor?.(input, idx);
      if (err) throw err;
      const id =
        opts.idFor?.(input, idx) ??
        path.basename(input.source.value ?? `entry-${idx}`, '.md');
      return {
        id,
        collection: input.collectionId,
        title: id,
        summary: '',
        tags: [],
        links: [],
        content: `# ${id}\n\nfake`,
        source: input.source,
        updated: new Date().toISOString(),
      };
    },
  } as unknown as HydrationService;
  return { hydrator, calls };
}

/** 帮 runQueue 造一个永不 abort 的 signal（测试用）。 */
function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/** 工厂：把一个 file 入队成 pending job。 */
function enqueue(file: string, collection: string, force = false): string {
  const id = deriveJobId(file, collection);
  store.mutate((s) => {
    const job: QueueJob = {
      id,
      file,
      collection,
      force,
      status: 'pending',
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
    };
    s.jobs[id] = job;
    pushEvent(s, { ts: job.enqueuedAt, jobId: id, kind: 'enqueued' });
  });
  return id;
}

const FAST_BACKOFF = [10, 20, 40]; // ms — 测试用，几乎瞬时

describe('runQueue — 单 job 基础流程', () => {
  it('pending → running → completed，落 entry，attempts=0', async () => {
    const file = makeFile('alpha.md');
    const jobId = enqueue(file, 'tech');

    const { hydrator } = makeFakeHydrator();
    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(summary).toEqual({ ok: 1, dead: 0, cancelled: 0 });
    const final = store.load();
    expect(final.jobs[jobId].status).toBe('completed');
    expect(final.jobs[jobId].attempts).toBe(0);
    expect(final.jobs[jobId].finalEntryId).toBe('alpha');
    expect(library.get('alpha')).not.toBeNull();
    // 写了 log 文件
    expect(fs.existsSync(path.join(logDir, `${jobId}.log`))).toBe(true);
  });
});

describe('runQueue — 失败重试与 dead', () => {
  it('持续失败 → 重试 maxAttempts 次后归档为 dead', async () => {
    const file = makeFile('flaky.md');
    const jobId = enqueue(file, 'tech');

    const { hydrator, calls } = makeFakeHydrator({
      errorFor: () => new Error('network down'),
    });

    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(summary.dead).toBe(1);
    expect(summary.ok).toBe(0);

    const final = store.load();
    expect(final.jobs[jobId].status).toBe('dead');
    expect(final.jobs[jobId].attempts).toBe(3);
    expect(final.jobs[jobId].lastError).toContain('network down');
    // hydrator 实际被调用 3 次（每次 queue attempt 一次；非 429 不在内部重试）
    expect(calls).toHaveLength(3);
    // 最后一条 event 是 dead
    const evs = final.events.filter((e) => e.jobId === jobId);
    expect(evs[evs.length - 1].kind).toBe('dead');
  });

  it('暂时失败后恢复：第一次失败 → 第二次成功', async () => {
    const file = makeFile('eventually-ok.md');
    const jobId = enqueue(file, 'tech');

    let count = 0;
    const { hydrator } = makeFakeHydrator({
      errorFor: () => {
        count += 1;
        return count <= 1 ? new Error('one-time fault') : null;
      },
    });

    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(summary.ok).toBe(1);
    const final = store.load();
    expect(final.jobs[jobId].status).toBe('completed');
    expect(final.jobs[jobId].attempts).toBe(1); // 一次失败留下来
    expect(library.get('eventually-ok')).not.toBeNull();
  });
});

describe('runQueue — 并发', () => {
  it('concurrency=2，5 个 job 全部完成', async () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => makeFile(`${n}.md`));
    for (const f of files) enqueue(f, 'tech');

    const { hydrator } = makeFakeHydrator({ delayMs: 5 });
    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 2,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(summary).toEqual({ ok: 5, dead: 0, cancelled: 0 });
    expect(library.list('tech').map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('runQueue — 崩溃恢复', () => {
  it('启动时把残留的 running 重置为 pending，attempts 不变', async () => {
    const file = makeFile('was-running.md');
    const jobId = enqueue(file, 'tech');
    // 模拟上轮挂在 running 状态：手动 mutate
    store.mutate((s) => {
      const j = s.jobs[jobId];
      j.status = 'running';
      j.attempts = 1; // 已经失败过一次
      j.startedAt = '2026-04-29T00:00:00.000Z';
    });

    const { hydrator } = makeFakeHydrator();
    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(summary.ok).toBe(1);
    const final = store.load();
    // attempts=1 保留（不增不减）；最终成功 → completed
    expect(final.jobs[jobId].status).toBe('completed');
    expect(final.jobs[jobId].attempts).toBe(1);
    // 第一条 event 应该是 reset
    const resetEvent = final.events.find((e) => e.jobId === jobId && e.kind === 'reset');
    expect(resetEvent).toBeDefined();
  });
});

describe('runQueue — linkCandidates 刷新', () => {
  it('第一个 job 成功后，第二个 job 的 hydrator 收到的 candidates 包含第一个', async () => {
    const fileA = makeFile('first.md');
    const fileB = makeFile('second.md');
    enqueue(fileA, 'tech');
    enqueue(fileB, 'tech');

    const { hydrator, calls } = makeFakeHydrator({ delayMs: 5 });
    // concurrency=1 强制顺序，方便断言
    await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(calls).toHaveLength(2);
    // 第一次调用：没人在前面，candidates 不含 first/second
    const first = calls[0].linkCandidates ?? [];
    expect(first.map((e) => e.id)).not.toContain('first');
    // 第二次调用：first 已经入库，应该出现在 candidates 里
    const second = calls[1].linkCandidates ?? [];
    expect(second.map((e) => e.id)).toContain('first');
  });
});

describe('runQueue — id 冲突避让', () => {
  it('两个不同源文件返回同一 id 时，第二个加 -2 后缀', async () => {
    const fileA = makeFile('one.md');
    const fileB = makeFile('two.md');
    const idA = enqueue(fileA, 'tech');
    const idB = enqueue(fileB, 'tech');

    const { hydrator } = makeFakeHydrator({
      idFor: () => 'agent-design',
      delayMs: 5,
    });

    await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1, // 顺序处理，让冲突可预测
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    const final = store.load();
    const finalIds = [final.jobs[idA].finalEntryId, final.jobs[idB].finalEntryId].sort();
    expect(finalIds).toEqual(['agent-design', 'agent-design-2']);
    expect(library.list('tech').map((e) => e.id).sort()).toEqual([
      'agent-design',
      'agent-design-2',
    ]);
  });
});

describe('runQueue — Abort', () => {
  it('signal abort 后停止拉新 job、等在飞的完成、写 cancelled event', async () => {
    const files = ['a', 'b', 'c', 'd'].map((n) => makeFile(`${n}.md`));
    for (const f of files) enqueue(f, 'tech');

    const { hydrator } = makeFakeHydrator({ delayMs: 50 });
    const ac = new AbortController();
    // 在 30ms 时触发取消——此时第一个 job 还在 hydrate，剩下的还没拿
    setTimeout(() => ac.abort(), 30);

    const summary = await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: ac.signal,
      log: () => {},
    });

    // ok 至多 1（在飞的那个完成），剩下的应该还是 pending
    expect(summary.ok).toBeLessThanOrEqual(1);
    const final = store.load();
    const stillPending = Object.values(final.jobs).filter((j) => j.status === 'pending');
    expect(stillPending.length).toBeGreaterThanOrEqual(2);
    // 写了 cancelled 事件
    expect(final.events.some((e) => e.kind === 'cancelled')).toBe(true);
  });
});

describe('runQueue — idleBehavior=wait', () => {
  it('队列空时不退出，等到外部 mutate 加 job 后继续处理', async () => {
    const file = makeFile('late-arrival.md');
    // 不预先入队——让 runner 在 wait 模式空转

    const { hydrator, calls } = makeFakeHydrator({ delayMs: 5 });
    const ac = new AbortController();

    const runner = runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: FAST_BACKOFF,
      logDir,
      signal: ac.signal,
      log: () => {},
      idleBehavior: 'wait',
      idlePollMs: 30, // 测试用极短轮询
    });

    // 等一会儿（worker 应该在空转），然后从外部 mutate 加 job
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(0); // 此时还没活，hydrator 没被调过

    enqueue(file, 'tech');

    // 给 worker 时间发现新 job 并跑完
    await new Promise((r) => setTimeout(r, 200));

    // job 应该已经完成
    const final = store.load();
    const job = Object.values(final.jobs)[0];
    expect(job.status).toBe('completed');
    expect(calls).toHaveLength(1);

    // 收尾：abort 让 runner 真正退出
    ac.abort();
    const summary = await runner;
    expect(summary.ok).toBe(1);
  }, 5000);
});

describe('runQueue — backoff 闸门', () => {
  it('失败后在 nextEarliestRunAt 之前不会被立即重试', async () => {
    const file = makeFile('slow-retry.md');
    const jobId = enqueue(file, 'tech');

    let attemptCount = 0;
    const attemptTimes: number[] = [];
    const { hydrator } = makeFakeHydrator({
      errorFor: () => {
        attemptCount += 1;
        attemptTimes.push(Date.now());
        // 前两次失败，第三次成功
        return attemptCount <= 2 ? new Error('try again') : null;
      },
    });

    const t0 = Date.now();
    await runQueue({
      store,
      hydrator,
      library,
      concurrency: 1,
      maxAttempts: 5,
      backoffMs: [50, 100, 200, 400, 800],
      logDir,
      signal: neverAbort(),
      log: () => {},
    });

    expect(attemptCount).toBe(3);
    // 第二次尝试至少在 t0+50 之后（第一次失败后 backoff[0]=50ms）
    expect(attemptTimes[1] - t0).toBeGreaterThanOrEqual(40);
    // 第三次尝试至少在 attempts[1]+100 之后
    expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(80);

    const final = store.load();
    expect(final.jobs[jobId].status).toBe('completed');
    expect(final.jobs[jobId].attempts).toBe(2);
  });
});
