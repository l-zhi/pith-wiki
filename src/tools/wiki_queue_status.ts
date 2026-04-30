import { z } from 'zod';
import { QueueStore } from '../wiki/queue/store.js';
import { formatStatusJson } from '../cli/queueCommands.js';
import { ensureQueueDirs } from '../config.js';
import type { ToolDef } from './index.js';

const params = z.object({});

export const wikiQueueStatusTool: ToolDef<typeof params> = {
  name: 'wiki_queue_status',
  description:
    'Read the current persistent ingest queue state. Returns counts (pending/running/completed/dead), running jobs, dead jobs, and the last 10 events.',
  parameters: params,
  handler: async (_args, ctx) => {
    ensureQueueDirs(ctx.config);
    const store = new QueueStore(ctx.config.queueStatePath);
    const state = store.load();
    return {
      ok: true,
      statePath: store.path,
      ...formatStatusJson(state),
    };
  },
};
