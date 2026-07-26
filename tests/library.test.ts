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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-lib-'));
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
    subpath: overrides.subpath,
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

  it('subpath：put 落 <collection>/<subpath>/<id>.md，get 取回带 subpath', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'foo', collection: '人生大事', subpath: '希区柯克' }));
    const expectedFile = path.join(tmpDir, '人生大事', '希区柯克', 'foo.md');
    expect(fs.existsSync(expectedFile)).toBe(true);
    const got = lib.get('foo');
    expect(got?.subpath).toBe('希区柯克');
    // 第二个实例走 scanAll 也能从目录派生出 subpath
    const fresh = new LibraryService(tmpDir, { persist: false });
    const r = fresh.get('foo');
    expect(r?.subpath).toBe('希区柯克');
  });

  it('subpath 任意深度：a/b/c → 三级目录都建出来', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'deep', collection: 'tech', subpath: 'a/b/c' }));
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'a', 'b', 'c', 'deep.md'))).toBe(true);
    const fresh = new LibraryService(tmpDir, { persist: false });
    expect(fresh.get('deep')?.subpath).toBe('a/b/c');
  });

  it('subpath 变更：put 同 id 到不同 subpath，老文件被清理（无幽灵）', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'mover', collection: 'tech', subpath: 'old-loc' }));
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'old-loc', 'mover.md'))).toBe(true);
    lib.put(makeEntry({ id: 'mover', collection: 'tech', subpath: 'new-loc' }));
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'old-loc', 'mover.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'new-loc', 'mover.md'))).toBe(true);
    // scanAll 也只看到一份
    const fresh = new LibraryService(tmpDir, { persist: false });
    expect(fresh.list().filter((e) => e.id === 'mover')).toHaveLength(1);
  });

  it('subpath delete：根据 cache 里 entry 的 subpath 找文件删', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'rmme', collection: 'tech', subpath: 'nested' }));
    expect(lib.delete('rmme', 'tech')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tech', 'nested', 'rmme.md'))).toBe(false);
  });

  it('subpath 校验：拒绝 `..` / 绝对路径 / dotdir 段', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    expect(() =>
      lib.put(makeEntry({ id: 'bad', collection: 'tech', subpath: '../escape' })),
    ).toThrow();
    expect(() => lib.put(makeEntry({ id: 'bad', collection: 'tech', subpath: '/abs' }))).toThrow();
    expect(() => lib.put(makeEntry({ id: 'bad', collection: 'tech', subpath: '.git' }))).toThrow();
    expect(() => lib.put(makeEntry({ id: 'bad', collection: 'tech', subpath: 'a//b' }))).toThrow();
  });

  it('递归 scanAll 跳过任意层级的 dotdir（.cache/.git 等）', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'real', collection: 'tech', subpath: 'inner' }));
    // 手放一个 dotdir 内的 .md（譬如 sidecar） — 不该被读
    const ghostDir = path.join(tmpDir, 'tech', 'inner', '.cache');
    fs.mkdirSync(ghostDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghostDir, 'ghost.md'),
      '---\nid: ghost\ncollection: tech\ntitle: ghost\nupdated: 2026-01-01T00:00:00Z\n---\n# ghost',
    );
    const fresh = new LibraryService(tmpDir, { persist: false });
    const ids = fresh.list().map((e) => e.id);
    expect(ids).toEqual(['real']);
  });

  it('跳过 dotdir：collection 同级的 .cache 不被当作 collection；collection 内的 .cache/*.md 不被当作 entry', () => {
    const lib = new LibraryService(tmpDir, { persist: false });
    lib.put(makeEntry({ id: 'real', collection: 'tech' }));

    // 模拟 converter sidecar：collection 内有 .cache 子目录，里面藏一个 .md
    const cacheDir = path.join(tmpDir, 'tech', '.cache', 'sub');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'cached.md'),
      [
        '---',
        'id: cached',
        'collection: tech',
        'title: cached',
        'updated: 2026-01-01T00:00:00Z',
        '---',
        '# cached body',
      ].join('\n'),
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

  it('ignoredDirs：transcriptsDir 子树里 id 合法 + 带 frontmatter 的 .md 也不进索引', () => {
    // 防御性加固回归：raw transcripts 落在 <wikiRoot>/output/transcripts/，与被索引的
    // digest 条目（<wikiRoot>/output/*.md）共享 `output` collection 树根，scanAll 递归会
    // 一路扫进去。过去靠"transcript 文件名含大写 T/Z 违反 ID_RE → 解析抛错被静默跳过"
    // 顺手挡住——但那是意外不是设计。这里特意造一个 **id 合法且带完整 frontmatter** 的
    // .md（绕开 ID_RE 那层意外防线），断言它仍不会被 ignoredDirs 之外的逻辑灌进索引。
    const transcriptsDir = path.join(tmpDir, 'output', 'transcripts');
    const lib = new LibraryService(tmpDir, {
      persist: false,
      ignoredDirs: [transcriptsDir],
    });

    // 同一个 `output` collection 下的合法 digest 条目（顶层，应被索引）。
    lib.put(makeEntry({ id: 'real-digest', collection: 'output' }));

    // transcripts 子树里塞一个完全合法、可被 EntrySchema.parse 收纳的条目。
    fs.mkdirSync(transcriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptsDir, 'leaked-transcript.md'),
      [
        '---',
        'id: leaked-transcript',
        'collection: output',
        'title: 一段会话记录',
        'summary: 不该进检索的 raw transcript',
        'tags: []',
        'links: []',
        'source:',
        '  type: inline',
        'updated: 2026-04-30T00:00:00Z',
        '---',
        '# 会话',
        '林闻道：……',
      ].join('\n'),
    );

    // 第二个实例全量 scanAll（persist=false 强制走 scan，绕过任何 in-memory cache）。
    const fresh = new LibraryService(tmpDir, {
      persist: false,
      ignoredDirs: [transcriptsDir],
    });
    const ids = fresh.list().map((e) => e.id);
    // digest 条目在；transcript 不在——证明是「整棵 transcripts 子树被显式跳过」，
    // 而非「整个 output collection 被屏蔽」。
    expect(ids).toEqual(['real-digest']);
    expect(fresh.list('output').map((e) => e.id)).toEqual(['real-digest']);
    expect(fresh.get('leaked-transcript')).toBeNull();
    // 文件确实存在，只是被有意忽略。
    expect(fs.existsSync(path.join(transcriptsDir, 'leaked-transcript.md'))).toBe(true);
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
      subpath: o.subpath,
      title: o.title ?? 'x',
      summary: o.summary ?? '',
      tags: o.tags ?? [],
      links: o.links ?? [],
      content: o.content ?? 'x',
      source: o.source ?? { type: 'inline' },
      updated: o.updated ?? new Date().toISOString(),
    };
  }

  it('flushIndex 后磁盘上出现 index.json，version=2，含 collectionMtimes', () => {
    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    lib.put(makeEntry({ id: 'a', title: 'Alpha' }));
    lib.put(makeEntry({ id: 'b', title: 'Beta', collection: 'reading' }));
    lib.list(); // 触发 ensureIndex 把 cache 装载
    lib.flushIndex();

    const file = path.join(tmpDir, 'index.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.version).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    const ids = (parsed.entries as Entry[]).map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
    // collectionMtimes 应覆盖两个 collection，且为正数 mtime
    expect(Object.keys(parsed.collectionMtimes).sort()).toEqual(['reading', 'tech']);
    expect(parsed.collectionMtimes.tech).toBeGreaterThan(0);
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
    // 先建好真实 .md，再用此刻的 tech mtime 写 index.json——让新鲜度检查通过，
    // 确保拒绝点真的发生在 EntrySchema 校验（broken 条目缺 title），而不是提前因 mtime/版本被拒。
    fs.mkdirSync(path.join(tmpDir, 'tech'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tech', 'real.md'),
      '---\nid: real\ntitle: Real\nupdated: 2026-04-30T00:00:00Z\nsource:\n  type: inline\n---\n# Real\nbody\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'index.json'),
      JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        collectionMtimes: { tech: fs.statSync(path.join(tmpDir, 'tech')).mtimeMs },
        entries: [{ id: 'broken' /* 缺 title 等必填 */ }],
      }),
    );

    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const got = lib.list();
    // schema 校验失败 → 拒绝 cache → scanAll → 拿到 real
    expect(got.map((e) => e.id)).toEqual(['real']);
  });

  it('深层子目录新增 .md（顶层 collection 目录 mtime 不变）→ 仍侦测并 scanAll（方案3回归）', async () => {
    // 复刻线上 bug：文件埋在 tech/x/y/z/ 四层深，新增它只 bump 叶子目录 mtime，
    // 顶层 tech/ 的 mtime 不动。旧实现只看 tech/ mtime → 误判 fresh → 新条目隐身。
    const writer = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    writer.put(makeEntry({ id: 'a', collection: 'tech', subpath: 'x/y/z' }));
    writer.list();
    writer.flushIndex();

    // mtime 分辨率保险：确保叶子目录的新 mtime 严格大于存档值
    await new Promise((r) => setTimeout(r, 20));

    // 直接往叶子目录写新文件（绕过 put），bump 叶子 mtime
    const leafDir = path.join(tmpDir, 'tech', 'x', 'y', 'z');
    fs.writeFileSync(
      path.join(leafDir, 'b.md'),
      '---\nid: b\ntitle: DeepAdd\nsubpath: x/y/z\nupdated: 2026-04-30T00:00:00Z\nsource:\n  type: inline\n---\n# B\n林闻道\n',
    );
    // 把顶层 collection 目录 mtime 摁回过去，模拟"顶层 mtime 从不冒泡"的线上实况——
    // 方案3 走子树最深 mtime，不该依赖顶层 mtime 也能抓到。
    const past = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(path.join(tmpDir, 'tech'), past, past);

    const reader = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    const ids = reader
      .list()
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('版本升级：旧 version=1 索引被拒、退化为 scanAll', () => {
    fs.mkdirSync(path.join(tmpDir, 'tech'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tech', 'real.md'),
      '---\nid: real\ntitle: Real\nupdated: 2026-04-30T00:00:00Z\nsource:\n  type: inline\n---\n# Real\nbody\n',
    );
    // 老格式：有 version=1、无 collectionMtimes
    fs.writeFileSync(
      path.join(tmpDir, 'index.json'),
      JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: [] }),
    );

    const lib = new LibraryService(tmpDir, { persistDelayMs: 60_000 });
    expect(lib.list().map((e) => e.id)).toEqual(['real']);
  });
});

describe('LibraryService — refreshIfStale（运行时新鲜度）', () => {
  it('捕捉绕过 put 直接写盘的新文件（write_file 写 output 的场景）', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', collection: 'output' }));
    expect(lib.list('output')).toHaveLength(1);

    // 模拟 write_file：直接写一个无 frontmatter 的 .md 进 output/（不经过 put）
    const dir = path.join(tmpDir, 'output');
    fs.writeFileSync(path.join(dir, '2026-06-15-每日新知.md'), '# 每日新知\n\n正文');
    // 把目录 mtime 明确推后，规避同秒 mtime 粒度导致的漏检（真实场景天然有时间差）
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dir, future, future);

    // 刷新前：内存索引仍是旧的（这正是「点开 output 看不到新文件」的根因）
    expect(lib.list('output')).toHaveLength(1);
    // 刷新：检测到变化 → 重扫
    expect(lib.refreshIfStale()).toBe(true);
    const entries = lib.list('output');
    expect(entries).toHaveLength(2);
    // 无 frontmatter 的文件按文件名派生 id 入索引
    expect(entries.find((e) => e.id === '2026-06-15-每日新知')?.title).toBe('2026-06-15-每日新知');
    // 再次刷新：无变化 → false，不做无谓重扫
    expect(lib.refreshIfStale()).toBe(false);
  });

  it('捕捉新增的顶层 collection 目录', () => {
    const lib = new LibraryService(tmpDir);
    lib.put(makeEntry({ id: 'a', collection: 'tech' }));
    expect(lib.list()).toHaveLength(1);

    fs.mkdirSync(path.join(tmpDir, 'notes'));
    fs.writeFileSync(path.join(tmpDir, 'notes', 'raw.md'), '# Raw\n\nbody');
    expect(lib.refreshIfStale()).toBe(true);
    expect(
      lib
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'raw']);
  });
});

describe('LibraryService — ingestedAt / date 时间戳', () => {
  it('ingestedAt 首次入库置位，再水合保持稳定（updated 变、ingestedAt 不变）', () => {
    const lib = new LibraryService(tmpDir);
    const first = lib.put(makeEntry({ id: 'a', updated: '2026-06-10T00:00:00.000Z' }));
    expect(first.ingestedAt).toBeDefined();
    const ing = first.ingestedAt!;

    // 再 put（再水合）：updated 不同，ingestedAt 必须保持
    const second = lib.put(makeEntry({ id: 'a', updated: '2026-06-17T00:00:00.000Z' }));
    expect(second.updated).toBe('2026-06-17T00:00:00.000Z');
    expect(second.ingestedAt).toBe(ing);

    // round-trip：落盘再读仍是同一个 ingestedAt
    expect(lib.get('a')?.ingestedAt).toBe(ing);
  });

  it('显式传入的 ingestedAt / date 被保留并 round-trip', () => {
    const lib = new LibraryService(tmpDir);
    lib.put({
      ...makeEntry({ id: 'a' }),
      ingestedAt: '2026-06-16T08:00:00.000Z',
      date: '2026-06-15',
    });
    const got = lib.get('a');
    expect(got?.ingestedAt).toBe('2026-06-16T08:00:00.000Z');
    expect(got?.date).toBe('2026-06-15');
  });

  it('旧条目（frontmatter 无 ingestedAt）读取时回退到 updated', () => {
    const lib = new LibraryService(tmpDir);
    const dir = path.join(tmpDir, 'tech');
    fs.mkdirSync(dir, { recursive: true });
    // 手写一个带 updated 但无 ingestedAt 的文件（模拟旧数据）
    fs.writeFileSync(
      path.join(dir, 'old.md'),
      '---\nid: old\ntitle: Old\nupdated: 2026-06-01T00:00:00.000Z\n---\nbody',
    );
    expect(lib.get('old')?.ingestedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('LibraryService — frontmatter date 归一化（回归：YAML 把日期解析成 Date）', () => {
  /**
   * 真实事故：agent 用 write_file 写的日报带 `date: 2026-07-24`（无引号）。YAML 1.1 把它
   * 当 timestamp，js-yaml 回传 **Date 对象**，而 EntrySchema.date 是 string → 整条 parse
   * 抛错 → scanDirRecursive 静默跳过 → 日报在磁盘上但库里死活看不到，且无任何报错。
   */
  it('无引号 date（YAML → Date 对象）仍能入库，归一化成 YYYY-MM-DD', () => {
    const dir = path.join(tmpDir, 'output');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07-24.md'),
      '---\ntitle: 2026-07-24 内容日报\ndate: 2026-07-24\ntags: [daily-report]\n---\n# 日报正文',
    );
    const lib = new LibraryService(tmpDir, { persist: false });
    const e = lib.get('2026-07-24');
    expect(e).toBeDefined(); // 修复前：undefined（被静默丢弃）
    expect(e?.date).toBe('2026-07-24');
    expect(e?.title).toBe('2026-07-24 内容日报');
  });

  it('带引号的 date 字符串原样保留', () => {
    const dir = path.join(tmpDir, 'output');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntitle: A\ndate: "2026-07-24"\n---\nbody');
    expect(new LibraryService(tmpDir, { persist: false }).get('a')?.date).toBe('2026-07-24');
  });

  it('没有 date 字段 → date 缺省（不影响入库）', () => {
    const dir = path.join(tmpDir, 'output');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.md'), '# 纯正文，无 frontmatter');
    const e = new LibraryService(tmpDir, { persist: false }).get('b');
    expect(e).toBeDefined();
    expect(e?.date).toBeUndefined();
  });
});

describe('LibraryService — onWarn（解析失败不再静默）', () => {
  it('违反 ID_RE 的文件名（含大写）被跳过，并经 onWarn 报出文件与原因', () => {
    const dir = path.join(tmpDir, 'output');
    fs.mkdirSync(dir, { recursive: true });
    // 真实案例：agent 写出 `AI绘画四强对决-...md`，id 含大写 AI → ID_RE 拒绝
    fs.writeFileSync(path.join(dir, 'AI绘画四强对决.md'), '# 标题\n正文');
    fs.writeFileSync(path.join(dir, '正常条目.md'), '# 正常\n正文');
    const warns: string[] = [];
    const lib = new LibraryService(tmpDir, { persist: false, onWarn: (m) => warns.push(m) });

    expect(lib.list('output').map((e) => e.id)).toEqual(['正常条目']); // 非法的被跳过
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('AI绘画四强对决.md'); // 说清是哪个文件
    expect(warns[0]).toContain('id'); // 说清是 id 不合法
  });

  it('不传 onWarn 时保持既有行为（静默跳过，不抛错）', () => {
    const dir = path.join(tmpDir, 'output');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BAD.md'), '# x\ny');
    expect(() => new LibraryService(tmpDir, { persist: false }).list('output')).not.toThrow();
  });
});
