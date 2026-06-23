import { z } from 'zod';
import { ID_RE } from '../wiki/types.js';
import { isValidCron } from './cron.js';

/**
 * 定时任务的 schema、序列化、原子 IO —— 与 src/wiki/queue/state.ts 同构
 * （整文件 JSON + `.tmp + rename`），见 docs/PRD-schedule.md。
 *
 * 一条任务 = 「到点用一段 input 串驱动 agent 跑一轮」。input 原样走桌面端
 * 会话执行路径（与 REPL handleSubmit 同源），所以 prompt / `/skill` 两种形态
 * 用一个字段覆盖，不另设 payload schema。
 */

export const SCHEDULE_STATE_VERSION = 1 as const;

/** 每任务保留的 run 历史上限（环形截断，防 state.json 无界增长）。 */
export const RUN_HISTORY_CAP = 50;

export const RunStatusSchema = z.enum(['ok', 'failed', 'skipped', 'catchUp']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  runId: z.string().min(1),
  /** 本次触发新开的 session id（可在 ChatPane 打开回看）。skipped 的 run 无 session → 空串。 */
  sessionId: z.string(),
  firedAt: z.string(),
  status: RunStatusSchema,
  /** final answer 的截断预览（状态面板用）。 */
  preview: z.string().optional(),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** 一次性：绝对时刻跑一次。 */
const OnceScheduleSchema = z.object({
  kind: z.literal('once'),
  at: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

/** 周期：5 字段 cron + 时区（v1 tz 仅元数据，求值按本机本地时区）。 */
const CronScheduleSchema = z.object({
  kind: z.literal('cron'),
  expr: z.string().refine(isValidCron, { message: 'invalid 5-field cron expression' }),
  tz: z.string().min(1),
});

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  OnceScheduleSchema,
  CronScheduleSchema,
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export const ScheduledTaskSchema = z.object({
  id: z.string().min(1).regex(ID_RE),
  /** 喂给 agent 的原样输入串（prompt 或 `/skill …`）。 */
  input: z.string().min(1),
  /** 人类可读名（列表/日历展示），缺省取 input 首行截断。 */
  title: z.string().optional(),
  schedule: ScheduleSpecSchema,
  /** 暂停而不删除：禁用的不触发、日历不画未来点。 */
  enabled: z.boolean(),
  /** 错过的触发是否补跑（默认 true）。cron 折叠成 1 次，once 迟到补跑。 */
  catchUp: z.boolean(),
  /**
   * 触发时是否需要人工审批工具调用（写文件 / 执行命令）。默认 false = 自动放行
   * （无人值守也能跑通）。true = 沿用交互式审批：有人在看才会被批准，否则整轮超时记
   * failed —— 给做敏感操作、希望「跑前我确认一下」的任务用。`.default` 让旧状态文件兼容。
   */
  requireApproval: z.boolean().default(false),
  lastFiredAt: z.string().optional(),
  runs: z.array(RunRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

export const ScheduleStateSchema = z.object({
  version: z.literal(SCHEDULE_STATE_VERSION),
  tasks: z.record(z.string(), ScheduledTaskSchema),
  /** 上次 tick 时刻（启动时据此算关机期间错过的触发）。 */
  lastTickAt: z.string().optional(),
});
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

export function emptyScheduleState(): ScheduleState {
  return { version: SCHEDULE_STATE_VERSION, tasks: {} };
}

/** 在任务的 runs 尾部追加并维持 RUN_HISTORY_CAP 环形截断。直接 mutate。 */
export function pushRun(task: ScheduledTask, run: RunRecord): void {
  task.runs.push(run);
  if (task.runs.length > RUN_HISTORY_CAP) {
    task.runs.splice(0, task.runs.length - RUN_HISTORY_CAP);
  }
}
