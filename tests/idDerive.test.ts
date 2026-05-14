/**
 * deriveIdFromFilename 单元测试。
 *
 * 测点：纯函数行为 — 中英混合 / 标点折叠 / 大小写 / 扩展名去除 / 截长 / 边界。
 */
import { describe, expect, it } from 'vitest';
import { deriveIdFromFilename } from '../src/wiki/idDerive.js';
import { ID_RE } from '../src/wiki/types.js';

describe('deriveIdFromFilename — 主路径', () => {
  it('用户的真实场景：中英混合 + 中文标点全部清洗成连字符', () => {
    // 文件名带：中文逗号 "，"、中文问号 "？"、中文引号 ""…""、ASCII 字母
    const input = '成本1500，估值1000万？"死了么"APP凭什么火了.md';
    const id = deriveIdFromFilename(input);
    // 关键不变量：所有汉字都保留下来，没丢一个；不是被压成 "死了么"
    expect(id).toContain('成本1500');
    expect(id).toContain('估值1000万');
    expect(id).toContain('死了么');
    expect(id).toContain('app凭什么火了'); // ASCII 已小写
    // 落入 ID_RE 合法字符集
    expect(ID_RE.test(id)).toBe(true);
  });

  it('纯中文文件名：直接保留汉字', () => {
    expect(deriveIdFromFilename('成长经历.md')).toBe('成长经历');
  });

  it('纯英文文件名：去扩展名 + 保持已有 kebab-case', () => {
    expect(deriveIdFromFilename('react-hooks-patterns.md')).toBe('react-hooks-patterns');
  });

  it('英文大写 → 小写', () => {
    expect(deriveIdFromFilename('MyEntry.md')).toBe('myentry');
  });

  it('空格 → 连字符', () => {
    expect(deriveIdFromFilename('hello world.md')).toBe('hello-world');
  });

  it('多种非法字符连续出现 → 折叠成单个连字符', () => {
    // "，！ ：" 三个连续非法字符应折叠成一个 `-`
    expect(deriveIdFromFilename('foo，！ ：bar.md')).toBe('foo-bar');
  });
});

describe('deriveIdFromFilename — 扩展名', () => {
  it.each([
    ['note.md', 'note'],
    ['note.markdown', 'note'],
    ['note.mdx', 'note'],
    ['note.txt', 'note'],
    ['note.pdf', 'note'],
    ['note.PDF', 'note'], // 大小写不敏感
    ['note.doc', 'note'],
    ['note.docx', 'note'],
    ['note.html', 'note'],
    ['note.htm', 'note'],
  ])('去扩展名: %s → %s', (input, expected) => {
    expect(deriveIdFromFilename(input)).toBe(expected);
  });

  it('未知扩展名保留（不在白名单内的就当 id 一部分）', () => {
    // .xyz 不在 EXT_RE 里，应当被当作普通字符 → 点变 `-`
    expect(deriveIdFromFilename('note.xyz')).toBe('note-xyz');
  });

  it('多个点：只去末尾的扩展名', () => {
    expect(deriveIdFromFilename('v1.0.note.md')).toBe('v1-0-note');
  });
});

describe('deriveIdFromFilename — 边界', () => {
  it('空字符串 → 空字符串', () => {
    expect(deriveIdFromFilename('')).toBe('');
  });

  it('只有扩展名 → 空字符串', () => {
    expect(deriveIdFromFilename('.md')).toBe('');
  });

  it('只有非法字符 → 空字符串（调用方需自行 fallback）', () => {
    expect(deriveIdFromFilename('___.md')).toBe('');
    expect(deriveIdFromFilename('！？，')).toBe('');
  });

  it('引导/尾随连字符被 trim', () => {
    expect(deriveIdFromFilename('-foo-.md')).toBe('foo');
    expect(deriveIdFromFilename('   foo   .md')).toBe('foo');
  });

  it('路径分隔符当成非法字符（避免误用全路径调用）', () => {
    // 调用方应传 basename；万一传了带路径的进来，至少 id 合法不破坏文件系统
    expect(deriveIdFromFilename('dir/sub/note.md')).toBe('dir-sub-note');
  });

  it('截长：超长输入截到 maxChars，并清理尾随 `-`', () => {
    const long = 'a'.repeat(80) + '.md';
    expect(deriveIdFromFilename(long, 20).length).toBeLessThanOrEqual(20);
    expect(deriveIdFromFilename(long, 20)).toBe('a'.repeat(20));
  });

  it('截长恰好停在连字符上 → 把尾随 `-` 去掉', () => {
    // "abc-def-ghi" 截到 8 → "abc-def-" → "abc-def"
    expect(deriveIdFromFilename('abc-def-ghi.md', 8)).toBe('abc-def');
  });

  it('中文 + 数字 + 英文混合保持顺序', () => {
    expect(deriveIdFromFilename('2024年AI综述.md')).toBe('2024年ai综述');
  });
});
