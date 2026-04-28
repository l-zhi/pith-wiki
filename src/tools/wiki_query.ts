import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  query: z.string().describe('Natural-language question to find related entries for.'),
  max_tokens: z.number().int().positive().default(4000),
});

export const wikiQueryTool: ToolDef<typeof params> = {
  name: 'wiki_query',
  description:
    'Assemble a Markdown context block from related wiki entries (keyword score + 1-hop link expansion).',
  parameters: params,
  handler: async (args, ctx) => {
    const result = ctx.assembler.query(args.query, args.max_tokens);
    return {
      ok: true,
      context: result.context,
      referenced_entries: result.referencedEntries,
    };
  },
};
