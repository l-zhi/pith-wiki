import { z } from 'zod';
import type { ToolDef } from './index.js';

const params = z.object({
  /** 限定 collection（不传 = 全部 collection）。 */
  collection: z.string().optional(),
  /** tag 包含过滤（OR 语义：命中任一即可）。 */
  tags: z.array(z.string()).optional(),
  /**
   * id / title 子串过滤（小写匹配）。
   * 用于关键词匹配失败但用户能描述大致主题的场景。
   */
  contains: z.string().optional(),
  /** 最多返回多少条；默认 50。库大时强烈建议加 collection / tags 过滤。 */
  limit: z.number().int().positive().max(500).default(50),
});

/**
 * wiki_list：把 LibraryService 的内存索引摆给模型看。
 *
 * 设计意图（与 wiki_query 互补）：
 *   - wiki_query 是"猜关键词"——猜不中就空。
 *   - wiki_list 是"翻菜单"——按 collection / tags 过滤后看 id+title+summary，
 *     模型能用语义理解从短摘要里挑候选，再调 wiki_get 拿全文 / wiki_read_source 看原文。
 *
 * 故意不返回 content：50 条 entry 全文会把 context 撑爆，且 summary 已经够选候选了。
 */
export const wikiListTool: ToolDef<typeof params> = {
  name: 'wiki_list',
  description:
    'Browse wiki entries by metadata (id/title/summary/tags/source) without their content. Use as fallback when wiki_query returns nothing — the model can scan summaries and pick candidates by hand, then call wiki_get / wiki_read_source for detail. Filters: collection, tags (OR), contains (id/title substring).',
  parameters: params,
  handler: async (args, ctx) => {
    const all = ctx.library.list(args.collection);
    const containsLower = args.contains?.toLowerCase();
    const tagSet = args.tags && args.tags.length > 0 ? new Set(args.tags) : null;

    const filtered = all.filter((e) => {
      if (containsLower) {
        const haystack = `${e.id}\n${e.title}\n${e.summary}`.toLowerCase();
        if (!haystack.includes(containsLower)) return false;
      }
      if (tagSet) {
        if (!e.tags.some((t) => tagSet.has(t))) return false;
      }
      return true;
    });

    // 按 updated 降序，最新的最先列出（用户更可能记得最近写的笔记）
    filtered.sort((a, b) => b.updated.localeCompare(a.updated));

    const trimmed = filtered.slice(0, args.limit);
    const items = trimmed.map((e) => ({
      id: e.id,
      title: e.title,
      collection: e.collection,
      summary: e.summary,
      tags: e.tags,
      links: e.links,
      source: {
        type: e.source.type,
        ...(e.source.value ? { value: e.source.value } : {}),
      },
      updated: e.updated,
    }));

    return {
      ok: true,
      total_matched: filtered.length,
      returned: items.length,
      truncated: filtered.length > items.length,
      items,
    };
  },
};
