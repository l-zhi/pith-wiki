/**
 * 中栏文件夹浏览器的纯逻辑：把一个集合的扁平条目列表，按当前 subpath 层级
 * 折成「直接子目录 + 直属条目」两组。段级比较（非字符串前缀），所以 `2024`
 * 不会误吞 `20240`。
 */
import type { EntrySummary } from '../../shared/protocol';

export interface FolderRow {
  name: string;
  /** 该子目录子树下的条目总数（含更深层）。 */
  count: number;
}

export interface FolderView {
  /** 当前层的直接子目录，按名排序。 */
  folders: FolderRow[];
  /** 直属当前层（subpath 恰好等于 path）的条目，保持传入顺序。 */
  atLevel: EntrySummary[];
}

/** 计算 `path` 层的文件夹视图。path=[] 表示集合根。 */
export function folderView(entries: EntrySummary[], path: string[]): FolderView {
  const counts = new Map<string, number>();
  const atLevel: EntrySummary[] = [];
  for (const e of entries) {
    const segs = e.subpath ? e.subpath.split('/') : [];
    let under = true;
    for (let i = 0; i < path.length; i++) {
      if (segs[i] !== path[i]) {
        under = false;
        break;
      }
    }
    if (!under) continue;
    if (segs.length === path.length) atLevel.push(e);
    else {
      const seg = segs[path.length];
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
  }
  const folders = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  return { folders, atLevel };
}
