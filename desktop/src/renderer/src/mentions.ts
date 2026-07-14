/**
 * `@`-mention 引用选择器的纯逻辑（对标 CLI 的 src/cli/mentions.ts）。
 *
 * 单一真相：composer 的实时候选、键盘导航（下钻 / 补全 / 退层）都从这里读。
 * 目录树本体由 engine 建好经 bridge 下发（MentionTreeDTO），这里只做"按层列举 + 改写输入框"。
 *
 * 与 CLI 的差异：桌面是 textarea，mention 结束于**光标处**而非字符串末尾；所有解析 / 改写
 * 都基于「光标前的文本」，改写函数返回 { value, cursor } 让调用方恢复光标。
 *
 * 语义（filesystem 直觉，与 store.parseScopeFromText 对齐）：
 *   - 条目引用：`@<id>`          —— 钉住该条目
 *   - 集合引用：`@<collection>/`  —— 结尾斜杠 = 目录，收窄到该集合
 * 深层子目录（`@col/sub/`）可下钻浏览，但桌面 ScopeDTO 只有集合 / 条目两级，
 * 确认深层目录不产生 scope（parseScopeFromText 只认已知集合）——浏览辅助而已。
 */
import type { MentionTreeDTO, MentionNodeDTO } from '../../shared/protocol';

export interface MentionLevelItem {
  kind: 'dir' | 'entry';
  /** 展示名：目录段名 or 条目 title。 */
  label: string;
  /** dir: 目录段名（下钻拼接用）；entry: 条目 id（确认插入用）。 */
  segment: string;
  /** dir: 该子树下条目总数。 */
  count?: number;
  /** entry: 所属集合（展示用）。 */
  collection?: string;
}

/** 光标前正在输入的 @-mention 拆成「已完成目录段 + 正在输入的 partial」。 */
export interface MentionInput {
  pathSegs: string[];
  partial: string;
}

/** 光标前末尾的 `@<非空白非@串>`。 */
const ACTIVE = /@([^\s@]*)$/;

/**
 * 检测光标前是否正在输入 @-mention；`/` 开头（slash 命令）时不触发。
 * 返回 null 表示当前不在 mention 输入态。
 */
export function parseMentionInput(value: string, cursor: number): MentionInput | null {
  if (value.startsWith('/')) return null;
  const before = value.slice(0, cursor);
  const m = before.match(ACTIVE);
  if (!m) return null;
  const parts = m[1].split('/');
  const partial = parts.pop() ?? '';
  return { pathSegs: parts, partial };
}

function nodeAt(tree: MentionTreeDTO, pathSegs: string[]): MentionNodeDTO | null {
  let node = tree.root;
  for (const seg of pathSegs) {
    const child = node.dirs[seg];
    if (!child) return null;
    node = child;
  }
  return node;
}

/**
 * 列出某层（pathSegs）的目录 + 条目，按 partial 大小写无关子串过滤。
 *
 * 目录**永不截断**——弹层可滚动，全部文件夹都必须可达（否则排在末尾的集合，
 * 如中文 collation 下的 `AI协作内容` / `Clippings`，会被限流吞掉，用户根本看不到）。
 * 只有条目按 entryLimit 限流（单层可能上千条），不够就靠打字过滤。
 */
export function listLevel(
  tree: MentionTreeDTO,
  pathSegs: string[],
  partial = '',
  entryLimit = 50,
): MentionLevelItem[] {
  const node = nodeAt(tree, pathSegs);
  if (!node) return [];
  const needle = partial.toLowerCase();
  const match = (it: MentionLevelItem) =>
    !needle || `${it.label} ${it.segment} ${it.collection ?? ''}`.toLowerCase().includes(needle);

  const dirs: MentionLevelItem[] = Object.entries(node.dirs)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seg, child]) => ({ kind: 'dir' as const, label: seg, segment: seg, count: child.count }))
    .filter(match);
  const entries: MentionLevelItem[] = node.entries
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ kind: 'entry' as const, label: e.title, segment: e.id, collection: e.collection }))
    .filter(match);

  // 目录全留；条目限流。
  return [...dirs, ...entries.slice(0, entryLimit)];
}

// ── 输入框改写（光标感知）──────────────────────────────────────────────────

/** 改写结果：新文本 + 新光标位置。 */
export interface MentionEdit {
  value: string;
  cursor: number;
}

/** 把光标前末尾的 `@…` 替换成 replacement，保留光标后的文本，光标落在替换段末尾。 */
function replaceActive(value: string, cursor: number, replacement: string): MentionEdit {
  const before = value.slice(0, cursor).replace(ACTIVE, replacement);
  const after = value.slice(cursor);
  return { value: before + after, cursor: before.length };
}

/** 已完成路径前缀的 @ 串：['技术相关'] → '@技术相关/'，[] → '@'。 */
function mentionPrefix(pathSegs: string[]): string {
  return pathSegs.length ? `@${pathSegs.join('/')}/` : '@';
}

/** 下钻进目录（无尾空格，选择器继续列该目录内容）。 */
export function descendValue(
  value: string,
  cursor: number,
  pathSegs: string[],
  seg: string,
): MentionEdit {
  return replaceActive(value, cursor, `${mentionPrefix(pathSegs)}${seg}/`);
}

/** 退出当前目录回到上一层。 */
export function ascendValue(value: string, cursor: number, pathSegs: string[]): MentionEdit {
  return replaceActive(value, cursor, mentionPrefix(pathSegs.slice(0, -1)));
}

/** 确认条目 = 插入裸 `@id`（尾空格关闭选择器；丢弃导航用的路径前缀）。 */
export function confirmEntryValue(value: string, cursor: number, id: string): MentionEdit {
  return replaceActive(value, cursor, `@${id} `);
}

/**
 * 「全选」= 选中当前所在文件夹整体：
 *   - root（pathSegs 为空）→ 删掉 `@…`，不加范围 = 整个知识库。
 *   - 集合 / 子目录层         → 插入 `@<path>/ `（集合或子文件夹 scope）。
 */
export function confirmSelfValue(value: string, cursor: number, pathSegs: string[]): MentionEdit {
  if (pathSegs.length === 0) return replaceActive(value, cursor, '');
  return replaceActive(value, cursor, `${mentionPrefix(pathSegs)} `);
}
