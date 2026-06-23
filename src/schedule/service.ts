import { ID_RE } from '../wiki/types.js';
import { nextFireAfter } from './cron.js';
import { ScheduleStore } from './store.js';
import {
  pushRun,
  ScheduledTaskSchema,
  type RunRecord,
  type RunStatus,
  type ScheduledTask,
  type ScheduleSpec,
} from './types.js';

/**
 * ScheduleService —— 定时任务的纯逻辑层（CRUD + 触发计算 + catch-up 判定），
 * 不碰 agent / Electron，供 agent 工具与桌面 engine tick 共用（唯一真相源）。
 */

/** 引擎正常 tick 间隔；超过这个数量级的 lastTick 间隔即判为「停机/休眠」→ 触发归类为补跑。 */
export const DOWNTIME_THRESHOLD_MS = 2 * 60 * 1000;

export interface CreateTaskInput {
  input: string;
  schedule: ScheduleSpec;
  title?: string;
  enabled?: boolean;
  catchUp?: boolean;
  requireApproval?: boolean;
  /** 显式指定 id（缺省由 title/input 派生）。 */
  id?: string;
}

/** 一次 tick 的触发决策：run = 真跑 agent；skip = 仅记一条 skipped（补跑被关时）。 */
export interface DueDecision {
  taskId: string;
  action: 'run' | 'skip';
  status: RunStatus; // run → 'ok' | 'catchUp'；skip → 'skipped'
  fireTime: string; // ISO，写入 lastFiredAt
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`scheduled task not found: ${id}`);
    this.name = 'ScheduleNotFoundError';
  }
}

export class ScheduleService {
  constructor(private readonly store: ScheduleStore) {}

  list(): ScheduledTask[] {
    return Object.values(this.store.load().tasks).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  get(id: string): ScheduledTask | undefined {
    return this.store.load().tasks[id];
  }

  create(input: CreateTaskInput, now = new Date()): ScheduledTask {
    const ts = now.toISOString();
    let createdId = '';
    const state = this.store.mutate((s) => {
      createdId = uniqueId(input.id ?? deriveId(input.title ?? input.input), s.tasks);
      s.tasks[createdId] = ScheduledTaskSchema.parse({
        id: createdId,
        input: input.input,
        title: input.title,
        schedule: input.schedule,
        enabled: input.enabled ?? true,
        catchUp: input.catchUp ?? true,
        requireApproval: input.requireApproval ?? false,
        runs: [],
        createdAt: ts,
        updatedAt: ts,
      });
      return s;
    });
    return state.tasks[createdId];
  }

  /**
   * 更新可变字段（input/title/schedule/enabled/catchUp）。改 schedule 会清空
   * lastFiredAt，让新调度从头算下一次触发。未知 id 抛 ScheduleNotFoundError。
   */
  update(
    id: string,
    patch: Partial<
      Pick<ScheduledTask, 'input' | 'title' | 'schedule' | 'enabled' | 'catchUp' | 'requireApproval'>
    >,
    now = new Date(),
  ): ScheduledTask {
    return mutateTask(this.store, id, (task) => {
      if (patch.input !== undefined) task.input = patch.input;
      if (patch.title !== undefined) task.title = patch.title;
      if (patch.enabled !== undefined) task.enabled = patch.enabled;
      if (patch.catchUp !== undefined) task.catchUp = patch.catchUp;
      if (patch.requireApproval !== undefined) task.requireApproval = patch.requireApproval;
      if (patch.schedule !== undefined) {
        task.schedule = patch.schedule;
        task.lastFiredAt = undefined; // 调度变了，重新算触发
      }
      task.updatedAt = now.toISOString();
      // 重新校验（schedule/input 可能非法）
      ScheduledTaskSchema.parse(task);
    });
  }

  delete(id: string): boolean {
    let existed = false;
    this.store.mutate((state) => {
      existed = id in state.tasks;
      delete state.tasks[id];
      return state;
    });
    return existed;
  }

  /**
   * 记录一次运行结果（追加 run）。`firedAt` 给定时推进 lastFiredAt；省略
   * （Run now 等手动触发）则不动 lastFiredAt，以免吞掉真实调度的 occurrence。
   */
  recordRun(id: string, run: RunRecord, firedAt?: string): void {
    mutateTask(this.store, id, (task) => {
      pushRun(task, run);
      if (firedAt !== undefined) task.lastFiredAt = firedAt;
    });
  }

  /** 写入本次 tick 时刻（启动补跑据此判定停机窗口）。 */
  markTick(now = new Date()): void {
    this.store.mutate((state) => {
      state.lastTickAt = now.toISOString();
      return state;
    });
  }

  /** 某任务严格晚于 `after` 的下一次触发（日历/列表展示「下次触发」用）。 */
  nextFire(task: ScheduledTask, after = new Date()): Date | null {
    if (task.schedule.kind === 'once') {
      const at = new Date(task.schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    return nextFireAfter(task.schedule.expr, after);
  }

  /**
   * 计算本次 tick 应处理哪些任务。核心 catch-up 逻辑：
   *   - cron：(since, now] 内有任何未触发的 occurrence → 折叠成 1 次。
   *   - once：at ≤ now 且未触发过 → 1 次。
   *   - 停机窗口（now - lastTick > 阈值）内的触发归类为 catchUp；
   *     若任务 catchUp=false 则改记 skipped（推进 lastFiredAt，不再 lingering）。
   */
  computeDue(now = new Date()): DueDecision[] {
    const state = this.store.load();
    const lastTick = state.lastTickAt ? new Date(state.lastTickAt) : null;
    const wasDowntime =
      lastTick !== null && now.getTime() - lastTick.getTime() > DOWNTIME_THRESHOLD_MS;
    const out: DueDecision[] = [];

    for (const task of Object.values(state.tasks)) {
      if (!task.enabled) continue;
      const fireTime = this.dueFireTime(task, now);
      if (!fireTime) continue;
      const late = wasDowntime; // 停机后这一拍触发的都算迟到
      if (late && !task.catchUp) {
        out.push({
          taskId: task.id,
          action: 'skip',
          status: 'skipped',
          fireTime: fireTime.toISOString(),
        });
      } else {
        out.push({
          taskId: task.id,
          action: 'run',
          status: late ? 'catchUp' : 'ok',
          fireTime: fireTime.toISOString(),
        });
      }
    }
    return out;
  }

  /** 该任务此刻应触发的「occurrence 时刻」（折叠后取最近一次），无则 null。 */
  private dueFireTime(task: ScheduledTask, now: Date): Date | null {
    const since = task.lastFiredAt ? new Date(task.lastFiredAt) : new Date(task.createdAt);
    if (task.schedule.kind === 'once') {
      const at = new Date(task.schedule.at);
      if (at.getTime() <= now.getTime() && at.getTime() > since.getTime()) return at;
      // lastFiredAt 已 ≥ at → 已跑过
      if (!task.lastFiredAt && at.getTime() <= now.getTime()) return at;
      return null;
    }
    // cron：找 (since, now] 内最近一次触发（折叠多次错过为一次）
    let cursor = since;
    let last: Date | null = null;
    for (;;) {
      const next = nextFireAfter(task.schedule.expr, cursor);
      if (!next || next.getTime() > now.getTime()) break;
      last = next;
      cursor = next;
    }
    return last;
  }
}

function mutateTask(
  store: ScheduleStore,
  id: string,
  fn: (task: ScheduledTask) => void,
): ScheduledTask {
  const state = store.mutate((s) => {
    const task = s.tasks[id];
    if (!task) throw new ScheduleNotFoundError(id);
    fn(task);
    return s;
  });
  return state.tasks[id];
}

/** 把标题/输入 slug 成符合 ID_RE 的 id（ASCII kebab 或 CJK，无大写/前导连字符）。 */
export function deriveId(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const slug = firstLine
    .toLowerCase()
    // 保留 a-z 0-9 与 CJK（Han/かな/한글），其余转连字符
    .replace(/[^a-z0-9぀-ヿ㐀-鿿가-힯]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug && ID_RE.test(slug) ? slug : 'task';
}

function uniqueId(base: string, existing: Record<string, unknown>): string {
  if (!(base in existing)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!(candidate in existing)) return candidate;
  }
}
