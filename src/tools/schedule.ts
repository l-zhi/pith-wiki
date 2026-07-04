import { z } from 'zod';
import type { ToolDef, ToolContext } from './index.js';
import { isValidCron } from '../schedule/cron.js';
import type { ScheduleSpec, ScheduledTask } from '../schedule/types.js';

/**
 * 定时任务的 agent 工具：schedule_add / list / update / delete / status。
 *
 * 注意:schedule 是 once|cron 的判别联合,但手搓的 zodToJsonSchema 不认 union
 * （会降级成 {}）。所以这里把 schedule **摊平**成 kind/at/cron/tz 几个
 * string/enum/boolean 参数(全部 converter-safe),在 handler 里重新组装成
 * ScheduleSpec。详见 CLAUDE.md 里 zodToJsonSchema 的约束说明。
 *
 * 这组工具只在桌面 engine（有 ScheduleService 宿主）挂载;ctx.scheduleService
 * 缺失时直接返回错误(REPL/CLI 没有触发宿主)。
 */

const systemTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

function requireService(ctx: ToolContext) {
  if (!ctx.scheduleService) {
    return null;
  }
  return ctx.scheduleService;
}

const NO_HOST = {
  ok: false as const,
  error: 'Scheduled tasks are only available in the desktop app (no scheduler host here).',
};

/** 把摊平参数组装成 ScheduleSpec；返回 {spec} 或 {error}。 */
function buildSpec(
  kind: 'once' | 'cron',
  at: string | undefined,
  cron: string | undefined,
  tz: string | undefined,
): { spec: ScheduleSpec } | { error: string } {
  if (kind === 'once') {
    if (!at)
      return { error: 'kind="once" requires `at` (an ISO datetime, e.g. 2026-06-20T09:00:00).' };
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) return { error: `invalid datetime: "${at}"` };
    return { spec: { kind: 'once', at: t.toISOString() } };
  }
  if (!cron)
    return { error: 'kind="cron" requires `cron` (a 5-field expression, e.g. "0 9 * * 1").' };
  if (!isValidCron(cron)) return { error: `invalid 5-field cron expression: "${cron}"` };
  return { spec: { kind: 'cron', expr: cron, tz: tz || systemTz() } };
}

function taskView(ctx: ToolContext, task: ScheduledTask) {
  const next = ctx.scheduleService?.nextFire(task) ?? null;
  const last = task.runs[task.runs.length - 1];
  return {
    id: task.id,
    title: task.title ?? task.input.split('\n')[0].slice(0, 48),
    input: task.input,
    schedule: task.schedule,
    enabled: task.enabled,
    catchUp: task.catchUp,
    requireApproval: task.requireApproval,
    review: task.review,
    nextFire: next ? next.toISOString() : null,
    lastRun: last ? { firedAt: last.firedAt, status: last.status, error: last.error } : null,
    runCount: task.runs.length,
  };
}

const addParams = z.object({
  input: z
    .string()
    .describe(
      'The agent input to run when fired — a prompt, or a `/skill …` command. ' +
        'For relative dates use placeholders (resolved at fire time to the run date) instead of words like "yesterday": ' +
        '${yyyy-mm-dd} = today, ${yyyy-mm-dd -1} = yesterday (offset +/-N, unit d/w/m/y). ' +
        'E.g. "Summarize notes added on ${yyyy-mm-dd -1}, save as ${yyyy-mm-dd -1}-digest".',
    ),
  kind: z
    .enum(['once', 'cron'])
    .describe('once = run a single time at `at`; cron = recurring on `cron` schedule.'),
  at: z
    .string()
    .optional()
    .describe('For kind="once": ISO datetime to fire at (e.g. 2026-06-20T09:00:00).'),
  cron: z
    .string()
    .optional()
    .describe(
      'For kind="cron": 5-field cron expression (min hour dom month dow), e.g. "0 9 * * 1" = Mondays 09:00.',
    ),
  tz: z.string().optional().describe('IANA timezone for cron (default: system timezone).'),
  title: z
    .string()
    .optional()
    .describe('Human-readable name (defaults to the first line of input).'),
  enabled: z
    .boolean()
    .default(true)
    .describe('Whether the task is active (false = paused, never fires).'),
  catch_up: z
    .boolean()
    .default(true)
    .describe(
      'If the app was closed over a fire time: true = run once on next launch; false = skip missed fires.',
    ),
  require_approval: z
    .boolean()
    .default(false)
    .describe(
      'false (default) = auto-approve tool calls (writes/commands) so the task runs unattended. true = require human approval at fire time (only completes if someone approves, else times out).',
    ),
  review: z
    .boolean()
    .default(false)
    .describe(
      'false (default) = normal single-pass output. true = run in review mode: the output is checked by a reviewer and bounced back for a rewrite if it falls short (slower, more tokens). Good for writing tasks like daily reports.',
    ),
});

const scheduleAddTool: ToolDef<typeof addParams> = {
  name: 'schedule_add',
  description:
    'Create a scheduled task that runs an agent input on a schedule (once at a datetime, or recurring via cron). ' +
    'The input runs in a fresh chat session each time it fires; to save output to the wiki, include that instruction in the input (the task can call wiki_ingest itself).',
  parameters: addParams,
  handler: async (a, ctx) => {
    const svc = requireService(ctx);
    if (!svc) return NO_HOST;
    const built = buildSpec(a.kind, a.at, a.cron, a.tz);
    if ('error' in built) return { ok: false, error: built.error };
    const task = svc.create({
      input: a.input,
      schedule: built.spec,
      title: a.title,
      enabled: a.enabled,
      catchUp: a.catch_up,
      requireApproval: a.require_approval,
      review: a.review,
    });
    return { ok: true, task: taskView(ctx, task) };
  },
};

const listParams = z.object({
  include_disabled: z.boolean().default(true).describe('Include paused (disabled) tasks.'),
});

const scheduleListTool: ToolDef<typeof listParams> = {
  name: 'schedule_list',
  description:
    'List scheduled tasks with their schedule, enabled state, next fire time, and last run status.',
  parameters: listParams,
  handler: async (a, ctx) => {
    const svc = requireService(ctx);
    if (!svc) return NO_HOST;
    const tasks = svc.list().filter((t) => a.include_disabled || t.enabled);
    return { ok: true, count: tasks.length, tasks: tasks.map((t) => taskView(ctx, t)) };
  },
};

const updateParams = z.object({
  id: z.string().describe('Task id to update.'),
  input: z.string().optional().describe('New agent input.'),
  title: z.string().optional().describe('New title.'),
  kind: z
    .enum(['once', 'cron'])
    .optional()
    .describe('Change schedule kind (requires the matching at/cron field).'),
  at: z.string().optional().describe('New ISO datetime (when kind="once").'),
  cron: z.string().optional().describe('New 5-field cron expression (when kind="cron").'),
  tz: z.string().optional().describe('New timezone for cron.'),
  enabled: z.boolean().optional().describe('Enable (true) or pause (false) the task.'),
  catch_up: z.boolean().optional().describe('Change the missed-fire catch-up behavior.'),
  require_approval: z
    .boolean()
    .optional()
    .describe('Change whether tool calls need human approval at fire time.'),
  review: z
    .boolean()
    .optional()
    .describe('Change whether the task runs in review mode (output reviewed + revised before finalizing).'),
});

const scheduleUpdateTool: ToolDef<typeof updateParams> = {
  name: 'schedule_update',
  description:
    'Update a scheduled task. Changing the schedule (kind/at/cron) resets its fire baseline. Omit fields to leave them unchanged.',
  parameters: updateParams,
  handler: async (a, ctx) => {
    const svc = requireService(ctx);
    if (!svc) return NO_HOST;
    const existing = svc.get(a.id);
    if (!existing) return { ok: false, error: `task not found: ${a.id}` };
    const patch: Parameters<typeof svc.update>[1] = {};
    if (a.input !== undefined) patch.input = a.input;
    if (a.title !== undefined) patch.title = a.title;
    if (a.enabled !== undefined) patch.enabled = a.enabled;
    if (a.catch_up !== undefined) patch.catchUp = a.catch_up;
    if (a.require_approval !== undefined) patch.requireApproval = a.require_approval;
    if (a.review !== undefined) patch.review = a.review;
    if (a.kind !== undefined) {
      const built = buildSpec(a.kind, a.at, a.cron, a.tz);
      if ('error' in built) return { ok: false, error: built.error };
      patch.schedule = built.spec;
    }
    try {
      const task = svc.update(a.id, patch);
      return { ok: true, task: taskView(ctx, task) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

const idParams = z.object({ id: z.string().describe('Task id.') });

const scheduleDeleteTool: ToolDef<typeof idParams> = {
  name: 'schedule_delete',
  description: 'Delete a scheduled task permanently.',
  parameters: idParams,
  handler: async (a, ctx) => {
    const svc = requireService(ctx);
    if (!svc) return NO_HOST;
    const existed = svc.delete(a.id);
    return existed ? { ok: true, deleted: a.id } : { ok: false, error: `task not found: ${a.id}` };
  },
};

const statusParams = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'A specific task id to show full run history for; omit for an overview of all tasks.',
    ),
});

const scheduleStatusTool: ToolDef<typeof statusParams> = {
  name: 'schedule_status',
  description:
    "Inspect scheduled-task run status: one task's full run history (with `id`), or an overview of all tasks and their recent runs.",
  parameters: statusParams,
  handler: async (a, ctx) => {
    const svc = requireService(ctx);
    if (!svc) return NO_HOST;
    if (a.id) {
      const task = svc.get(a.id);
      if (!task) return { ok: false, error: `task not found: ${a.id}` };
      return { ok: true, task: taskView(ctx, task), runs: task.runs };
    }
    const tasks = svc.list();
    const recent = tasks
      .flatMap((t) => t.runs.map((r) => ({ taskId: t.id, ...r })))
      .sort((x, y) => (x.firedAt < y.firedAt ? 1 : -1))
      .slice(0, 20);
    return {
      ok: true,
      total: tasks.length,
      enabled: tasks.filter((t) => t.enabled).length,
      recentRuns: recent,
    };
  },
};

export const scheduleTools: ToolDef<z.ZodTypeAny>[] = [
  scheduleAddTool,
  scheduleListTool,
  scheduleUpdateTool,
  scheduleDeleteTool,
  scheduleStatusTool,
] as unknown as ToolDef<z.ZodTypeAny>[];
