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

/** 子文件夹范围：集合内某个 subpath 前缀（`<wikiRoot>/<collection>/<subpath>/…`）。 */
export interface FolderScope {
  collection: string;
  /** POSIX 相对前缀，无首尾斜杠；命中该目录本身及其所有子目录。 */
  subpath: string;
}

/**
 * 本轮检索范围（来自 `@`-mention）。
 *   - collections：硬过滤——候选池与链接扩展都只在这些集合内（整个集合）
 *   - folders    ：硬过滤——收窄到集合内某个 subpath 前缀（子文件夹粒度）
 *   - entryIds   ：钉死——这些条目强制注入（即使打分 0 / 不在过滤内），且排在最前
 * collections 与 folders 取并集（命中任一即在范围内）。三者皆空 / 未传 → 整库召回。
 */
export interface QueryScope {
  collections?: string[];
  folders?: FolderScope[];
  entryIds?: string[];
}

/** 条目是否落在某个子文件夹前缀内（目录本身或其子孙）。 */
function underFolder(entry: { collection: string; subpath?: string }, f: FolderScope): boolean {
  if (entry.collection !== f.collection) return false;
  const sp = entry.subpath ?? '';
  return sp === f.subpath || sp.startsWith(f.subpath + '/');
}

const TOKEN_CHARS = 4;


export class ContextAssembler {
  constructor(private readonly library: LibraryService) {}

  query(text: string, maxTokens = 4000, scope?: QueryScope): QueryResult {
    const queryTokens = new Set(tokenize(text));
    const pinnedIds = scope?.entryIds ?? [];
    const collSet =
      scope?.collections && scope.collections.length > 0 ? new Set(scope.collections) : null;
    const folders = scope?.folders ?? [];
    const hasScope = collSet !== null || folders.length > 0;
    // 集合 scope ∪ 子文件夹 scope 的硬过滤谓词。
    const inScope = (e: { collection: string; subpath?: string }): boolean =>
      (collSet?.has(e.collection) ?? false) || folders.some((f) => underFolder(e, f));

    // 没有 query token 时通常直接返回空——但若有钉死条目（用户只 @文件 不提问），
    // 仍要把它们渲染出来。
    if (queryTokens.size === 0 && pinnedIds.length === 0) {
      return { context: '', referencedEntries: [], references: [] };
    }

    // 候选池：有范围时只取范围内条目，否则全量。
    const all = hasScope ? this.library.list().filter(inScope) : this.library.list();
    const scored: Scored[] = [];
    for (const entry of all) {
      const score = queryTokens.size > 0 ? scoreEntry(entry, queryTokens) : 0;
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const seeds = scored.slice(0, 5);

    const linkIndex = this.library.linkIndex();
    const ordered: string[] = [];
    const seen = new Set<string>();
    // 钉死条目排最前：即便打分为 0 / 跨集合也保留，优先占预算。
    for (const id of pinnedIds) {
      if (!seen.has(id) && this.library.get(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    for (const s of seeds) {
      if (!seen.has(s.entry.id)) {
        ordered.push(s.entry.id);
        seen.add(s.entry.id);
      }
      const node = linkIndex.get(s.entry.id);
      if (node) {
        for (const linkId of node.forward) {
          // 有范围时链接扩展不越界（只跟进仍在 scope 内的条目）。
          if (hasScope) {
            const target = this.library.get(linkId);
            if (!target || !inScope(target)) continue;
          }
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
