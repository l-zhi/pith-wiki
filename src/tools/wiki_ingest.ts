import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  collection: z.string().describe('Wiki collection (folder name).'),
  raw_content: z.string().describe('The raw text/markdown to compress into a wiki entry.'),
  source_type: z.enum(['url', 'file', 'inline', 'unknown']).default('inline'),
  source_value: z.string().optional().describe('URL or file path the content came from.'),
  auto_link: z.boolean().default(true),
});

export const wikiIngestTool: ToolDef<typeof params> = {
  name: 'wiki_ingest',
  description:
    'Hydrate raw text into a compressed wiki Entry and persist it. Returns the new Entry id and metadata.',
  parameters: params,
  handler: async (args, ctx) => {
    const entry = await ctx.hydrator.hydrate({
      rawContent: args.raw_content,
      collectionId: args.collection,
      autoLink: args.auto_link,
      source: { type: args.source_type, value: args.source_value },
    });
    const saved = ctx.library.put(entry);
    return {
      ok: true,
      id: saved.id,
      collection: saved.collection,
      title: saved.title,
      summary: saved.summary,
      tags: saved.tags,
      links: saved.links,
      compressionRatio: saved.compressionRatio,
    };
  },
};
