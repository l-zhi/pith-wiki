import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  query: z.string().describe('Natural-language question to find related entries for.'),
  max_tokens: z.number().int().positive().default(4000),
});

export const wikiQueryTool: ToolDef<typeof params> = {
  name: 'wiki_query',
  description:
    'Search the wiki for entries related to a question. Returns a Markdown context block (compressed digests, ~30-50% of source) plus per-entry source paths so you can decide whether to read the originals via wiki_read_source / read_file. Uses keyword scoring with bigram support for Chinese; expands 1-hop forward links from top seeds.',
  parameters: params,
  handler: async (args, ctx) => {
    // ctx.scope 来自本轮 `@`-mention（Agent 注入）；有则收窄召回，无则整库。
    const result = ctx.assembler.query(args.query, args.max_tokens, ctx.scope);
    return {
      ok: true,
      context: result.context,
      // 兼容字段：旧调用方 / 用户调试时只想要 id 列表
      referenced_entries: result.referencedEntries,
      // 新字段：每个 entry 的 title / collection / source。模型据此判断是否读原文
      references: result.references,
      // 检索元信息：让模型知道为什么没结果（"是不是该换 wiki_list 浏览？"）
      total_entries_in_library: ctx.library.list().length,
    };
  },
};
