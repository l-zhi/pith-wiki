import fs from 'node:fs';
import path from 'node:path';
import { emptyScheduleState, ScheduleStateSchema, type ScheduleState } from './types.js';

/**
 * ScheduleStore —— 「加载 → mutate → 原子写回」，与 QueueStore 同构但**不带
 * lockfile**：v1 唯一写者是桌面 engine 单进程（tick 触发与 schedule_* 工具都
 * 跑在同一事件循环里）。mutate 是同步的（read 与 write 之间无 await），所以
 * 单进程内天然串行、无需跨进程锁。后续若加 CLI `schedule run` 守护，再补 lock。
 */
export class ScheduleStore {
  constructor(private readonly statePath: string) {}

  get path(): string {
    return this.statePath;
  }

  load(): ScheduleState {
    return readScheduleState(this.statePath);
  }

  /** 加载 → 应用 fn（可 mutate 入参或返回新 state）→ 原子写回。返回写回后的 state。 */
  mutate(fn: (state: ScheduleState) => ScheduleState | void): ScheduleState {
    const current = this.load();
    const next = fn(current) ?? current;
    writeScheduleStateAtomic(this.statePath, next);
    return next;
  }
}

export function readScheduleState(filePath: string): ScheduleState {
  if (!fs.existsSync(filePath)) return emptyScheduleState();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`failed to read schedule state at ${filePath}: ${(err as Error).message}`);
  }
  if (!raw.trim()) return emptyScheduleState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `schedule state file is not valid JSON (${filePath}): ${(err as Error).message}`,
    );
  }
  return ScheduleStateSchema.parse(parsed);
}

/** 原子写：`<file>.tmp` → rename。仿 LibraryService.put / QueueStore。 */
export function writeScheduleStateAtomic(filePath: string, state: ScheduleState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
