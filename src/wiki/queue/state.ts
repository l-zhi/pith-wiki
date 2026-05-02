import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * 持久化队列的 schema、序列化和原子 IO。
 *
 * 设计要点：
 *   - 整个队列状态存为一个 JSON 文件（默认 ~/.llm-wiki/queue/state.json）。
 *     体量不大（~10k jobs ~几 MB）的场景下，整文件原子写法（`.tmp + rename`）
 *     比 SQLite 之类简单太多，且与 LibraryService.put 同源。
 *   - jobId 是稳定确定性 hash（path + collection），让 `queue add` 天然幂等。
 *   - events 是定长环形缓冲，避免 state.json 无界增长。
 */

export const QUEUE_STATE_VERSION = 1 as const;
const EVENT_RING_CAP = 200;

export const JobStatusSchema = z.enum(['pending', 'running', 'completed', 'dead']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const QueueJobSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  collection: z.string().min(1),
  force: z.boolean(),
  status: JobStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().optional(),
  enqueuedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  finalEntryId: z.string().optional(),
  /** ISO 时间戳：在此之前不允许被 worker 拉起。退避闸门。 */
  nextEarliestRunAt: z.string().optional(),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const QueueEventKindSchema = z.enum([
  'enqueued',
  'started',
  'ok',
  'retry',
  'dead',
  'reset',
  'cancelled',
  'skipped',
]);
export type QueueEventKind = z.infer<typeof QueueEventKindSchema>;

export const QueueEventSchema = z.object({
  ts: z.string(),
  jobId: z.string(),
  kind: QueueEventKindSchema,
  msg: z.string().optional(),
});
export type QueueEvent = z.infer<typeof QueueEventSchema>;

export const QueueStateSchema = z.object({
  version: z.literal(QUEUE_STATE_VERSION),
  jobs: z.record(z.string(), QueueJobSchema),
  events: z.array(QueueEventSchema),
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export function emptyState(): QueueState {
  return { version: QUEUE_STATE_VERSION, jobs: {}, events: [] };
}

/**
 * 从 (绝对路径, collection) 派生稳定 jobId。
 *
 * 用 sha1 前 12 hex（~48 bit）：实际队列规模下碰撞概率可忽略，
 * 而且短，方便 CLI 输出和文件名。
 */
export function deriveJobId(absFile: string, collection: string): string {
  const h = crypto.createHash('sha1');
  h.update(absFile);
  h.update('|');
  h.update(collection);
  return h.digest('hex').slice(0, 12);
}

/**
 * 在 events 数组尾部追加，并维持 EVENT_RING_CAP 环形截断。
 * 直接 mutate 入参（与 store.mutate 的语义一致）。
 */
export function pushEvent(state: QueueState, event: QueueEvent): void {
  state.events.push(event);
  if (state.events.length > EVENT_RING_CAP) {
    state.events.splice(0, state.events.length - EVENT_RING_CAP);
  }
}

export function readState(filePath: string): QueueState {
  if (!fs.existsSync(filePath)) return emptyState();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`failed to read queue state at ${filePath}: ${(err as Error).message}`);
  }
  if (!raw.trim()) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`queue state file is not valid JSON (${filePath}): ${(err as Error).message}`);
  }
  // 版本不匹配时直接报错，让用户决定怎么处理（手动迁移或删档重来）。
  return QueueStateSchema.parse(parsed);
}

/**
 * 原子写：先写到 `<file>.tmp`，再 rename 到目标路径。
 * 仿 LibraryService.put 的同款做法；rename 在同 fs 上是原子的。
 */
export function writeStateAtomic(filePath: string, state: QueueState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function countByStatus(
  state: QueueState,
): Record<'pending' | 'running' | 'completed' | 'dead', number> {
  const counts = { pending: 0, running: 0, completed: 0, dead: 0 };
  for (const j of Object.values(state.jobs)) counts[j.status] += 1;
  return counts;
}

export interface StatusJson {
  counts: ReturnType<typeof countByStatus>;
  running: QueueJob[];
  dead: QueueJob[];
  recentEvents: QueueState['events'];
  statePath?: string;
}

export function formatStatusJson(state: QueueState): StatusJson {
  return {
    counts: countByStatus(state),
    running: Object.values(state.jobs).filter((j) => j.status === 'running'),
    dead: Object.values(state.jobs).filter((j) => j.status === 'dead'),
    recentEvents: state.events.slice(-10),
  };
}
