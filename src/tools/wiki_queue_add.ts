import path from 'node:path';
import { z } from 'zod';
import { resolveSafePath, SafetyError } from './safety.js';
import {
  deriveJobId,
  pushEvent,
  type QueueJob,
} from '../wiki/queue/state.js';
import { QueueStore } from '../wiki/queue/store.js';
import { ensureQueueDirs } from '../config.js';
import type { ToolDef } from './index.js';

const params = z.object({
  collection: z.string().describe('Wiki collection (folder name).'),
  files: z
    .array(z.string())
    .describe('Absolute file paths to enqueue. All must lie inside the read sandbox.'),
  force: z
    .boolean()
    .default(false)
    .describe('If true, re-enqueue already-completed files (resets attempts).'),
});

export const wikiQueueAddTool: ToolDef<typeof params> = {
  name: 'wiki_queue_add',
  description:
    'Enqueue one or more files for the persistent ingest queue. Returns the per-file enqueue outcome (added/reset/skipped). The actual hydration happens later when `llm-wiki queue run` is started.',
  parameters: params,
  handler: async (args, ctx) => {
    if (args.files.length === 0) {
      return { ok: false, error: 'files array is empty' };
    }

    const sandbox = {
      workspaceRoot: ctx.config.workspaceRoot,
      wikiRoot: ctx.config.wikiRoot,
      maxPayloadBytes: ctx.config.maxToolPayloadBytes,
      readOnly: ctx.config.readOnly,
      additionalReadPaths: ctx.config.additionalReadPaths,
    };

    const accepted: string[] = [];
    const outOfSandbox: string[] = [];
    for (const f of args.files) {
      const abs = path.resolve(f);
      try {
        resolveSafePath(abs, 'read', sandbox);
        accepted.push(abs);
      } catch (err) {
        if (err instanceof SafetyError) outOfSandbox.push(abs);
        else throw err;
      }
    }
    if (accepted.length === 0) {
      return {
        ok: false,
        error: 'no files passed sandbox check',
        outOfSandbox,
      };
    }

    ensureQueueDirs(ctx.config);
    const store = new QueueStore(ctx.config.queueStatePath);

    let added = 0;
    let reset = 0;
    let skipped = 0;
    const enqueuedIds: string[] = [];
    store.mutate((s) => {
      for (const file of accepted) {
        const id = deriveJobId(file, args.collection);
        const existing = s.jobs[id];
        if (!existing) {
          const job: QueueJob = {
            id,
            file,
            collection: args.collection,
            force: args.force,
            status: 'pending',
            attempts: 0,
            enqueuedAt: new Date().toISOString(),
          };
          s.jobs[id] = job;
          pushEvent(s, { ts: job.enqueuedAt, jobId: id, kind: 'enqueued' });
          enqueuedIds.push(id);
          added += 1;
          continue;
        }
        if (args.force) {
          existing.status = 'pending';
          existing.attempts = 0;
          existing.lastError = undefined;
          existing.startedAt = undefined;
          existing.completedAt = undefined;
          existing.finalEntryId = undefined;
          existing.nextEarliestRunAt = undefined;
          existing.force = true;
          pushEvent(s, {
            ts: new Date().toISOString(),
            jobId: id,
            kind: 'enqueued',
            msg: 're-enqueued via force=true',
          });
          enqueuedIds.push(id);
          reset += 1;
        } else {
          skipped += 1;
        }
      }
    });

    return {
      ok: true,
      collection: args.collection,
      added,
      reset,
      skipped,
      outOfSandbox,
      enqueuedIds,
      hint:
        'Run `llm-wiki queue run` (in a separate terminal or after this REPL session) to process the queue.',
    };
  },
};
