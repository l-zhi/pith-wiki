import type { QueueStore } from '../wiki/queue/store.js';
import { pushEvent, type QueueJob, type QueueState } from '../wiki/queue/state.js';

/**
 * REPL `/queue` slash 命令的后端：纯函数 + 在已有 `QueueStore` 上 mutate。
 *
 * 与 CLI `queue` 子命令同源（src/cli/queueCommands.ts），但只暴露 REPL 里有用的几个
 * 动作（list / retry / clear），不重复 add / run / watch（那些是进程级动作）。
 *
 * 并发：QueueStore 的注释保证 worker 与外部 mutate 并发只会丢一条 event，
 * job 状态字段不并发（worker 只动 running，retry/clear 只动 dead），dead 的处理是安全的。
 */

/**
 * 把 lastError / tool 结果压成单行短串，避免 dashboard 列表、status bar 或对话流被
 * 多行堆栈撑爆。统一导出（同 80 字符上限）供 StatusBar 的 dead 提示与 App.tsx 的
 * tool round 渲染复用，避免一会儿截 80 一会儿 120 的视觉抖动。
 */
export function shortError(msg: string | undefined, max = 80): string {
  if (!msg) return '?';
  const oneLine = msg.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

/** dead 列表 → 多行文本，给 system message 直接显示。 */
export function formatDeadList(state: QueueState): string {
  const dead = Object.values(state.jobs).filter((j) => j.status === 'dead');
  if (dead.length === 0) {
    return 'No dead jobs.';
  }
  const lines: string[] = [`${dead.length} dead job(s):`, ''];
  for (const j of dead) {
    lines.push(
      `  ${j.id}  ${j.collection}/${shortFile(j.file)}  ` +
        `attempts=${j.attempts}  err: ${shortError(j.lastError)}`,
    );
  }
  lines.push(
    '',
    'Actions:',
    '  /queue retry <id>       reset one dead job → pending',
    '  /queue retry-all        reset all dead → pending',
    '  /queue clear-dead       delete all dead from state',
    '  /queue status           full counts + recent events',
    '  log:  ~/.pith-wiki/queue/logs/<id>.log',
  );
  return lines.join('\n');
}

/** 完整 status 摘要：计数 + 最近 10 条 events。 */
export function formatQueueStatus(state: QueueState): string {
  const counts = { pending: 0, running: 0, completed: 0, dead: 0 };
  for (const j of Object.values(state.jobs)) counts[j.status] += 1;
  const lines: string[] = [
    `pending: ${counts.pending}  running: ${counts.running}  ` +
      `completed: ${counts.completed}  dead: ${counts.dead}`,
  ];
  const running = Object.values(state.jobs).filter((j) => j.status === 'running');
  if (running.length) {
    lines.push('', 'running:');
    for (const j of running) {
      lines.push(`  ${j.id}  ${j.collection}/${shortFile(j.file)}  attempts=${j.attempts}`);
    }
  }
  const recent = state.events.slice(-10);
  if (recent.length) {
    lines.push('', 'recent events:');
    for (const ev of recent) {
      lines.push(`  ${ev.ts}  ${ev.kind.padEnd(9)}  ${ev.jobId}${ev.msg ? ` — ${ev.msg}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 重置 dead → pending。ids 为空 → 全部 dead；否则只动列出的（不存在 / 状态不对忽略）。 */
export function resetDead(
  store: QueueStore,
  ids?: string[],
): { reset: number; skipped: string[]; notFound: string[] } {
  const skipped: string[] = [];
  const notFound: string[] = [];
  let reset = 0;
  const idSet = ids && ids.length > 0 ? new Set(ids) : null;
  store.mutate((state) => {
    const targets: QueueJob[] = [];
    if (idSet) {
      for (const id of idSet) {
        const j = state.jobs[id];
        if (!j) {
          notFound.push(id);
        } else if (j.status !== 'dead') {
          skipped.push(`${id} (status=${j.status})`);
        } else {
          targets.push(j);
        }
      }
    } else {
      for (const j of Object.values(state.jobs)) {
        if (j.status === 'dead') targets.push(j);
      }
    }
    for (const j of targets) {
      j.status = 'pending';
      j.attempts = 0;
      delete j.lastError;
      delete j.startedAt;
      delete j.nextEarliestRunAt;
      pushEvent(state, { ts: new Date().toISOString(), jobId: j.id, kind: 'reset' });
      reset += 1;
    }
  });
  return { reset, skipped, notFound };
}

/** 删 dead 记录（彻底丢弃，不会被 worker 再拉起）。 */
export function clearDead(store: QueueStore): { removed: number } {
  let removed = 0;
  store.mutate((state) => {
    for (const id of Object.keys(state.jobs)) {
      if (state.jobs[id].status === 'dead') {
        delete state.jobs[id];
        removed += 1;
      }
    }
  });
  return { removed };
}

/** 长路径压成 `…/last-2-dirs/file.ext`，让一行能放下。 */
function shortFile(file: string, keepSegments = 2): string {
  const parts = file.split('/');
  if (parts.length <= keepSegments + 1) return file;
  return '…/' + parts.slice(-keepSegments - 1).join('/');
}
