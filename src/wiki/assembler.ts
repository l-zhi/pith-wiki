import type { LibraryService } from './library.js';
import type { Entry } from './types.js';
import { scoreEntry, tokenize } from './scoring.js';

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
      const score = scoreEntry(entry, queryTokens);
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
