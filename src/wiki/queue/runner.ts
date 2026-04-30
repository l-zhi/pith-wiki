import PQueue from 'p-queue';
import type { HydrationService } from '../hydration.js';
import type { LibraryService } from '../library.js';
import type { Entry } from '../types.js';
import { processJob, resolveSourcePath, formatResultLine } from './processJob.js';
import {
  pushEvent,
  type QueueJob,
  type QueueState,
} from './state.js';
import { QueueStore } from './store.js';
import { openJobLog, type JobLogger } from './jobLogger.js';

/**
 * 持久化队列 worker。
 *
 * 主循环：
 *   1. 启动时把所有 status='running' 的 job 重置为 pending（崩溃恢复，不增减 attempts）
 *   2. 反复从 state 拉 status='pending' 且过了退避闸门的 job 喂进 p-queue
 *   3. 每个 job：mutate 标 running → 调 processJob → mutate 写最终态
 *      - ok / skipped → completed
 *      - failed 且 attempts+1 < maxAttempts → pending + nextEarliestRunAt
 *      - failed 且达到上限 → dead
 *   4. 当没有 in-flight、也没有未来调度（所有 backoff 都过期）时退出
 *   5. AbortSignal 触发后停止拉新 job，等在飞的完成，写 cancelled event
 *
 * attempts 语义：表示"已经失败的次数"。
 *   - 成功 job 的最终 attempts 等于失败重试过的次数（≥ 0）
 *   - dead job 的 attempts == maxAttempts
 *   - 起手 status=running 时不递增 attempts，避免崩溃凭空消耗用户重试预算
 */

export interface RunQueueOptions {
  store: QueueStore;
  hydrator: HydrationService;
  library: LibraryService;
  /** p-queue 并发数。 */
  concurrency: number;
  /** 队列级最大尝试次数。第 N 次失败后归档为 dead。 */
  maxAttempts: number;
  /** 失败之后到下次可拉起之间的等待 ms。第 i 次失败后查 backoffMs[i-1]。 */
  backoffMs: number[];
  /** 每个 job 一份独立 log 的目录。 */
  logDir: string;
  signal: AbortSignal;
  /** 控制台进度回调（一行一条，仿 batch.ts 的 [N/Total] 格式）。 */
  log: (line: string) => void;
  /**
   * 队列空闲时的行为：
   *   - 'exit'（默认）：没活就退出。`queue run` 用这个，符合"跑完拉到完整 summary"。
   *   - 'wait'：没活就 sleep（默认 5s）后重读 state；让 REPL 内的 wiki_queue_add
   *     能被同进程 worker 在不重启的情况下自动拾起。退出靠 signal.aborted。
   */
  idleBehavior?: 'exit' | 'wait';
  /** 'wait' 模式下，空闲轮询的 sleep 间隔（ms）。默认 5000。 */
  idlePollMs?: number;
}

export interface RunQueueSummary {
  ok: number;
  dead: number;
  cancelled: number;
}

interface CollectionSnapshot {
  entries: Entry[];
  existingPaths: Set<string>;
  claimedIds: Set<string>;
}

function buildSnapshot(library: LibraryService, collection: string): CollectionSnapshot {
  const entries = library.list(collection);
  const existingPaths = new Set<string>();
  const claimedIds = new Set<string>();
  for (const e of entries) {
    const abs = resolveSourcePath(e.source?.value);
    if (abs) existingPaths.add(abs);
    claimedIds.add(e.id);
  }
  return { entries, existingPaths, claimedIds };
}

export async function runQueue(opts: RunQueueOptions): Promise<RunQueueSummary> {
  const { store, signal } = opts;
  const summary: RunQueueSummary = { ok: 0, dead: 0, cancelled: 0 };

  // 每个 collection 一份 snapshot，处理多 collection 并存的情况。
  // 任一 collection 内成功 put 后整份 snapshot 失效重建，保持 claimedIds / linkCandidates 新鲜。
  const snapshots = new Map<string, CollectionSnapshot>();
  function getSnap(c: string): CollectionSnapshot {
    let s = snapshots.get(c);
    if (!s) {
      s = buildSnapshot(opts.library, c);
      snapshots.set(c, s);
    }
    return s;
  }

  // 1. 崩溃恢复：把上次跑挂在 running 的 job 改回 pending（attempts 不动，
  //    nextEarliestRunAt 清掉允许立即重试）。
  store.mutate((s) => {
    for (const job of Object.values(s.jobs)) {
      if (job.status === 'running') {
        job.status = 'pending';
        job.startedAt = undefined;
        job.nextEarliestRunAt = undefined;
        pushEvent(s, {
          ts: new Date().toISOString(),
          jobId: job.id,
          kind: 'reset',
          msg: 'reset from running on worker startup',
        });
      }
    }
  });

  const pqueue = new PQueue({ concurrency: opts.concurrency });
  const inFlight = new Set<string>();

  // 唤醒信号：等待循环用 Promise.race 接它，让 backoff sleep 能被 job 完成事件中断。
  let wakeResolve: (() => void) | null = null;
  function wake(): void {
    if (wakeResolve) {
      wakeResolve();
      wakeResolve = null;
    }
  }
  function nextWake(): Promise<void> {
    return new Promise((res) => {
      wakeResolve = res;
    });
  }

  const onAbort = (): void => wake();
  signal.addEventListener('abort', onAbort);

  // 控制台进度计数器：完成顺序生成 [N/Total]。Total 取的是当下队列中 pending+running+
  // in-flight 的数量，会随 add 命令变化——足够给用户一个粗略进度感受。
  let completed = 0;
  function totalAtMoment(state: QueueState): number {
    let n = 0;
    for (const j of Object.values(state.jobs)) {
      if (j.status === 'pending' || j.status === 'running') n += 1;
    }
    return n + completed; // completed 已经离开 pending/running
  }

  async function runOneJob(job: QueueJob): Promise<void> {
    const logger = openJobLog(opts.logDir, job.id);
    logger.info(`pickup attempt ${job.attempts + 1}/${opts.maxAttempts} (file=${job.file})`);

    // mutate: pending → running（不动 attempts；attempts 在失败结果里才递增）
    store.mutate((s) => {
      const cur = s.jobs[job.id];
      if (!cur) return;
      cur.status = 'running';
      cur.startedAt = new Date().toISOString();
      cur.nextEarliestRunAt = undefined;
      pushEvent(s, { ts: cur.startedAt!, jobId: job.id, kind: 'started' });
    });

    const snap = getSnap(job.collection);
    const t0 = Date.now();
    let result: Awaited<ReturnType<typeof processJob>>;
    try {
      result = await processJob(job.file, {
        collection: job.collection,
        force: job.force,
        hydrator: opts.hydrator,
        library: opts.library,
        existingEntries: snap.entries,
        existingPaths: snap.existingPaths,
        claimedIds: snap.claimedIds,
      });
    } catch (err) {
      // processJob 内部已经 try/catch；走到这里说明是真未预期错误。归类为 failed。
      result = {
        file: job.file,
        status: 'failed',
        reason: `unexpected error: ${(err as Error).message}`,
        attempts: 0,
      };
    }
    const elapsed = Date.now() - t0;
    finalizeJobResult(job, result, logger, elapsed);
    logger.close();
  }

  function finalizeJobResult(
    job: QueueJob,
    result: Awaited<ReturnType<typeof processJob>>,
    logger: JobLogger,
    elapsedMs: number,
  ): void {
    if (result.status === 'ok') {
      logger.info(`ok finalEntryId=${result.id} took=${elapsedMs}ms`);
      // 成功后刷新该 collection 的 snapshot：linkCandidates/claimedIds 保持新鲜
      snapshots.set(job.collection, buildSnapshot(opts.library, job.collection));
      const stateAfter = store.mutate((s) => {
        const cur = s.jobs[job.id];
        if (!cur) return;
        cur.status = 'completed';
        cur.completedAt = new Date().toISOString();
        cur.finalEntryId = result.id;
        cur.lastError = undefined;
        pushEvent(s, {
          ts: cur.completedAt!,
          jobId: job.id,
          kind: 'ok',
          msg: result.id,
        });
      });
      summary.ok += 1;
      completed += 1;
      opts.log(formatResultLine(completed, totalAtMoment(stateAfter), result));
      return;
    }
    if (result.status === 'skipped') {
      logger.info(`skipped reason=${result.reason}`);
      const stateAfter = store.mutate((s) => {
        const cur = s.jobs[job.id];
        if (!cur) return;
        cur.status = 'completed';
        cur.completedAt = new Date().toISOString();
        cur.finalEntryId = result.id;
        cur.lastError = result.reason;
        pushEvent(s, {
          ts: cur.completedAt!,
          jobId: job.id,
          kind: 'skipped',
          msg: result.reason,
        });
      });
      summary.ok += 1;
      completed += 1;
      opts.log(formatResultLine(completed, totalAtMoment(stateAfter), result));
      return;
    }
    // failed 分支：attempts++、判断是否达到 max
    logger.error(`failed reason=${result.reason}`);
    const stateAfter = store.mutate((s) => {
      const cur = s.jobs[job.id];
      if (!cur) return;
      cur.attempts += 1;
      cur.lastError = result.reason;
      cur.completedAt = undefined;
      if (cur.attempts >= opts.maxAttempts) {
        cur.status = 'dead';
        pushEvent(s, {
          ts: new Date().toISOString(),
          jobId: job.id,
          kind: 'dead',
          msg: result.reason,
        });
      } else {
        const idx = Math.min(cur.attempts - 1, opts.backoffMs.length - 1);
        const wait = opts.backoffMs[idx] ?? 0;
        cur.status = 'pending';
        cur.nextEarliestRunAt = new Date(Date.now() + wait).toISOString();
        pushEvent(s, {
          ts: new Date().toISOString(),
          jobId: job.id,
          kind: 'retry',
          msg: `attempt ${cur.attempts} failed; waiting ${wait}ms — ${result.reason ?? ''}`,
        });
      }
    });
    if (stateAfter.jobs[job.id]?.status === 'dead') {
      summary.dead += 1;
      completed += 1;
      opts.log(formatResultLine(completed, totalAtMoment(stateAfter), result));
    }
    // retry 分支：不计入 completed 进度，等下次循环再拉起
  }

  // 主循环
  try {
    while (!signal.aborted) {
      const state = store.load();
      const now = Date.now();
      const eligible: QueueJob[] = [];
      const futurePendings: QueueJob[] = [];
      for (const job of Object.values(state.jobs)) {
        if (job.status !== 'pending') continue;
        if (inFlight.has(job.id)) continue;
        const due = !job.nextEarliestRunAt || new Date(job.nextEarliestRunAt).getTime() <= now;
        if (due) eligible.push(job);
        else futurePendings.push(job);
      }
      eligible.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));

      for (const job of eligible) {
        if (signal.aborted) break;
        if (pqueue.size + pqueue.pending >= opts.concurrency * 2) {
          // 队列已经堆得够厚（worker + 待执行各一倍），先回去等出口
          break;
        }
        inFlight.add(job.id);
        pqueue.add(async () => {
          try {
            await runOneJob(job);
          } finally {
            inFlight.delete(job.id);
            wake();
          }
        });
      }

      if (inFlight.size === 0 && futurePendings.length === 0) {
        if ((opts.idleBehavior ?? 'exit') === 'exit') {
          // 没有正在跑的，也没有等退避到期的 → 真完事了
          break;
        }
        // 'wait' 模式：sleep 一段后回去重新 load，看有没有外部新增 pending。
        const idlePoll = opts.idlePollMs ?? 5_000;
        await Promise.race([
          new Promise<void>((res) => setTimeout(res, idlePoll)),
          nextWake(),
        ]);
        continue;
      }

      // 计算下次唤醒：未来调度里最早的 nextEarliestRunAt，否则 30s 兜底。
      let earliest = Number.POSITIVE_INFINITY;
      for (const j of futurePendings) {
        const t = new Date(j.nextEarliestRunAt!).getTime();
        if (t < earliest) earliest = t;
      }
      const sleepMs = Math.max(50, Math.min(earliest - Date.now(), 30_000));
      await Promise.race([
        new Promise<void>((res) => setTimeout(res, sleepMs)),
        nextWake(),
      ]);
    }

    // 取消路径：清掉 p-queue 里还没启动的任务（它们的 jobId 已经在 inFlight 集合里
    // 但没真正开 hydrate），等已经开始的完成，再写 cancelled event。
    if (signal.aborted) {
      const queuedButNotStarted = pqueue.size; // 还在 p-queue 内部排队、没真正开始执行
      pqueue.clear();
      const cancelledIds = Array.from(inFlight);
      await pqueue.onIdle();
      // queue.clear 之后，那些被丢弃的 task 永远不会执行 finally 把 inFlight 清掉，
      // 也不会 mutate 状态——它们仍是 pending 在 state.json 上，下次 run 时会被拉起。
      // cancelled 计数只统计真正在飞的那部分。
      summary.cancelled = Math.max(0, cancelledIds.length - queuedButNotStarted);
      store.mutate((s) => {
        pushEvent(s, {
          ts: new Date().toISOString(),
          jobId: '*',
          kind: 'cancelled',
          msg: `abort received; in-flight=${summary.cancelled}, dropped-from-queue=${queuedButNotStarted}`,
        });
      });
    } else {
      await pqueue.onIdle();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  return summary;
}
