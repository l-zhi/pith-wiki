/**
 * 中栏文件夹浏览器分组逻辑单测（src/renderer/src/libraryTree.ts）。
 * 关注段级前缀匹配、子树计数、直属条目分离。
 */
import { describe, expect, it } from 'vitest';
import { folderView, type FolderRow } from '../src/renderer/src/libraryTree';
import type { EntrySummary } from '../src/shared/protocol';

function e(id: string, subpath?: string): EntrySummary {
  return { id, collection: 'work', subpath, title: id, summary: '', tags: [], sourceType: 'inline', updated: '' };
}

const entries: EntrySummary[] = [
  e('root-a'), // 集合根
  e('root-b'),
  e('q1-note', '2024/q1'),
  e('q2-note', '2024/q2'),
  e('q1-deep', '2024/q1/detail'),
  e('sibling', '20240'), // 与 '2024' 同前缀但不同段
  e('old', '2023'),
];

/** 文件夹按名→计数比对（与排序无关）。 */
const asMap = (fs: FolderRow[]) => Object.fromEntries(fs.map((f) => [f.name, f.count]));

describe('folderView', () => {
  it('根层：直属条目 + 一级子目录（子树计数含更深层）', () => {
    const { folders, atLevel } = folderView(entries, []);
    expect(atLevel.map((x) => x.id)).toEqual(['root-a', 'root-b']);
    expect(asMap(folders)).toEqual({ '2024': 3, '20240': 1, '2023': 1 }); // 2024 子树 = q1-note+q2-note+q1-deep
    // 按名排序
    expect(folders.map((f) => f.name)).toEqual([...folders.map((f) => f.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('钻入 2024：段级匹配不误吞 20240；此层无直属条目', () => {
    const { folders, atLevel } = folderView(entries, ['2024']);
    expect(atLevel).toEqual([]); // 没有 subpath 恰好 = '2024'
    expect(asMap(folders)).toEqual({ q1: 2, q2: 1 }); // q1 含 q1-note + q1-deep
  });

  it('钻入 2024/q1：直属 q1-note，子目录 detail', () => {
    const { folders, atLevel } = folderView(entries, ['2024', 'q1']);
    expect(atLevel.map((x) => x.id)).toEqual(['q1-note']);
    expect(asMap(folders)).toEqual({ detail: 1 });
  });

  it('钻到最深层：只剩直属条目', () => {
    const { folders, atLevel } = folderView(entries, ['2024', 'q1', 'detail']);
    expect(atLevel.map((x) => x.id)).toEqual(['q1-deep']);
    expect(folders).toEqual([]);
  });

  it('不存在的目录路径：两组皆空', () => {
    expect(folderView(entries, ['nope'])).toEqual({ folders: [], atLevel: [] });
  });
});
