import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  collection: z.string().describe('Wiki collection (folder name).'),
  raw_content: z.string().describe('The raw text/markdown to compress into a wiki entry.'),
  source_type: z.enum(['url', 'file', 'inline', 'unknown']).default('inline'),
  source_value: z.string().optional().describe('URL or file path the content came from.'),
  date: z
    .string()
    .optional()
    .describe(
      "The content's OWN date (YYYY-MM-DD) if known — e.g. a Feishu doc's modified date, a WeChat-reading note date, an article's publish date. NOT today. Used so date-scoped digests (\"summarize what was added on D\") can match by content date, not import time.",
    ),
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
    // 显式传入的内容日期优先于水合抽取的（调用方比 LLM 更确定数据源日期）。
    const saved = ctx.library.put(args.date ? { ...entry, date: args.date } : entry);
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
