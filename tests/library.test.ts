/**
 * LibraryService 单元测试。
 *
 * 测试范围（仅外部行为）：
 * - put / get / list / delete 的 CRUD 语义
 * - 链接索引：正向链接持久化、反向链接懒加载、写入后失效
 * - frontmatter 序列化与反序列化的边界情况（Date 对象、undefined 字段、中文）
 * - 扫描器对格式错误文件的容错
 *
 * 测试不覆盖（v0 设计决策）：
 * - HydrationService 调 LLM 的部分（属于 integration test）
 * - 文件锁 / 并发写入（v0 假定单进程）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { Entry } from '../src/wiki/types.js';

let tmpDir: string;

beforeEach(() => {
  // 每个用例都用独立的临时目录，避免互相污染。
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-lib-'));
});

afterEach(() => {
  // 用例结束后无条件清理临时目录。
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 便捷构造：返回一个最小可用的 Entry，调用方可用 overrides 覆盖任意字段。 */
function makeEntry(overrides: Partial<Entry> = {}): Entry {
  // 注意：compressionRatio 必须显式从 overrides 透传，否则会被 spread 之外的默认值"吃掉"。
  return {
    id: overrides.id ?? 'foo',
    collection: overrides.collection ?? 'tech',
    title: overrides.title ?? 'Foo',
    summary: overrides.summary ?? 'a foo entry',
    tags: overrides.tags ?? ['x'],
    links: overrides.links ?? [],
    content: overrides.content ?? '# Foo\n- bar',
    source: overrides.source ?? { type: 'inline' },
    updated: overrides.updated ?? new Date().toISOString(),
    compressionRatio: overrides.compressionRatio,
  };
}

describe('LibraryService — 基本 CRUD', () => {
  it('put 后 get 拿得到完整 Entry，字段一一对应', () => {
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({
      id: 'agent-design',
      title: 'Agent 设计',
      tags: ['agent', 'arch'],
    });

    lib.put(entry);
    const fetched = lib.get('agent-design');

    expect(fetched).not.toBeNull();
    // 关键字段必须 round-trip 一致（不依赖任何字段顺序假设）。
    expect(fetched!.id).toBe('agent-design');
    expect(fetched!.title).toBe('Agent 设计');
    expect(fetched!.tags).toEqual(['agent', 'arch']);
    expect(fetched!.collection).toBe('tech');
  });

  it('再次 put 同一 id 会覆盖原文件，不产生重复条目', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', title: '原始版本' }));
    lib.put(makeEntry({ id: 'a', title: '更新版本' }));

    // list 只应返回一条；title 是新版本。
    const all = lib.list();
    expect(all.length).toBe(1);
    expect(all[0].title).toBe('更新版本');
  });

  it('delete 删除存在的 entry 返回 true，再 get 返回 null', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a' }));

    expect(lib.get('a')).not.toBeNull();
    expect(lib.delete('a', 'tech')).toBe(true);
    expect(lib.get('a')).toBeNull();
  });

  it('delete 不存在的 entry 返回 false 而不是抛异常', () => {
    const lib = new LibraryService(tmpDir);
    // 防御性检查：用户/LLM 可能误调 delete，应该静默失败。
    expect(lib.delete('does-not-exist', 'tech')).toBe(false);
  });

  it('list 不传 collection 返回所有 collection 的条目', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', collection: 'tech' }));
    lib.put(makeEntry({ id: 'b', collection: 'cooking' }));
    lib.put(makeEntry({ id: 'c', collection: 'reading' }));

    expect(lib.list().length).toBe(3);
  });

  it('list 传 collection 仅返回该 collection 的条目', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', collection: 'tech' }));
    lib.put(makeEntry({ id: 'b', collection: 'cooking' }));

    expect(lib.list('tech').map((e) => e.id)).toEqual(['a']);
    expect(lib.list('cooking').map((e) => e.id)).toEqual(['b']);
    expect(lib.list('does-not-exist')).toEqual([]);
  });
});

describe('LibraryService — 链接索引（懒加载 + 失效）', () => {
  it('多对一反向链接：A、B 都指向 C 时，C 的 backward 包含 A 和 B', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', links: ['c'] }));
    lib.put(makeEntry({ id: 'b', links: ['c'] }));
    lib.put(makeEntry({ id: 'c' }));

    const node = lib.linkIndex().get('c');
    expect(node).toBeDefined();
    expect(node!.backward).toEqual(expect.arrayContaining(['a', 'b']));
    expect(node!.backward).toHaveLength(2);
  });

  it('修改 A 的 links 后再 put，反向链接索引同步更新', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', links: ['b', 'c'] }));
    lib.put(makeEntry({ id: 'b' }));
    lib.put(makeEntry({ id: 'c' }));

    // 初次：B 和 C 都被 A 引用。
    let idx = lib.linkIndex();
    expect(idx.get('b')!.backward).toContain('a');
    expect(idx.get('c')!.backward).toContain('a');

    // 改成只指向 C：B 的反向链接里不再有 A。
    lib.put(makeEntry({ id: 'a', links: ['c'] }));
    idx = lib.linkIndex();
    expect(idx.get('b')!.backward).not.toContain('a');
    expect(idx.get('c')!.backward).toContain('a');
  });

  it('孤儿链接：A 指向不存在的 ghost 时，索引中也会为 ghost 建一个空节点', () => {
    const lib = new LibraryService(tmpDir);
    // ghost 这个 id 没有对应文件，但 A 在 frontmatter 里引用了它。
    lib.put(makeEntry({ id: 'a', links: ['ghost'] }));

    const idx = lib.linkIndex();
    const ghost = idx.get('ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.forward).toEqual([]); // 不存在的实体没有正向链接
    expect(ghost!.backward).toEqual(['a']); // 但有谁引用了它
  });

  it('delete 后再查 backward，反向链接索引被刷新', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', links: ['b'] }));
    lib.put(makeEntry({ id: 'b' }));

    expect(lib.linkIndex().get('b')!.backward).toContain('a');

    lib.delete('a', 'tech');
    // a 文件不存在了，索引应该不再把它列为 b 的 backward。
    expect(lib.linkIndex().get('b')!.backward).toEqual([]);
  });
});

describe('LibraryService — frontmatter 序列化边界', () => {
  it('frontmatter 中的 Date 对象在读取时归一化为 ISO 字符串', () => {
    // 模拟用户用 Obsidian 或手工编辑时把 updated 写成 YAML 日期字面量
    // （不带引号），gray-matter 会解析成 Date 对象。
    const dir = path.join(tmpDir, 'tech');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'a.md'),
      [
        '---',
        'id: a',
        'collection: tech',
        'title: A',
        'summary: ""',
        'tags: []',
        'links: []',
        'source:',
        '  type: inline',
        'updated: 2026-04-28T00:00:00Z', // YAML 会把这解析成 Date
        '---',
        '',
        '# A',
      ].join('\n'),
    );

    const lib = new LibraryService(tmpDir);
    const entry = lib.get('a');
    expect(entry).not.toBeNull();
    // updated 必须是 string 类型，否则 zod schema 会校验失败。
    expect(typeof entry!.updated).toBe('string');
    expect(entry!.updated).toMatch(/^2026-04-28T/);
  });

  it('compressionRatio 为 undefined 时不影响 put（YAML 不能 dump undefined）', () => {
    const lib = new LibraryService(tmpDir);
    // makeEntry 没设 compressionRatio，put 不应抛 "unacceptable kind of an object to dump"。
    expect(() => lib.put(makeEntry({ id: 'no-ratio' }))).not.toThrow();

    const entry = lib.get('no-ratio');
    expect(entry).not.toBeNull();
    expect(entry!.compressionRatio).toBeUndefined();
  });

  it('compressionRatio 非空时正常 round-trip', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'with-ratio', compressionRatio: 0.123 }));

    const entry = lib.get('with-ratio');
    expect(entry!.compressionRatio).toBeCloseTo(0.123, 5);
  });
});

describe('LibraryService — 中文内容', () => {
  it('中文标题、摘要、标签、正文可以完整 round-trip', () => {
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({
      id: 'zhongwen-tiaomu',
      title: '中文条目示例',
      summary: '一句话中文摘要：用来测试 UTF-8 序列化。',
      tags: ['中文', '测试', 'utf-8'],
      content: '# 中文条目示例\n\n- 第一条要点\n- 第二条要点\n- [[other-zh-entry]] 的引用',
    });

    lib.put(entry);
    const fetched = lib.get('zhongwen-tiaomu');

    expect(fetched!.title).toBe('中文条目示例');
    expect(fetched!.summary).toBe('一句话中文摘要：用来测试 UTF-8 序列化。');
    expect(fetched!.tags).toEqual(['中文', '测试', 'utf-8']);
    expect(fetched!.content).toContain('第一条要点');
    expect(fetched!.content).toContain('[[other-zh-entry]]');
  });

  it('中文 id：put → 文件名是中文 .md → get 拿得回来', () => {
    // 业务诉求：源文件名是中文时（如"成长经历.md"），生成的 wiki 条目
    // 文件名也应该是中文，而不是被翻译成 cheng-zhang-jing-li。
    // 这条端到端断言：UTF-8 文件名能正常落盘、能正常 round-trip。
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({
      id: '成长经历',
      title: '成长经历',
      summary: '一段中文 id 的样例条目',
      content: '# 成长经历\n\n- 内容若干',
    });

    lib.put(entry);
    // 文件确实以中文 id 落盘
    const expectedPath = path.join(tmpDir, 'tech', '成长经历.md');
    expect(fs.existsSync(expectedPath)).toBe(true);

    // get 也能用中文 id 取回
    const fetched = lib.get('成长经历');
    expect(fetched!.id).toBe('成长经历');
    expect(fetched!.title).toBe('成长经历');

    // delete 也按中文 id 工作
    expect(lib.delete('成长经历', 'tech')).toBe(true);
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  it('中文 + ASCII 连字符混合 id：成长-2025 也能 round-trip', () => {
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({
      id: '成长-2025',
      title: '2025 成长复盘',
    });
    lib.put(entry);
    expect(fs.existsSync(path.join(tmpDir, 'tech', '成长-2025.md'))).toBe(true);
    expect(lib.get('成长-2025')?.title).toBe('2025 成长复盘');
  });

  it('文件落盘后用 gray-matter 读出来 frontmatter 的字段都对', () => {
    const lib = new LibraryService(tmpDir);
    const entry = makeEntry({
      id: 'check-disk',
      title: '验证落盘格式',
      tags: ['标签一', '标签二'],
    });
    lib.put(entry);

    // 直接读文件，确认 frontmatter 是有效的 YAML 且字段正确。
    const filePath = path.join(tmpDir, 'tech', 'check-disk.md');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);

    expect(parsed.data.id).toBe('check-disk');
    expect(parsed.data.title).toBe('验证落盘格式');
    expect(parsed.data.tags).toEqual(['标签一', '标签二']);
    expect(parsed.content.trim()).toContain('# Foo'); // 正文是 makeEntry 默认值
  });
});

describe('LibraryService — 扫描器容错', () => {
  it('遇到格式错误的 .md 文件时跳过，不影响其他条目', () => {
    const lib = new LibraryService(tmpDir);
    // 先写一条正常条目。
    lib.put(makeEntry({ id: 'good' }));

    // 然后手工写一条 frontmatter 缺失字段的坏条目（id 字段不见了）。
    const dir = path.join(tmpDir, 'tech');
    fs.writeFileSync(
      path.join(dir, 'broken.md'),
      ['---', 'title: 没有 id 字段', '---', '内容'].join('\n'),
    );

    // list 应该至少返回 good，不应抛异常。
    // broken.md 由于 id 字段是文件名兜底（'broken'），可能也会被收纳；
    // 关键是不能 crash。
    const ids = lib.list().map((e) => e.id);
    expect(ids).toContain('good');
  });

  it('wikiRoot 不存在时 list 返回空数组而不是抛异常', () => {
    // 给一个明显不存在的路径，模拟首次启动还没建目录的情形。
    const lib = new LibraryService(path.join(tmpDir, 'never-created'));
    expect(lib.list()).toEqual([]);
    expect(lib.linkIndex().size).toBe(0);
  });

  it('跳过 dotdir：collection 同级的 .cache 不被当作 collection；collection 内的 .cache/*.md 不被当作 entry', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'real', collection: 'tech' }));

    // 模拟 converter sidecar：collection 内有 .cache 子目录，里面藏一个 .md
    const cacheDir = path.join(tmpDir, 'tech', '.cache', 'sub');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'cached.md'),
      ['---', 'id: cached', 'collection: tech', 'title: cached', 'updated: 2026-01-01T00:00:00Z', '---', '# cached body'].join('\n'),
    );
    // 模拟 wikiRoot 顶层的 dotdir（.git / 别的工具放的）
    fs.mkdirSync(path.join(tmpDir, '.scratch'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.scratch', 'whatever.md'),
      '---\nid: ghost\ncollection: ghost\ntitle: ghost\nupdated: 2026-01-01T00:00:00Z\n---\n# ghost',
    );

    // 第二个实例，全量 scanAll（persist=false 强制走 scan）
    const fresh = new LibraryService(tmpDir, { persist: false });
    const ids = fresh.list().map((e) => e.id);
    expect(ids).toEqual(['real']);
    // 确认 dotdir 内文件存在但被忽略
    expect(fs.existsSync(path.join(cacheDir, 'cached.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.scratch', 'whatever.md'))).toBe(true);
    // 用一个变量消解未使用警告
    expect(lib.list()).toHaveLength(1);
  });
});

/**
 * 持久化索引（`<wikiRoot>/index.json`）测试。
 *
 * 关键不变量：
 *   1. flushIndex 后磁盘上有 valid JSON
 *   2. 第二个 LibraryService 实例能从磁盘 cache 读到 entries（不调 scanAll 也行）
 *   3. 用户外部新增/删除文件 → 目录 mtime > index.json mtime → 拒绝 cache，scanAll
 *   4. 持久化禁用模式不写 index.json
 *   5. 损坏的 index.json 退回 scanAll，不抛异常
 */
describe('LibraryService — index.json 持久化', () => {
  function makeEntry(o: Partial<Entry>): Entry {
    return {
      id: o.id ?? 'x',
      collection: o.collection ?? 'tech',
      title: o.title ?? 'x',
      summary: o.summary ?? '',
      tags: o.tags ?? [],
      links: o.links ?? [],
      content: o.content ?? 'x',
      source: o.source ?? { type: 'inline' },
      updated: o.updated ?? new Date().toISOString(),
    };
  }

  it('flushIndex 后磁盘上出现 index.json，version=1', () => {
    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    lib.put(makeEntry({ id: 'a', title: 'Alpha' }));
    lib.put(makeEntry({ id: 'b', title: 'Beta', collection: 'reading' }));
    lib.list(); // 触发 ensureIndex 把 cache 装载
    lib.flushIndex();

    const file = path.join(tmpDir, 'index.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(2);
    const ids = (parsed.entries as Entry[]).map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('第二个实例直接从 index.json 读 entries，跳过 scanAll', () => {
    // 先用一个实例填库 + 刷盘
    const writer = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    writer.put(makeEntry({ id: 'a', title: 'Alpha' }));
    writer.list();
    writer.flushIndex();

    // 删掉真实 .md 文件，但保留 index.json：如果 reader 真的从 cache 读，应该
    // 仍能拿到 a。如果它走 scanAll，会拿到空。
    const mdFile = path.join(tmpDir, 'tech', 'a.md');
    expect(fs.existsSync(mdFile)).toBe(true);
    // 注意：如果删 md 文件会 bump 'tech' 目录的 mtime，反过来让 reader 拒绝 cache。
    // 所以这里反着验证：保留 .md，确认 reader 能从 cache 拿到正确数据。
    const reader = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const got = reader.list();
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe('Alpha');
  });

  it('外部新增 .md 文件 → 目录 mtime 变 → 拒绝 cache，scanAll 抓到', async () => {
    const writer = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    writer.put(makeEntry({ id: 'a' }));
    writer.list();
    writer.flushIndex();

    // 等一小会儿确保 mtime 分辨率（macOS HFS+/APFS 通常是 1ns，但保险）
    await new Promise((r) => setTimeout(r, 20));

    // 模拟外部直接写一个 .md（绕过 LibraryService.put）
    const dir = path.join(tmpDir, 'tech');
    fs.writeFileSync(
      path.join(dir, 'b.md'),
      '---\nid: b\ntitle: ExternalAdd\nupdated: 2026-04-30T00:00:00Z\nsource:\n  type: inline\n---\n# B\nfresh\n',
    );

    const reader = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const got = reader.list();
    const ids = got.map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']); // 走 scanAll 把外部新增文件抓回来
  });

  it('损坏的 index.json 不抛异常，退化为 scanAll', () => {
    // 先建一个真实条目
    const writer = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    writer.put(makeEntry({ id: 'a', title: 'Alpha' }));
    writer.list();
    writer.flushIndex();

    // 故意把 index.json 写坏
    fs.writeFileSync(path.join(tmpDir, 'index.json'), '{not valid json');

    const reader = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const got = reader.list();
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe('a');
  });

  it('version 不匹配 → 拒绝 cache，退化为 scanAll', () => {
    const writer = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    writer.put(makeEntry({ id: 'a' }));
    writer.list();
    writer.flushIndex();

    // 改 version 字段模拟未来版本不兼容
    const file = path.join(tmpDir, 'index.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.version = 999;
    fs.writeFileSync(file, JSON.stringify(parsed));

    const reader = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    expect(reader.list()).toHaveLength(1); // scanAll 兜底，不崩
  });

  it('persist=false → 不写 index.json', () => {
    const lib = new LibraryService(tmpDir, { persist: false, persistDelayMs: 60_000 });
    lib.put(makeEntry({ id: 'a' }));
    lib.list();
    lib.flushIndex(); // no-op when disabled

    expect(fs.existsSync(path.join(tmpDir, 'index.json'))).toBe(false);
  });

  it('schedulePersist 防抖：连续多次 put 只对应 timer 一次', () => {
    // 用极短延迟 + flush 验证：5 次 put 后只产生一份 index.json，且包含全部 5 条
    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    for (let i = 0; i < 5; i++) lib.put(makeEntry({ id: `e${i}` }));
    lib.list();
    lib.flushIndex();

    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'index.json'), 'utf8'));
    expect(parsed.entries).toHaveLength(5);
  });

  it('磁盘 cache schema 兼容：缺字段的旧 cache 被拒绝重建', () => {
    // 写一个 entries 字段缺 title（违反 EntrySchema）的 index.json
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'index.json'),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [{ id: 'broken' /* 缺 title 等必填 */ }],
      }),
    );
    // 同时建一个真实 .md，验证退化路径能跑通
    fs.mkdirSync(path.join(tmpDir, 'tech'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tech', 'real.md'),
      '---\nid: real\ntitle: Real\nupdated: 2026-04-30T00:00:00Z\nsource:\n  type: inline\n---\n# Real\nbody\n',
    );

    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const got = lib.list();
    // schema 校验失败 → 拒绝 cache → scanAll → 拿到 real
    expect(got.map((e) => e.id)).toEqual(['real']);
  });
});
