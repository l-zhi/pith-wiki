/**
 * `@`-mention 解析 / 过滤 / 补全单测（src/cli/mentions.ts）。
 *
 * 关注纯函数行为，不碰 Ink。用一个轻量 fake library（只实现 list()）喂候选。
 */
import { describe, expect, it } from 'vitest';
import {
  activeMention,
  ascendValue,
  buildMentionCandidates,
  buildMentionTree,
  completeMention,
  confirmDirValue,
  confirmEntryValue,
  descendValue,
  filterMentions,
  listLevel,
  parseMentionInput,
  parseScope,
  type MentionCandidate,
} from '../src/cli/mentions.js';
import type { Entry } from '../src/wiki/types.js';
import type { LibraryService } from '../src/wiki/library.js';

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    ...(o.subpath ? { subpath: o.subpath } : {}),
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? 'x',
    source: { type: 'inline' },
    updated: '2026-01-01T00:00:00.000Z',
  };
}

/** 只需 list()，用 as 缩到 LibraryService 形状。 */
function fakeLib(entries: Entry[]): LibraryService {
  return { list: () => entries } as unknown as LibraryService;
}

describe('buildMentionCandidates', () => {
  it('集合在前（带尾斜杠 + 计数），条目在后', () => {
    const lib = fakeLib([
      entry({ id: '死了么app-复盘', collection: '技术相关', title: '死了么复盘' }),
      entry({ id: 'agent-loop', collection: '技术相关', title: 'Agent Loop' }),
      entry({ id: '成长与低谷期', collection: '生活', title: '成长反思' }),
    ]);
    const cands = buildMentionCandidates(lib);
    const collections = cands.filter((c) => c.kind === 'collection');
    const entries = cands.filter((c) => c.kind === 'entry');
    // 集合排在条目前
    expect(cands.indexOf(collections[0])).toBeLessThan(cands.indexOf(entries[0]));
    expect(collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: '技术相关/', count: 2 }),
        expect.objectContaining({ token: '生活/', count: 1 }),
      ]),
    );
    expect(entries.map((e) => e.token)).toEqual(
      expect.arrayContaining(['死了么app-复盘', 'agent-loop', '成长与低谷期']),
    );
  });
});

describe('activeMention', () => {
  it('行尾正在输入 @ 时返回 partial', () => {
    expect(activeMention('@tec')).toBe('tec');
    expect(activeMention('总结 @死了')).toBe('死了');
    expect(activeMention('@')).toBe('');
  });
  it('@ 后出现空白即结束（不再是输入态）', () => {
    expect(activeMention('@技术相关/ 总结')).toBeNull();
    expect(activeMention('hello world')).toBeNull();
  });
  it('多个 @ 时取最后一个', () => {
    expect(activeMention('@a/ @b')).toBe('b');
  });
});

describe('filterMentions', () => {
  const cands: MentionCandidate[] = [
    { kind: 'collection', token: '技术相关/', label: '技术相关', count: 3 },
    { kind: 'entry', token: 'agent-loop', label: 'Agent Loop', collection: '技术相关' },
    { kind: 'entry', token: 'db-mvcc', label: 'MVCC 并发', collection: '技术相关' },
  ];
  it('对 token/label/collection 做大小写无关子串匹配', () => {
    expect(filterMentions(cands, 'agent').map((c) => c.token)).toEqual(['agent-loop']);
    expect(filterMentions(cands, 'AGENT').map((c) => c.token)).toEqual(['agent-loop']);
    // collection 名命中两条条目 + 集合本身
    expect(filterMentions(cands, '技术').length).toBe(3);
  });
  it('空 partial 返回前 limit 条', () => {
    expect(filterMentions(cands, '', 2).length).toBe(2);
  });
  it('limit 上限生效', () => {
    const many: MentionCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'entry',
      token: `e-${i}`,
      label: `t${i}`,
      collection: 'c',
    }));
    expect(filterMentions(many, 'e-', 8).length).toBe(8);
  });
});

describe('completeMention', () => {
  it('把末尾 @partial 替换成规范 token 并补空格', () => {
    expect(
      completeMention('@tec', { kind: 'collection', token: '技术相关/', label: '技术相关', count: 3 }),
    ).toBe('@技术相关/ ');
    expect(
      completeMention('总结一下 @age', {
        kind: 'entry',
        token: 'agent-loop',
        label: 'Agent Loop',
        collection: '技术相关',
      }),
    ).toBe('总结一下 @agent-loop ');
  });
});

describe('parseScope', () => {
  const cands: MentionCandidate[] = [
    { kind: 'collection', token: '技术相关/', label: '技术相关', count: 3 },
    { kind: 'collection', token: '生活/', label: '生活', count: 1 },
    { kind: 'entry', token: 'agent-loop', label: 'Agent Loop', collection: '技术相关' },
    { kind: 'entry', token: '成长与低谷期', label: '成长反思', collection: '生活' },
  ];

  it('尾斜杠 → 集合（去掉斜杠）；裸 token → 条目 id', () => {
    expect(parseScope('@技术相关/ 总结主题', cands)).toEqual({
      collections: ['技术相关'],
      entryIds: [],
    });
    expect(parseScope('@agent-loop 它讲了啥', cands)).toEqual({
      collections: [],
      entryIds: ['agent-loop'],
    });
  });

  it('多 mention 并集（集合 + 条目混合）', () => {
    const s = parseScope('@技术相关/ @成长与低谷期 对比', cands);
    expect(s?.collections).toEqual(['技术相关']);
    expect(s?.entryIds).toEqual(['成长与低谷期']);
  });

  it('未知 token 被忽略（当普通文本，不报错、不收窄）', () => {
    expect(parseScope('@不存在的目录/ @ghost-id hi', cands)).toBeNull();
    expect(parseScope('普通问题没有 mention', cands)).toBeNull();
  });

  it('裸集合名（无尾斜杠）不被当集合（只认尾斜杠的集合语法）', () => {
    // "@技术相关" 无尾斜杠、也不是条目 id → 忽略
    expect(parseScope('@技术相关 总结', cands)).toBeNull();
  });
});

describe('目录树导航 — buildMentionTree / listLevel', () => {
  const lib = fakeLib([
    entry({ id: 'agent-loop', collection: '技术相关', title: 'Agent Loop' }),
    entry({ id: 'db-mvcc', collection: '技术相关', subpath: '数据库', title: 'MVCC' }),
    entry({ id: 'pg-wal', collection: '技术相关', subpath: '数据库', title: 'WAL' }),
    entry({ id: '成长与低谷期', collection: '生活', title: '成长反思' }),
  ]);

  it('根层列出集合目录（带子树计数）', () => {
    const tree = buildMentionTree(lib);
    const items = listLevel(tree, []);
    const dirs = items.filter((i) => i.kind === 'dir');
    expect(dirs.map((d) => d.segment)).toEqual(['技术相关', '生活']);
    expect(dirs.find((d) => d.segment === '技术相关')?.count).toBe(3); // 含子目录里的 2 条
  });

  it('进入集合后列出其直属条目 + 子目录', () => {
    const tree = buildMentionTree(lib);
    const items = listLevel(tree, ['技术相关']);
    // 子目录 数据库（dir）+ 直属条目 agent-loop（entry）
    expect(items.find((i) => i.kind === 'dir' && i.segment === '数据库')).toBeTruthy();
    expect(items.find((i) => i.kind === 'entry' && i.segment === 'agent-loop')).toBeTruthy();
    expect(items.find((i) => i.segment === 'db-mvcc')).toBeUndefined(); // 在子目录里，本层不显示
  });

  it('进入子目录后列出叶子条目', () => {
    const tree = buildMentionTree(lib);
    const items = listLevel(tree, ['技术相关', '数据库']);
    expect(items.map((i) => i.segment).sort()).toEqual(['db-mvcc', 'pg-wal']);
  });

  it('partial 过滤当前层', () => {
    const tree = buildMentionTree(lib);
    expect(listLevel(tree, ['技术相关'], 'agent').map((i) => i.segment)).toEqual(['agent-loop']);
  });

  it('不存在的路径返回空', () => {
    const tree = buildMentionTree(lib);
    expect(listLevel(tree, ['不存在'])).toEqual([]);
  });
});

describe('parseMentionInput — 路径段 / partial 拆分', () => {
  it('根层正在输入', () => {
    expect(parseMentionInput('@技')).toEqual({ pathSegs: [], partial: '技' });
  });
  it('已进入一层目录', () => {
    expect(parseMentionInput('@技术相关/')).toEqual({ pathSegs: ['技术相关'], partial: '' });
    expect(parseMentionInput('@技术相关/age')).toEqual({ pathSegs: ['技术相关'], partial: 'age' });
  });
  it('多层目录', () => {
    expect(parseMentionInput('@技术相关/数据库/m')).toEqual({
      pathSegs: ['技术相关', '数据库'],
      partial: 'm',
    });
  });
  it('slash 命令 / 非 mention 返回 null', () => {
    expect(parseMentionInput('/help')).toBeNull();
    expect(parseMentionInput('普通文本')).toBeNull();
    expect(parseMentionInput('@已完成/ 文本')).toBeNull(); // 含空格，已离开 mention
  });
});

describe('导航值改写 — descend / ascend / confirm', () => {
  it('descend：进入目录，无尾空格（picker 继续）', () => {
    expect(descendValue('@技', [], '技术相关')).toBe('@技术相关/');
    expect(descendValue('@技术相关/数', ['技术相关'], '数据库')).toBe('@技术相关/数据库/');
  });
  it('ascend：退回上一层', () => {
    expect(ascendValue('@技术相关/数据库/', ['技术相关', '数据库'])).toBe('@技术相关/');
    expect(ascendValue('@技术相关/', ['技术相关'])).toBe('@');
  });
  it('confirmDir：集合 scope，尾空格关闭 picker', () => {
    expect(confirmDirValue('@技', [], '技术相关')).toBe('@技术相关/ ');
  });
  it('confirmEntry：插入裸 @id，丢弃路径前缀，尾空格关闭 picker', () => {
    expect(confirmEntryValue('@技术相关/age', 'agent-loop')).toBe('@agent-loop ');
  });
  it('改写保留 mention 之前的正文', () => {
    expect(descendValue('总结一下 @技', [], '技术相关')).toBe('总结一下 @技术相关/');
    expect(confirmEntryValue('对比 @技术相关/db', 'db-mvcc')).toBe('对比 @db-mvcc ');
  });
});
