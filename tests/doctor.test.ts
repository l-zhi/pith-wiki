/**
 * `llm-wiki doctor` 单元测试。
 *
 * 测试策略：每个 case 在 tmpdir 起一个微型 wikiRoot，写最小化的 entry 文件，
 * 跑 `runDoctor`，对返回的结构化 `DoctorReport` 做断言（不依赖人类格式化输出）。
 * 这样测试与终端 chalk 着色 / 文案微调完全解耦。
 *
 * 覆盖五个 check 各至少一条（issue #24 AC）+ clean wiki + JSON shape + 多 collection
 * 隔离一致性。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runDoctor,
  formatDoctorReportJSON,
  ALL_CHECKS,
  type DoctorCheck,
} from '../src/wiki/doctor.js';

/** 用 tmpdir 起一个 wiki 根，给 sandbox 用的 workspaceRoot 用同一根。 */
function makeWiki(): { wikiRoot: string; workspaceRoot: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-doctor-test-'));
  return {
    wikiRoot: dir,
    workspaceRoot: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 写一条 entry 到 `<wikiRoot>/<collection>/<id>.md`。frontmatter 用最小合法集合。 */
function writeEntry(
  wikiRoot: string,
  collection: string,
  id: string,
  overrides: Partial<{
    title: string;
    summary: string;
    tags: string[];
    links: string[];
    source: { type: string; value?: string };
    updated: string;
    content: string;
  }> = {},
): string {
  const dir = path.join(wikiRoot, collection);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  const fm: Record<string, unknown> = {
    id,
    collection,
    title: overrides.title ?? id,
    summary: overrides.summary ?? '',
    tags: overrides.tags ?? [],
    links: overrides.links ?? [],
    source: overrides.source ?? { type: 'unknown' },
    updated: overrides.updated ?? '2026-01-01T00:00:00.000Z',
  };
  // 手写 frontmatter 比用 gray-matter.stringify 更可控（不出意外的 quoting）。
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(overrides.content ?? `body of ${id}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

describe('runDoctor — clean wiki', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('空 wikiRoot → 0 entries, 0 problems', () => {
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.entriesScanned).toBe(0);
    expect(report.summary.problemsFound).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it('两个合法 entry + 一条互链 → 0 problems', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'agent-retry', { links: ['error-handling'] });
    writeEntry(wiki.wikiRoot, 'tech', 'error-handling');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.entriesScanned).toBe(2);
    expect(report.summary.problemsFound).toBe(0);
  });

  it('exit code 语义：clean wiki 的 problemsFound === 0', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    // CLI 层根据这个值决定是否设 process.exitCode = 1。
    expect(report.summary.problemsFound).toBe(0);
  });
});

describe('runDoctor — check 1: frontmatter validation', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('id 含大写字母 → EntrySchema 校验失败，报 error', () => {
    // 故意写一个非法 id（大写违反 ID_RE）。
    const file = path.join(wiki.wikiRoot, 'tech', 'BadId.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `---\nid: "BadId"\ncollection: "tech"\ntitle: "Bad"\nupdated: "2026-01-01T00:00:00.000Z"\n---\nbody\n`,
      'utf8',
    );
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.problemsFound).toBe(1);
    const p = report.problems[0];
    expect(p.check).toBe('frontmatter');
    expect(p.severity).toBe('error');
    expect(p.filePath).toBe(file);
    expect(p.entryId).toBeUndefined(); // parse 失败时 entryId 不可填
    expect(p.detail?.issues).toBeDefined();
  });

  it('YAML 语法直接坏掉 → 报 error（gray-matter 抛错路径）', () => {
    const file = path.join(wiki.wikiRoot, 'tech', 'broken.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 故意写一个不闭合的 frontmatter：`---` 起头但没有 `---` 收尾。
    // 这会让 gray-matter 把整个文件当 body，但 YAML.parse 不会 throw——
    // 改成 YAML 层面的真正坏例子：value 部分有未闭合引号。
    fs.writeFileSync(
      file,
      `---\nid: "unclosed quote\ntitle: x\n---\nbody\n`,
      'utf8',
    );
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    // 要么 gray-matter 直接抛（YAML 语法路径），要么解析出怪东西被 zod 拒（schema 路径）。
    // 两条路径都该产生 frontmatter check 的 error。
    expect(report.summary.byCheck.frontmatter).toBeGreaterThanOrEqual(1);
    expect(report.problems.every((p) => p.severity === 'error')).toBe(true);
  });

  it('frontmatter 错误的 entry 不进入后续 check 的 idIndex', () => {
    // 写一个 id 大写的坏 entry；再写一个正常 entry 引用那个 id。
    // 期望：bad entry 报 frontmatter；good entry 同时报 orphan-link（因为坏 entry 没进 idIndex）。
    const badFile = path.join(wiki.wikiRoot, 'tech', 'BadId.md');
    fs.mkdirSync(path.dirname(badFile), { recursive: true });
    fs.writeFileSync(
      badFile,
      `---\nid: "BadId"\ncollection: "tech"\ntitle: "Bad"\nupdated: "2026-01-01T00:00:00.000Z"\n---\n`,
      'utf8',
    );
    writeEntry(wiki.wikiRoot, 'tech', 'good-entry', { links: ['BadId'] });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck.frontmatter).toBe(1);
    expect(report.summary.byCheck['orphan-link']).toBe(1);
  });
});

describe('runDoctor — check 2: orphan forward links', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('links 指向不存在的 id → 报 warning', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', { links: ['ghost'] });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['orphan-link']).toBe(1);
    const p = report.problems.find((p) => p.check === 'orphan-link');
    expect(p?.severity).toBe('warning');
    expect(p?.entryId).toBe('foo');
    expect(p?.detail?.missingTarget).toBe('ghost');
  });

  it('多个孤儿链接各报一条', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', { links: ['ghost-a', 'ghost-b', 'ghost-c'] });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['orphan-link']).toBe(3);
  });
});

describe('runDoctor — check 3: duplicate IDs across collections', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('同一 id 在两个 collection 出现 → 每个文件各报一条 error', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'shared-id');
    writeEntry(wiki.wikiRoot, 'reading', 'shared-id');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['duplicate-id']).toBe(2);
    const dups = report.problems.filter((p) => p.check === 'duplicate-id');
    expect(dups.every((p) => p.severity === 'error')).toBe(true);
    expect(dups.every((p) => p.entryId === 'shared-id')).toBe(true);
    // 两条 problem 一个来自 tech，一个来自 reading
    const collections = dups.map((p) => p.collection).sort();
    expect(collections).toEqual(['reading', 'tech']);
  });

  it('同 collection 内的同名 id 不报（理论不可能，因为 LibraryService 拒绝）', () => {
    // 这条主要锁定逻辑：检测器只关心"跨 collection"才算 collision。
    // 同一 collection 内只可能有一个文件（LibraryService.put 已拒绝同名），但
    // 即使手工放两个理论上也不该误报为 duplicate-id（同 col 是 LibraryService 的事）。
    writeEntry(wiki.wikiRoot, 'tech', 'foo');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['duplicate-id']).toBe(0);
  });
});

describe('runDoctor — check 4: illegal source paths', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('source.type=file 但 source.value 在沙箱外 → 报 warning', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      source: { type: 'file', value: '/etc/passwd' }, // 沙箱外
    });
    const report = runDoctor({
      wikiRoot: wiki.wikiRoot,
      sandbox: { workspaceRoot: wiki.workspaceRoot },
    });
    expect(report.summary.byCheck['illegal-source']).toBe(1);
    const p = report.problems.find((p) => p.check === 'illegal-source');
    expect(p?.severity).toBe('warning');
    expect(p?.entryId).toBe('foo');
  });

  it('source.type=url 不触发该 check（只检查 file 源）', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      source: { type: 'url', value: 'https://example.com/no-such-thing' },
    });
    const report = runDoctor({
      wikiRoot: wiki.wikiRoot,
      sandbox: { workspaceRoot: wiki.workspaceRoot },
    });
    expect(report.summary.byCheck['illegal-source']).toBe(0);
  });

  it('没传 sandbox 选项 → check 静默跳过', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      source: { type: 'file', value: '/etc/passwd' },
    });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['illegal-source']).toBe(0);
  });
});

describe('runDoctor — check 5: dangling [[concept-id]] mentions', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('正文里 [[ghost]] 但库里没有 ghost → 报 warning (reason: target-missing)', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      content: '看这里有个概念 [[ghost]] 不存在',
    });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['dangling-concept']).toBe(1);
    const p = report.problems.find((p) => p.check === 'dangling-concept');
    expect(p?.detail?.reason).toBe('target-missing');
    expect(p?.detail?.target).toBe('ghost');
  });

  it('正文 [[bar]] 存在但不在 links 字段 → 报 warning (reason: not-in-links)', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      content: '提到 [[bar]] 但忘了登记',
      // 故意不放 bar 进 links
    });
    writeEntry(wiki.wikiRoot, 'tech', 'bar');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['dangling-concept']).toBe(1);
    const p = report.problems.find((p) => p.check === 'dangling-concept');
    expect(p?.detail?.reason).toBe('not-in-links');
    expect(p?.detail?.target).toBe('bar');
  });

  it('同一 [[id]] 在正文里重复出现只报一次', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      content: 'first [[bar]], second [[bar]], third [[bar]]',
    });
    writeEntry(wiki.wikiRoot, 'tech', 'bar');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.byCheck['dangling-concept']).toBe(1);
  });

  it('[[bar]] 既在库又在 links → 0 problem', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      content: '正经引用 [[bar]]',
      links: ['bar'],
    });
    writeEntry(wiki.wikiRoot, 'tech', 'bar');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.problemsFound).toBe(0);
  });

  it('[[bar|display text]] 取的 target 是 bar（pipe 后面是显示文本）', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', {
      content: '用 [[bar|这个名字显示]] 的方式',
      links: ['bar'],
    });
    writeEntry(wiki.wikiRoot, 'tech', 'bar');
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    expect(report.summary.problemsFound).toBe(0);
  });
});

describe('runDoctor — checks 过滤', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('指定 checks=[orphan-link] 只跑那一项，孤儿链接报，其它不报', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'a', { links: ['ghost'], content: '[[also-ghost]]' });
    // 同时埋一个 dangling-concept 也会触发，确认 filter 生效。
    const filtered: DoctorCheck[] = ['orphan-link'];
    const report = runDoctor({ wikiRoot: wiki.wikiRoot, checks: filtered });
    expect(report.summary.byCheck['orphan-link']).toBe(1);
    expect(report.summary.byCheck['dangling-concept']).toBe(0);
  });
});

describe('formatDoctorReportJSON — JSON shape contract', () => {
  let wiki: ReturnType<typeof makeWiki>;
  beforeEach(() => {
    wiki = makeWiki();
  });
  afterEach(() => wiki.cleanup());

  it('输出是 valid JSON 且包含完整 summary + problems 字段', () => {
    writeEntry(wiki.wikiRoot, 'tech', 'foo', { links: ['ghost'] });
    const report = runDoctor({ wikiRoot: wiki.wikiRoot });
    const json = formatDoctorReportJSON(report);
    const parsed = JSON.parse(json);
    // summary 结构
    expect(parsed.summary.entriesScanned).toBe(1);
    expect(parsed.summary.problemsFound).toBe(1);
    expect(parsed.summary.bySeverity).toEqual({ error: 0, warning: 1 });
    expect(parsed.summary.byCheck).toMatchObject({
      frontmatter: 0,
      'orphan-link': 1,
      'duplicate-id': 0,
      'illegal-source': 0,
      'dangling-concept': 0,
    });
    // problems 数组每条带 severity / check / filePath / message / suggestion
    expect(Array.isArray(parsed.problems)).toBe(true);
    expect(parsed.problems[0]).toMatchObject({
      severity: 'warning',
      check: 'orphan-link',
      entryId: 'foo',
      message: expect.any(String),
      suggestion: expect.any(String),
    });
  });

  it('ALL_CHECKS 排序稳定（导出契约，README 文档可以依赖）', () => {
    expect([...ALL_CHECKS]).toEqual([
      'frontmatter',
      'orphan-link',
      'duplicate-id',
      'illegal-source',
      'dangling-concept',
    ]);
  });
});
