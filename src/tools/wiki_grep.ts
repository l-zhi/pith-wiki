import fs from 'node:fs';
import { z } from 'zod';
import { resolveSafePath, truncatePayload } from './safety.js';
import type { ToolContext, ToolDef } from './index.js';
import type { Entry } from '../wiki/types.js';

const params = z.object({
  /**
   * 要查找的字面串 / 正则数组。pattern 之间是 **OR** 语义：一条命中即算该行命中。
   *
   * 对"同一内容有多种写法"的固定值（日期、标识符、缩写），请把所有可能的写法
   * 一次性列进来，让一次调用扫完——不要分多轮 grep。例如要找 2026-06-04，
   * 传 ["2026-06-04", "2026/06/04", "06/04/2026", "2026年6月4日", "June 4"]，
   * 或用 regex:true 传一条覆盖式正则。
   */
  patterns: z.array(z.string()).describe('Literal substrings (OR). List all surface forms of fixed values like dates/IDs.'),
  /** true → 把每个 pattern 当正则编译；false（默认）→ 当字面子串。编译失败的正则会整体报错。 */
  regex: z.boolean().default(false),
  /** 大小写不敏感（默认 true）。 */
  ignore_case: z.boolean().default(true),
  /** 限定 collection（不传 = 全库）。 */
  collection: z.string().optional(),
  /** 每条 entry 最多回多少命中行；默认 5。 */
  max_matches_per_entry: z.number().int().positive().max(50).default(5),
  /** 最多回多少条命中的 entry；默认 50。 */
  max_entries: z.number().int().positive().max(200).default(50),
});

/** 单个 pattern 编译成一个 (text) => boolean 测试器。literal 走 includes，regex 走 RegExp。 */
type Matcher = { pattern: string; test: (text: string) => boolean };

function buildMatchers(
  patterns: string[],
  regex: boolean,
  ignoreCase: boolean,
): { matchers: Matcher[]; error?: string } {
  const matchers: Matcher[] = [];
  for (const p of patterns) {
    if (regex) {
      let re: RegExp;
      try {
        re = new RegExp(p, ignoreCase ? 'i' : '');
      } catch (err) {
        return { matchers: [], error: `Invalid regex ${JSON.stringify(p)}: ${(err as Error).message}` };
      }
      matchers.push({ pattern: p, test: (text) => re.test(text) });
    } else {
      const needle = ignoreCase ? p.toLowerCase() : p;
      matchers.push({
        pattern: p,
        test: (text) => (ignoreCase ? text.toLowerCase() : text).includes(needle),
      });
    }
  }
  return { matchers };
}

/** 第一个命中该行的 pattern；都不中返回 null。 */
function firstHit(text: string, matchers: Matcher[]): string | null {
  for (const m of matchers) {
    if (m.test(text)) return m.pattern;
  }
  return null;
}

const MAX_LINE_CHARS = 300;

type BodyField = 'content' | 'source';

interface GrepMatch {
  /** body（content / source）命中的 1-based 行号；title/summary/tags 元数据命中为 null。 */
  line: number | null;
  field: BodyField | 'title' | 'summary' | 'tags';
  text: string;
  pattern: string;
}

/**
 * 决定一条 entry 的"正文"从哪取：
 *   - source.type==='file' 且能读到原文 → 读 `cachePath ?? value`（markdown 笔记落 value，
 *     PDF/EML/HTML 落 cachePath 的 sidecar），field='source'，行号是原文行号。
 *   - 否则（url/inline、二进制无 sidecar、越界沙箱、缺失、读失败）→ 回退内存压缩 content，
 *     field='content'（保证不回退功能）。
 */
function resolveBody(
  entry: Entry,
  ctx: ToolContext,
): { text: string; field: BodyField; sourcePath?: string } {
  const fallback = { text: entry.content, field: 'content' as const };
  if (entry.source.type !== 'file') return fallback;

  const readPath = entry.source.cachePath ?? entry.source.value;
  if (!readPath) return fallback;
  // sidecar 一定是转换后的 .md（文本）；没有 sidecar 时只接受文本扩展名，避免 grep 二进制原文
  const isText = !!entry.source.cachePath || /\.(md|markdown|txt)$/i.test(readPath);
  if (!isText) return fallback;

  try {
    const safe = resolveSafePath(readPath, 'read', {
      workspaceRoot: ctx.config.workspaceRoot,
      wikiRoot: ctx.config.wikiRoot,
      maxPayloadBytes: ctx.config.maxToolPayloadBytes,
      readOnly: ctx.config.readOnly,
      additionalReadPaths: ctx.config.additionalReadPaths,
    });
    if (!fs.existsSync(safe) || fs.statSync(safe).isDirectory()) return fallback;
    const raw = truncatePayload(fs.readFileSync(safe, 'utf8'), ctx.config.maxToolPayloadBytes);
    return { text: raw, field: 'source', sourcePath: readPath };
  } catch {
    // 越界沙箱 / 读失败 → 回退 content，不让单条坏 source 影响整次 grep
    return fallback;
  }
}

function grepEntry(
  entry: Entry,
  body: { text: string; field: BodyField },
  matchers: Matcher[],
  maxPerEntry: number,
): GrepMatch[] {
  const hits: GrepMatch[] = [];

  // 元数据字段：始终在内存里搜（便宜、权威），整体作为单行匹配（无行号）。
  const meta: Array<{ field: GrepMatch['field']; text: string }> = [
    { field: 'title', text: entry.title },
    { field: 'summary', text: entry.summary },
    { field: 'tags', text: entry.tags.join(' ') },
  ];
  for (const { field, text } of meta) {
    if (!text) continue;
    const pattern = firstHit(text, matchers);
    if (pattern) {
      hits.push({ line: null, field, text: text.slice(0, MAX_LINE_CHARS), pattern });
      if (hits.length >= maxPerEntry) return hits;
    }
  }

  // 正文（原文 source 或回退的压缩 content）：逐行扫，带 1-based 行号。
  const lines = body.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const pattern = firstHit(lines[i], matchers);
    if (pattern) {
      hits.push({ line: i + 1, field: body.field, text: lines[i].slice(0, MAX_LINE_CHARS), pattern });
      if (hits.length >= maxPerEntry) break;
    }
  }
  return hits;
}

/**
 * wiki_grep：在条目**原文** + 元数据里做精确子串 / 正则查找，返回命中位置（id + 行号）。
 *
 * 默认搜原文（`source.cachePath ?? source.value`）而非内存里的压缩摘要——hydrate 常把原文
 * 压到 <10%，精确搜压缩体会大量假阴性。markdown 笔记落到原始 .md，PDF/EML/HTML 落到 .cache
 * 里转换出的 .md sidecar。读不到原文的条目（url/inline、二进制无 sidecar、越界沙箱、缺失）
 * 自动回退搜内存 content。每条结果用 `searched` 标明命中的是 'source' 还是 'content'。
 *
 * 与 wiki_query 的分工：query 是 bigram 打分 + 压缩摘要（模糊定向）；grep 是零容错精确匹配
 * （确切标识符 / 原话 / URL / 全量普查）。命中给 id + 行号，模型可据此 wiki_read_source 下钻。
 */
export const wikiGrepTool: ToolDef<typeof params> = {
  name: 'wiki_grep',
  description:
    'Exact substring/regex search across wiki entries — by DEFAULT over each entry\'s ORIGINAL source text (the raw .md, or the converted .md sidecar for PDF/EML/HTML), plus title/summary/tags. This finds verbatim words even when hydration compressed them out of the digest. Falls back to the in-memory compressed body when an entry has no readable file source (url/inline/binary). Use this — NOT wiki_query — when you have an exact literal to find (an identifier like `json_object`, a verbatim phrase, a URL, an error string), or need EVERY entry mentioning something (a census). patterns is OR-combined: for fixed values with multiple surface forms (dates, IDs) list ALL forms in one call (e.g. ["2026-06-04","2026/06/04","2026年6月4日"]) or pass one covering regex with regex:true. Returns matched ids + 1-based line numbers; each item\'s `searched` says whether the original source or the compressed content was matched. Note: only entries already in the index are searched; files that failed to ingest are not visible here.',
  parameters: params,
  handler: async (args, ctx) => {
    if (args.patterns.length === 0) {
      return { ok: false, error: 'patterns is empty — provide at least one substring or regex.' };
    }

    const { matchers, error } = buildMatchers(args.patterns, args.regex, args.ignore_case);
    if (error) return { ok: false, error };

    const all = ctx.library.list(args.collection);
    // 最新的优先（与 wiki_list 一致：用户更可能记得最近写的）
    all.sort((a, b) => b.updated.localeCompare(a.updated));

    const items: Array<{
      id: string;
      title: string;
      collection: string;
      searched: BodyField;
      source: { type: string; value?: string };
      source_path?: string;
      match_count: number;
      matches: GrepMatch[];
    }> = [];
    let totalMatched = 0;

    for (const entry of all) {
      const body = resolveBody(entry, ctx);
      const matches = grepEntry(entry, body, matchers, args.max_matches_per_entry);
      if (matches.length === 0) continue;
      totalMatched++;
      if (items.length < args.max_entries) {
        items.push({
          id: entry.id,
          title: entry.title,
          collection: entry.collection,
          searched: body.field,
          source: {
            type: entry.source.type,
            ...(entry.source.value ? { value: entry.source.value } : {}),
          },
          ...(body.sourcePath ? { source_path: body.sourcePath } : {}),
          match_count: matches.length,
          matches,
        });
      }
    }

    return {
      ok: true,
      mode: args.regex ? 'regex' : 'literal',
      patterns: args.patterns,
      total_matched: totalMatched,
      returned: items.length,
      truncated: totalMatched > items.length,
      items,
    };
  },
};
