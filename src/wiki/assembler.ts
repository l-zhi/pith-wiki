import type { LibraryService } from './library.js';
import type { Entry } from './types.js';

interface Scored {
  entry: Entry;
  score: number;
}

/** wiki_query 工具返回给模型的"被引用条目"摘要：让模型看见 source 路径，
 *  能直接判断"要不要 read_file 读原文"。 */
export interface ReferencedEntry {
  id: string;
  title: string;
  collection: string;
  /**
   * 原始来源信息。
   *   - type='file' + value=绝对路径：模型可调 wiki_read_source(id) 或 read_file(value) 读原文
   *   - type='url' + value：原始 URL（不会自动 fetch，仅信息）
   *   - type='inline' / 'unknown'：没有更原始的源
   */
  source: { type: string; value?: string };
}

export interface QueryResult {
  /** 拼好的 markdown context block，可直接喂给模型。 */
  context: string;
  /** 被纳入 context 的 entry id 列表（保持 v0 兼容；CLI / 测试都用这个）。 */
  referencedEntries: string[];
  /**
   * 同 referencedEntries 顺序对齐，但每条带 title / collection / source。
   * wiki_query 工具把这块返回给模型，让 LLM 直接看到原始来源路径，
   * 自行判断要不要 read_file / wiki_read_source 读原文。
   */
  references: ReferencedEntry[];
}

const TOKEN_CHARS = 4;

/**
 * 把文本拆成可比对的 token。
 *
 * 两条管线：
 *   1. ASCII / Latin / 数字：沿用 v0 的 `\W+` 切词，长度 > 1 才保留
 *   2. CJK（中日韩）：按字符滑窗生成 bigram。例 "成长和低谷期" → ["成长","长和","和低","低谷","谷期"]
 *
 * 为什么不上正经分词器（jieba / segmentit）？依赖体积大（数百 KB～MB），且本项目
 * 是关键词打分检索，bigram 的召回已经能把"问句对题目"这层覆盖到 80% 以上。
 * 真要做语义检索得换 embedding，不是 tokenizer 的活。
 *
 * unigram 不加是有意——单字命中率太高、噪声大。"的"、"了" 这类高频字会让
 * 大半 entry 都拿到分。bigram 是"两字出现"，已经蕴含很弱的"近邻语义"。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // ASCII 词：原 v0 路径
  for (const w of lower.split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length > 1 && !isCJKBlock(w)) tokens.push(w);
  }

  // CJK bigrams：从原字符串里抽出 CJK 连续段，逐段做 2-char 滑窗
  for (const run of extractCJKRuns(lower)) {
    if (run.length < 2) continue;
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 判断字符串是否完全由 CJK 字符组成（用于把 ASCII 路径排除）。
 * 范围覆盖：CJK 基本汉字 + 扩展 A + 兼容汉字 + 假名 + 谚文。
 */
function isCJKBlock(s: string): boolean {
  return CJK_RE.test(s) && [...s].every((ch) => CJK_RE.test(ch));
}

/** 从字符串中抽出所有连续 CJK 段。 */
function extractCJKRuns(s: string): string[] {
  const runs: string[] = [];
  let buf = '';
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      buf += ch;
    } else if (buf) {
      runs.push(buf);
      buf = '';
    }
  }
  if (buf) runs.push(buf);
  return runs;
}

const CJK_RE =
  /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/;

function countHits(haystack: string[], needles: Set<string>): number {
  let n = 0;
  for (const t of haystack) if (needles.has(t)) n += 1;
  return n;
}

export class ContextAssembler {
  constructor(private readonly library: LibraryService) {}

  query(text: string, maxTokens = 4000): QueryResult {
    const queryTokens = new Set(tokenize(text));
    if (queryTokens.size === 0) {
      return { context: '', referencedEntries: [], references: [] };
    }

    const all = this.library.list();
    const scored: Scored[] = [];
    for (const entry of all) {
      const titleTokens = tokenize(entry.title);
      const summaryTokens = tokenize(entry.summary);
      const tagTokens = tokenize(entry.tags.join(' '));
      const contentTokens = tokenize(entry.content);
      const score =
        2 * countHits(titleTokens, queryTokens) +
        2 * countHits(tagTokens, queryTokens) +
        countHits(summaryTokens, queryTokens) +
        0.5 * countHits(contentTokens, queryTokens);
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const seeds = scored.slice(0, 5);

    const linkIndex = this.library.linkIndex();
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const s of seeds) {
      if (!seen.has(s.entry.id)) {
        ordered.push(s.entry.id);
        seen.add(s.entry.id);
      }
      const node = linkIndex.get(s.entry.id);
      if (node) {
        for (const linkId of node.forward) {
          if (!seen.has(linkId)) {
            ordered.push(linkId);
            seen.add(linkId);
          }
        }
      }
    }

    const budgetChars = Math.floor(maxTokens * TOKEN_CHARS * 0.7);
    const parts: string[] = [];
    const referencedIds: string[] = [];
    const references: ReferencedEntry[] = [];
    let used = 0;
    for (const id of ordered) {
      const entry = this.library.get(id);
      if (!entry) continue;
      const block = this.renderEntry(entry);
      if (used + block.length > budgetChars && parts.length > 0) break;
      parts.push(block);
      referencedIds.push(entry.id);
      references.push({
        id: entry.id,
        title: entry.title,
        collection: entry.collection,
        source: {
          type: entry.source.type,
          ...(entry.source.value ? { value: entry.source.value } : {}),
        },
      });
      used += block.length;
      if (used >= budgetChars) break;
    }

    return {
      context: parts.join('\n\n---\n\n'),
      referencedEntries: referencedIds,
      references,
    };
  }

  private renderEntry(entry: Entry): string {
    const tagLine = entry.tags.length ? `tags: ${entry.tags.join(', ')}` : '';
    const linkLine = entry.links.length ? `links: ${entry.links.join(', ')}` : '';
    const meta = [tagLine, linkLine].filter(Boolean).join(' · ');
    const header = `## ${entry.title} (${entry.id})`;
    return [header, meta, entry.summary, '', entry.content].filter(Boolean).join('\n');
  }
}
