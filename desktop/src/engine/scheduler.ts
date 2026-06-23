import PQueue from 'p-queue';
import type { ScheduleService } from '@core/schedule/service.js';
import type { RunRecord } from '@core/schedule/types.js';
import type { SessionManager } from './sessionManager.js';
import type { EngineEvent } from '../shared/protocol.js';
import { resolveDatePlaceholders } from '../shared/placeholders.js';

/**
 * Scheduler —— 桌面 engine 内的定时任务触发宿主（ADR：宿主=桌面 engine）。
 *
 * 语义（见 docs/PRD-schedule.md）：
 *   - 30s tick：computeDue(now) → markTick(now)。先算后标，停机窗口才判得出。
 *   - 触发串行：所有 run 经一个 p-queue(concurrency=1)，一次只跑一个 agent。
 *   - 同任务正在跑时，本拍对它的决策直接忽略（不记录、不推进 lastFiredAt）——
 *     运行结束后 recordRun 推进 lastFiredAt，下拍自然 collapse 到最近 occurrence。
 *   - 启动即跑一拍：把关机期间错过的触发按 catch-up 规则补上。
 *   - App 关着不触发（utilityProcess 不在）——这是「开着才跑 + 启动补跑」的固有边界。
 */

const TICK_MS = 30_000;
let runSeq = 0;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly inflight = new Set<string>();

  constructor(
    private readonly service: ScheduleService,
    private readonly sessions: SessionManager,
    private readonly emit: (evt: EngineEvent) => void,
    private readonly onError: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    // 启动即补跑一拍，再进入周期
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** 等待当前排队中的所有 run 跑完（测试用）。 */
  async drain(): Promise<void> {
    await this.queue.onIdle();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.clear();
  }

  /** 立即触发一次（Run now）：绕过调度判定，直接排队执行（不动 lastFiredAt）。 */
  runNow(taskId: string): void {
    const task = this.service.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    void this.enqueueRun(taskId, new Date().toISOString(), 'ok', /*advance*/ false);
  }

  /** 跑一拍调度（默认当前时刻；测试可注入 now）。public 以便测试直接驱动。 */
  tick(now: Date = new Date()): void {
    let due;
    try {
      due = this.service.computeDue(now);
      this.service.markTick(now);
    } catch (err) {
      this.onError(`schedule tick failed: ${(err as Error).message}`);
      return;
    }
    for (const d of due) {
      if (this.inflight.has(d.taskId)) continue; // 同任务在跑 → 本拍忽略
      if (d.action === 'skip') {
        this.recordSkip(d.taskId, d.fireTime);
        continue;
      }
      void this.enqueueRun(d.taskId, d.fireTime, d.status === 'catchUp' ? 'catchUp' : 'ok', true);
    }
    this.emitUpdate();
  }

  private recordSkip(taskId: string, fireTime: string): void {
    const run: RunRecord = {
      runId: `run-${++runSeq}`,
      sessionId: '',
      firedAt: fireTime,
      status: 'skipped',
    };
    try {
      this.service.recordRun(taskId, run, fireTime);
    } catch (err) {
      this.onError(`schedule record skip failed: ${(err as Error).message}`);
    }
  }

  private enqueueRun(
    taskId: string,
    fireTime: string,
    status: 'ok' | 'catchUp',
    advance: boolean,
  ): Promise<void> {
    this.inflight.add(taskId);
    return this.queue
      .add(async () => {
        const task = this.service.get(taskId);
        if (!task) return;
        // 触发时解析日期占位符（${yyyy-mm-dd}/${yyyy-mm-dd -1}…），以本次 occurrence 时刻为基准。
        // 这样 agent 拿到的是写死的日期，不必自己推断「昨天」（曾算错）。
        const baseDate = new Date(fireTime);
        const input = resolveDatePlaceholders(task.input, baseDate);
        const rawTitle = task.title ?? task.input.split('\n')[0].slice(0, 48);
        const title = resolveDatePlaceholders(rawTitle, baseDate);
        const result = await this.sessions.runScheduled(input, title, {
          requireApproval: task.requireApproval,
        });
        const run: RunRecord = {
          runId: `run-${++runSeq}`,
          sessionId: result.sessionId,
          firedAt: fireTime,
          status: result.status === 'failed' ? 'failed' : status,
          preview: result.preview,
          error: result.error,
        };
        // advance=false（Run now）时省略 firedAt，不推进 lastFiredAt
        this.service.recordRun(taskId, run, advance ? fireTime : undefined);
      })
      .catch((err: Error) => this.onError(`schedule run failed: ${err.message}`))
      .finally(() => {
        this.inflight.delete(taskId);
        this.emitUpdate();
      });
  }

  private emitUpdate(): void {
    this.emit({ kind: 'schedule.update' });
  }
}
