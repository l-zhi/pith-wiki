/**
 * 关键词打分（ASCII 词 + CJK bigram）。
 *
 * ContextAssembler 和 HydrationService 共用：
 *   - assembler: query 一段文本 → 在 wiki 全集里挑相关 entry 拼上下文
 *   - hydrator:  把当前 collection 的 linkCandidates 按"与原文相关性"挑 top-N
 *                喂给 LLM，避免一次塞 500 条噪声
 *
 * 不上正经分词器（jieba / segmentit）的原因见 assembler.ts 旧注释：
 * 依赖体积太大，bigram 召回已经够用；想要语义检索得换 embedding，不是 tokenizer 的事。
 */
import type { Entry } from './types.js';

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/;

function isCJKBlock(s: string): boolean {
  return CJK_RE.test(s) && [...s].every((ch) => CJK_RE.test(ch));
}

/** 抽出所有连续 CJK 段，逐段做 bigram。 */
function extractCJKRuns(s: string): string[] {
  const runs: string[] = [];
  let buf = '';
  for (const ch of s) {
    if (CJK_RE.test(ch)) buf += ch;
    else if (buf) {
      runs.push(buf);
      buf = '';
    }
  }
  if (buf) runs.push(buf);
  return runs;
}

/**
 * ASCII 词（长度 > 1）+ CJK bigram。
 * - "成长和低谷期" → ["成长","长和","和低","低谷","谷期"]
 * - "OpenAI tools" → ["openai","tools"]
 * unigram 不加：高频字（的/了）会让大半 entry 都被打分。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const w of lower.split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length > 1 && !isCJKBlock(w)) tokens.push(w);
  }

  for (const run of extractCJKRuns(lower)) {
    if (run.length < 2) continue;
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

export function countHits(haystack: string[], needles: Set<string>): number {
  let n = 0;
  for (const t of haystack) if (needles.has(t)) n += 1;
  return n;
}

/**
 * 给单个 entry 按 query token 集合打分。
 * 权重：title×2 + tags×2 + summary×1 + content×0.5。
 *
 * 抽出来的好处：assembler 的 BFS 扩展逻辑可以保留拿到原始 score 排序，
 * 而 hydrator 只需要 top-N 不关心分数本身。共用同一份公式。
 */
export function scoreEntry(entry: Entry, queryTokens: Set<string>): number {
  return (
    2 * countHits(tokenize(entry.title), queryTokens) +
    2 * countHits(tokenize(entry.tags.join(' ')), queryTokens) +
    countHits(tokenize(entry.summary), queryTokens) +
    0.5 * countHits(tokenize(entry.content), queryTokens)
  );
}

/**
 * 按 query 文本对 entries 打分，返回 top-N（score>0 的；不足 N 则少返）。
 *
 * 复杂度 O(n·k)，n=entry 数，k=每个 entry 的平均 token 数。query token 化只做一次。
 * 调用方应自行决定 query 的长度——传整篇万字长文也能跑，但通常前 4k 字符就够了。
 *
 * 返回顺序：按分数降序；同分按输入顺序稳定。
 */
export function topNByQuery(query: string, entries: Entry[], topN: number): Entry[] {
  if (entries.length === 0 || topN <= 0) return [];
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const scored: { entry: Entry; score: number; idx: number }[] = [];
  entries.forEach((entry, idx) => {
    const score = scoreEntry(entry, queryTokens);
    if (score > 0) scored.push({ entry, score, idx });
  });
  // 同分维持输入顺序（idx 升序）——批量 ingest 时拿到的 candidates 已按 updated
  // 排序，相关性平手时倾向于挑更新的 entry，对自动链接有用。
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, topN).map((s) => s.entry);
}
