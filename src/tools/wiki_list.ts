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
  /**
   * 按「入库日期」过滤（YYYY-MM-DD，含两端，比的是 ingestedAt 首次入库时刻的日期部分）。
   * 「某天新增到 pith 的」就用 added_after=added_before=该日。
   */
  added_after: z.string().optional(),
  added_before: z.string().optional(),
  /**
   * 按「内容自身日期」过滤（YYYY-MM-DD，含两端，比的是 entry.date）。无内容日期的条目不匹配。
   * 「整理内容日期是 D 的」用 date_after=date_before=D。
   */
  date_after: z.string().optional(),
  date_before: z.string().optional(),
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
    'Browse wiki entries by metadata (id/title/summary/tags/source) without their content. Use as fallback when wiki_query returns nothing — the model can scan summaries and pick candidates by hand, then call wiki_get / wiki_read_source for detail. ' +
    'Filters: collection, tags (OR), contains (id/title substring), and DATE RANGES (YYYY-MM-DD, inclusive): ' +
    "added_after/added_before filter by when the entry was first ADDED to pith (ingestedAt); date_after/date_before filter by the content's OWN date (entry.date). " +
    'For "what was added on day D" use added_after=added_before=D. NOTE: ingest/import time ≠ content date — a bulk import stamps everything with today\'s added date, so prefer date_* when you mean the content\'s own date.',
  parameters: params,
  handler: async (args, ctx) => {
    const all = ctx.library.list(args.collection);
    const containsLower = args.contains?.toLowerCase();
    const tagSet = args.tags && args.tags.length > 0 ? new Set(args.tags) : null;
    const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

    const filtered = all.filter((e) => {
      if (containsLower) {
        const haystack = `${e.id}\n${e.title}\n${e.summary}`.toLowerCase();
        if (!haystack.includes(containsLower)) return false;
      }
      if (tagSet) {
        if (!e.tags.some((t) => tagSet.has(t))) return false;
      }
      // 入库日期范围（含两端，按日期部分比）
      if (args.added_after || args.added_before) {
        const added = day(e.ingestedAt ?? e.updated);
        if (args.added_after && added < args.added_after) return false;
        if (args.added_before && added > args.added_before) return false;
      }
      // 内容自身日期范围（无内容日期的条目直接不匹配）
      if (args.date_after || args.date_before) {
        if (!e.date) return false;
        const d = day(e.date);
        if (args.date_after && d < args.date_after) return false;
        if (args.date_before && d > args.date_before) return false;
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
      ingestedAt: e.ingestedAt ?? e.updated, // 入库时间（首次进库，稳定）
      ...(e.date ? { date: e.date } : {}), // 内容自身日期（若有）
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
