import fs from 'node:fs';
import path from 'node:path';
import { readState, writeStateAtomic, type QueueState } from './state.js';

/**
 * QueueStore：封装"加载 → 修改 → 原子写回"的常用模式，外加 lockfile。
 *
 * 并发模型：
 *   - `queue run` 进程持锁（acquireLock）。同一时刻只允许一个 worker。
 *   - 其他命令（add / status / clear / retry）不取锁，直接 mutate；mutate 串行
 *     完成 read → fn → atomic write。
 *   - worker 自己的状态写入也走 mutate；外部命令与 worker 同时 mutate 时，
 *     最坏丢掉一条 events 记录，job 状态字段实际不并发（add 只新增 key、外部命令
 *     只动非 running 状态、worker 只动当前 running）。
 *
 * 锁文件格式：JSON `{ pid, ts }`。第二个 worker 起来时若 lock 存在，先做
 * `process.kill(pid, 0)` 探测进程存活——挂了 → 视为陈旧 lock 接管，活着 → 报错。
 */
export class StaleLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleLockError';
  }
}

export class QueueLockedError extends Error {
  constructor(public readonly lockingPid: number) {
    super(`queue is already running (pid=${lockingPid})`);
    this.name = 'QueueLockedError';
  }
}

export class QueueStore {
  constructor(private readonly statePath: string) {}

  get path(): string {
    return this.statePath;
  }

  load(): QueueState {
    return readState(this.statePath);
  }

  /**
   * 加载 → 应用 fn 修改 → 原子写回。
   * fn 可以同步 mutate 入参，也可以返回新的 state（虽然推荐 mutate）。
   */
  mutate(fn: (state: QueueState) => QueueState | void): QueueState {
    const current = this.load();
    const next = fn(current) ?? current;
    writeStateAtomic(this.statePath, next);
    return next;
  }

  /**
   * 取队列锁。返回一个释放函数（必须放进调用方的 finally）。
   *
   * 行为：
   *   1. 如果 lock 文件不存在 → 写入 `{pid,ts}`，返回 release。
   *   2. 如果存在但 owner 进程已死 → 视作陈旧 lock，覆盖。
   *   3. 如果存在且 owner 仍在运行 → 抛 QueueLockedError。
   *
   * 使用 `wx` flag 提供原子创建语义，不会两个进程同时认为自己拿到了锁。
   */
  acquireLock(): () => void {
    const lockPath = `${this.statePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // 在尝试创建之前先看一眼，处理陈旧 lock。
    if (fs.existsSync(lockPath)) {
      const existing = readLockFile(lockPath);
      if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        throw new QueueLockedError(existing.pid);
      }
      // 陈旧（pid 不存在 或 pid==self 但 lock 残留）→ 覆盖。
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        // 极端竞态：另一个进程刚刚也走到这里抢锁了，让 wx 把这种情况报出来。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = readLockFile(lockPath);
        throw new QueueLockedError(existing?.pid ?? -1);
      }
      throw err;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }

    return () => {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        // 释放阶段失败的可见性比正确性重要：吞掉 ENOENT 即可。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    };
  }
}

function readLockFile(lockPath: string): { pid: number; ts: string } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === 'number' && typeof parsed?.ts === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
