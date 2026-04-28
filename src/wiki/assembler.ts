import type { LibraryService } from './library.js';
import type { Entry } from './types.js';

interface Scored {
  entry: Entry;
  score: number;
}

export interface QueryResult {
  context: string;
  referencedEntries: string[];
}

const TOKEN_CHARS = 4;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1);
}

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
      return { context: '', referencedEntries: [] };
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
    const referenced: string[] = [];
    let used = 0;
    for (const id of ordered) {
      const entry = this.library.get(id);
      if (!entry) continue;
      const block = this.renderEntry(entry);
      if (used + block.length > budgetChars && parts.length > 0) break;
      parts.push(block);
      referenced.push(entry.id);
      used += block.length;
      if (used >= budgetChars) break;
    }

    return { context: parts.join('\n\n---\n\n'), referencedEntries: referenced };
  }

  private renderEntry(entry: Entry): string {
    const tagLine = entry.tags.length ? `tags: ${entry.tags.join(', ')}` : '';
    const linkLine = entry.links.length ? `links: ${entry.links.join(', ')}` : '';
    const meta = [tagLine, linkLine].filter(Boolean).join(' · ');
    const header = `## ${entry.title} (${entry.id})`;
    return [header, meta, entry.summary, '', entry.content].filter(Boolean).join('\n');
  }
}
