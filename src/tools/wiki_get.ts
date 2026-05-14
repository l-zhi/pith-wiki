import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  id: z.string().describe('The wiki entry id (kebab-case ASCII or CJK characters).'),
  collection: z.string().optional(),
});

export const wikiGetTool: ToolDef<typeof params> = {
  name: 'wiki_get',
  description: 'Fetch a wiki entry by id. Returns frontmatter + Markdown body.',
  parameters: params,
  handler: async (args, ctx) => {
    const entry = ctx.library.get(args.id, args.collection);
    if (!entry) return { ok: false, error: `Entry not found: ${args.id}` };
    const backlinks = ctx.library.linkIndex().get(entry.id)?.backward ?? [];
    return { ok: true, entry, backlinks };
  },
};
