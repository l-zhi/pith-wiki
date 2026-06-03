/**
 * `@`-mention 注册表 + 解析 / 过滤 / 补全。
 *
 * 单一真相：InputBox 的实时提示、Tab 补全、App.tsx 提交时的 scope 解析都从这里读，
 * 对标 slashCommands.ts 之于 `/` 命令。
 *
 * 语义（filesystem 直觉）：
 *   - 条目 mention：`@<id>`          —— 把该条目钉死注入本轮检索
 *   - 集合 mention：`@<collection>/`  —— 结尾斜杠 = 目录；把本轮检索收窄到该集合
 *   id 正则不含 `/`，所以"token 是否以 `/` 结尾"足以无歧义区分集合 / 条目。
 *
 * `@` 只能指向 wikiRoot 下真实存在的目录 / 文件——候选全部来自 LibraryService
 * 的内存索引；不命中任何已知集合 / 条目的 token 在解析时被忽略（当普通文本）。
 */
import type { LibraryService } from '../wiki/library.js';
import type { QueryScope } from '../wiki/assembler.js';

export type MentionCandidate =
  | { kind: 'collection'; token: string; label: string; count: number }
  | { kind: 'entry'; token: string; label: string; collection: string };

/**
 * 提交时旁路传给 agent 的本轮检索范围。
 * 复用 wiki 层的 QueryScope（assembler 直接吃这个类型），这里把数组定为必填，
 * 表示"已解析出至少一个有效 mention"。
 */
export type TurnScope = Required<QueryScope>;

/**
 * 从库的内存索引建候选列表：集合在前（带尾斜杠 token），条目在后。
 * 廉价：一次 list() 遍历；调用方按 library 做 useMemo 即可。
 */
export function buildMentionCandidates(library: LibraryService): MentionCandidate[] {
  const entries = library.list();
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.collection, (counts.get(e.collection) ?? 0) + 1);

  const collections: MentionCandidate[] = Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({
      kind: 'collection',
      token: `${name}/`,
      label: name,
      count,
    }));

  const entryCands: MentionCandidate[] = entries
    .map((e) => ({
      kind: 'entry' as const,
      token: e.id,
      label: e.title,
      collection: e.collection,
    }))
    .sort((a, b) => a.token.localeCompare(b.token));

  return [...collections, ...entryCands];
}

/**
 * 取输入末尾"正在输入的 mention"的 partial（不含 `@`）。
 * 命中条件：光标处（这里近似为字符串末尾）有一个 `@`，且其后到末尾不含空白 / 第二个 `@`。
 * 返回 null 表示当前不在 mention 输入态。
 */
export function activeMention(value: string): string | null {
  const m = value.match(/@([^\s@]*)$/);
  return m ? m[1] : null;
}

/**
 * 按 partial 过滤候选：对 token / label / collection 做大小写无关子串匹配。
 * 空 partial → 返回前 limit 条（集合优先）。结果上限 limit（默认 8）。
 */
export function filterMentions(
  candidates: MentionCandidate[],
  partial: string,
  limit = 8,
): MentionCandidate[] {
  const needle = partial.toLowerCase();
  if (!needle) return candidates.slice(0, limit);
  const out: MentionCandidate[] = [];
  for (const c of candidates) {
    const hay =
      c.kind === 'collection'
        ? `${c.token} ${c.label}`
        : `${c.token} ${c.label} ${c.collection}`;
    if (hay.toLowerCase().includes(needle)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * 把输入末尾的 `@partial` 替换成选中候选的规范 token，并追加一个空格
 * （集合 token 已自带尾斜杠；空格让用户接着打问题）。
 */
export function completeMention(value: string, cand: MentionCandidate): string {
  const replaced = value.replace(/@([^\s@]*)$/, `@${cand.token}`);
  return `${replaced} `;
}

// ── 目录树导航（picker 用）─────────────────────────────────────────────────
// flat 候选（上面）够 parseScope 校验用；但 picker 要支持"进目录 / 退目录"，
// 需要按真实目录层级（collection + subpath）组织。下面建一棵树 + 按层列举。

export interface MentionLevelItem {
  kind: 'dir' | 'entry';
  /** 展示名：目录名 or 条目 title。 */
  label: string;
  /** dir: 目录段名（下钻拼接用）；entry: 条目 id（确认插入用）。 */
  segment: string;
  /** dir: 该子树下的条目总数。 */
  count?: number;
  /** entry: 所属集合（展示用）。 */
  collection?: string;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  entries: { id: string; title: string; collection: string }[];
  count: number;
}

export interface MentionTree {
  root: DirNode;
}

/** 按 [collection, ...subpath] 把条目铺进目录树。 */
export function buildMentionTree(library: LibraryService): MentionTree {
  const root: DirNode = { dirs: new Map(), entries: [], count: 0 };
  for (const e of library.list()) {
    const segs = [e.collection, ...(e.subpath ? e.subpath.split('/') : [])];
    let node = root;
    node.count += 1;
    for (const seg of segs) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), entries: [], count: 0 };
        node.dirs.set(seg, child);
      }
      child.count += 1;
      node = child;
    }
    node.entries.push({ id: e.id, title: e.title, collection: e.collection });
  }
  return { root };
}

function nodeAt(tree: MentionTree, pathSegs: string[]): DirNode | null {
  let node = tree.root;
  for (const seg of pathSegs) {
    const child = node.dirs.get(seg);
    if (!child) return null;
    node = child;
  }
  return node;
}

/** 列出某层（pathSegs）的目录 + 条目，按 partial 过滤，上限 limit。 */
export function listLevel(
  tree: MentionTree,
  pathSegs: string[],
  partial = '',
  limit = 8,
): MentionLevelItem[] {
  const node = nodeAt(tree, pathSegs);
  if (!node) return [];
  const dirs: MentionLevelItem[] = [...node.dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seg, child]) => ({ kind: 'dir', label: seg, segment: seg, count: child.count }));
  const entries: MentionLevelItem[] = node.entries
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ kind: 'entry', label: e.title, segment: e.id, collection: e.collection }));
  const all = [...dirs, ...entries];
  const needle = partial.toLowerCase();
  const filtered = needle
    ? all.filter((it) =>
        `${it.label} ${it.segment} ${it.collection ?? ''}`.toLowerCase().includes(needle),
      )
    : all;
  return filtered.slice(0, limit);
}

/** 把当前输入末尾的 @-mention 拆成"已完成目录段 + 正在输入的 partial"。 */
export interface MentionInput {
  pathSegs: string[];
  partial: string;
}
export function parseMentionInput(value: string): MentionInput | null {
  if (value.startsWith('/')) return null;
  const token = activeMention(value);
  if (token === null) return null;
  const parts = token.split('/');
  const partial = parts.pop() ?? '';
  return { pathSegs: parts, partial };
}

/** 已完成路径前缀的 @ 串：['技术相关'] → '@技术相关/'，[] → '@'。 */
function mentionPrefix(pathSegs: string[]): string {
  return pathSegs.length ? `@${pathSegs.join('/')}/` : '@';
}
function replaceActiveMention(value: string, replacement: string): string {
  return value.replace(/@([^\s@]*)$/, replacement);
}

/** 下钻进目录（无尾空格，picker 继续显示该目录内容）。 */
export function descendValue(value: string, pathSegs: string[], seg: string): string {
  return replaceActiveMention(value, `${mentionPrefix(pathSegs)}${seg}/`);
}
/** 退出当前目录回到上一层。 */
export function ascendValue(value: string, pathSegs: string[]): string {
  return replaceActiveMention(value, mentionPrefix(pathSegs.slice(0, -1)));
}
/** 确认目录 = 选中为集合 scope（尾空格关闭 picker）。 */
export function confirmDirValue(value: string, pathSegs: string[], seg: string): string {
  return replaceActiveMention(value, `${mentionPrefix(pathSegs)}${seg}/ `);
}
/** 确认条目 = 插入裸 @id（尾空格关闭 picker；丢弃导航用的路径前缀）。 */
export function confirmEntryValue(value: string, id: string): string {
  return replaceActiveMention(value, `@${id} `);
}

/**
 * 从已提交文本解析出本轮 scope。
 *   - 扫描所有 `@token`（token = 非空白非 @ 串，可含尾斜杠）
 *   - 尾斜杠 → 查集合集，命中入 collections
 *   - 否则   → 查条目 id 集，命中入 entryIds
 *   - 都不命中 → 忽略（当普通文本，不报错、不收窄）
 * 返回 null 表示没有任何有效 mention。
 */
export function parseScope(text: string, candidates: MentionCandidate[]): TurnScope | null {
  const collectionTokens = new Set<string>(); // 含尾斜杠
  const entryIds = new Set<string>();
  for (const c of candidates) {
    if (c.kind === 'collection') collectionTokens.add(c.token);
    else entryIds.add(c.token);
  }

  const collections = new Set<string>();
  const pinned = new Set<string>();
  // 全局扫 @token（含 CJK / 数字 / 连字符 / 尾斜杠）。
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (raw.endsWith('/')) {
      if (collectionTokens.has(raw)) collections.add(raw.slice(0, -1));
    } else if (entryIds.has(raw)) {
      pinned.add(raw);
    }
  }

  if (collections.size === 0 && pinned.size === 0) return null;
  return { collections: [...collections], entryIds: [...pinned] };
}
