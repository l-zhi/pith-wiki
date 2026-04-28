/**
 * BatchIngestService 单元测试。
 *
 * 通过 stub 一个假的 HydrationService，避免任何真实 LLM 调用。
 *
 * 关注外部行为：
 *   - 去重（path 匹配 + --force 覆盖）
 *   - id 冲突自动追加 -2 / -3 后缀
 *   - 429 指数退避重试 ≤ 3 次
 *   - 非 429 错误立即失败
 *   - 退出码不在本模块范围（subcommands.ts 测；这里只看 summary 计数）
 *   - linkCandidates 一次 snapshot 不每文件 list
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../src/wiki/library.js';
import type { HydrationService, HydrateInput } from '../src/wiki/hydration.js';
import type { Entry } from '../src/wiki/types.js';
import { runBatch } from '../src/wiki/batch.js';

let tmpDir: string;
let library: LibraryService;
let logs: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-batch-'));
  library = new LibraryService(tmpDir);
  logs = [];
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** 在临时目录里造一个有内容的 .md 文件，返回绝对路径。 */
function makeFile(name: string, content = `content of ${name}`): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/**
 * 假 hydrator：把每次调用的 input 收集起来，按调用序号或文件名给 id。
 * 调用方可以通过 makeFakeHydrator(...) 配置失败/返回 id 等。
 */
interface FakeHydrator {
  hydrator: HydrationService;
  /** 每次 hydrate 调用的入参，按调用顺序记录。 */
  calls: HydrateInput[];
}

interface FakeOpts {
  /** 自定义 id 生成；默认按 filename basename 去后缀。 */
  idFor?: (input: HydrateInput, callIndex: number) => string;
  /** 抛出的错误；返回 null 表示这次成功。多次调用可以让前几次失败、后面成功。 */
  errorFor?: (input: HydrateInput, callIndex: number) => unknown | null;
  /** 模拟 LLM 延迟（毫秒）。 */
  delayMs?: number;
}

function makeFakeHydrator(opts: FakeOpts = {}): FakeHydrator {
  const calls: HydrateInput[] = [];
  let callIndex = 0;
  const hydrator = {
    hydrate: async (input: HydrateInput): Promise<Entry> => {
      const idx = callIndex++;
      calls.push(input);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const err = opts.errorFor?.(input, idx);
      if (err) throw err;
      const id =
        opts.idFor?.(input, idx) ??
        path.basename(input.source.value ?? `entry-${idx}`, '.md');
      const entry: Entry = {
        id,
        collection: input.collectionId,
        title: id,
        summary: '',
        tags: [],
        links: [],
        content: `# ${id}\n\nfake content`,
        source: input.source,
        updated: new Date().toISOString(),
      };
      return entry;
    },
  } as unknown as HydrationService;
  return { hydrator, calls };
}

describe('runBatch — 基础流程', () => {
  it('空 files 数组返回 0 计数（不调 hydrator）', async () => {
    const { hydrator, calls } = makeFakeHydrator();
    const r = await runBatch({
      files: [],
      collection: 'tech',
      force: false,
      concurrency: 3,
      hydrator,
      library,
      log: (line) => logs.push(line),
    });
    expect(r.ok).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('多个不冲突文件全部入库，counts 正确', async () => {
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')];
    const { hydrator } = makeFakeHydrator();

    const r = await runBatch({
      files,
      collection: 'tech',
      force: false,
      concurrency: 2,
      hydrator,
      library,
      log: (line) => logs.push(line),
    });

    expect(r.ok).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(library.list('tech').map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('每条 result 含正确 file / id / attempts 字段', async () => {
    const files = [makeFile('alpha.md')];
    const { hydrator } = makeFakeHydrator();

    const r = await runBatch({
      files,
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.results).toHaveLength(1);
    expect(r.results[0].file).toBe(files[0]);
    expect(r.results[0].status).toBe('ok');
    expect(r.results[0].id).toBe('alpha');
    expect(r.results[0].attempts).toBe(1);
  });
});

describe('runBatch — 去重', () => {
  it('已存在的 source.value（绝对路径）默认被跳过', async () => {
    const file = makeFile('existing.md');
    // 先手工 put 一条，模拟之前 ingest 过的状态。
    library.put({
      id: 'existing',
      collection: 'tech',
      title: 'existing',
      summary: '',
      tags: [],
      links: [],
      content: 'old',
      source: { type: 'file', value: file }, // 绝对路径
      updated: new Date().toISOString(),
    });

    const { hydrator, calls } = makeFakeHydrator();
    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    // 跳过，hydrator 不被调用。
    expect(r.skipped).toBe(1);
    expect(r.ok).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.results[0].reason).toContain('already ingested');
    expect(r.results[0].id).toBe('existing');
  });

  it('--force=true 时即使已存在也重新 hydrate 并覆盖', async () => {
    const file = makeFile('existing.md');
    library.put({
      id: 'existing',
      collection: 'tech',
      title: 'old version',
      summary: '',
      tags: [],
      links: [],
      content: '原始内容',
      source: { type: 'file', value: file },
      updated: new Date(0).toISOString(),
    });

    const { hydrator, calls } = makeFakeHydrator({
      idFor: () => 'existing',
    });
    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: true,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.ok).toBe(1);
    expect(r.skipped).toBe(0);
    expect(calls).toHaveLength(1); // hydrator 被调了一次
    // 落盘后的 entry 是新版本（title 变了）
    expect(library.get('existing')!.title).toBe('existing');
  });

  it('v0.1 时代相对路径 source.value 也能匹配（兼容性）', async () => {
    // 假装老 entry 用相对路径写的，但绝对化后等于待入库文件路径。
    const file = makeFile('legacy.md');
    const relativeValue = path.relative(process.cwd(), file);
    library.put({
      id: 'legacy',
      collection: 'tech',
      title: 'legacy',
      summary: '',
      tags: [],
      links: [],
      content: 'x',
      source: { type: 'file', value: relativeValue }, // 相对路径
      updated: new Date().toISOString(),
    });

    const { hydrator, calls } = makeFakeHydrator();
    const r = await runBatch({
      files: [file], // 绝对路径
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('runBatch — id 冲突', () => {
  it('两个不同源文件返回同一 id 时，第二个自动加 -2 后缀', async () => {
    const fileA = makeFile('one.md');
    const fileB = makeFile('two.md');

    // 让 hydrator 对两个文件都返回 id="agent-design"。
    const { hydrator } = makeFakeHydrator({
      idFor: () => 'agent-design',
    });

    // 用并发 1 强制顺序，让冲突逻辑可预测断言。
    const r = await runBatch({
      files: [fileA, fileB],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.ok).toBe(2);
    const ids = r.results.map((x) => x.id).sort();
    expect(ids).toEqual(['agent-design', 'agent-design-2']);
    // 落盘也确实是两条独立条目。
    expect(library.list('tech').map((e) => e.id).sort()).toEqual([
      'agent-design',
      'agent-design-2',
    ]);
  });

  it('与 collection 中已有 id 冲突时也走后缀路径', async () => {
    const file = makeFile('conflicts.md');
    // 预置一条 id=foo 的 entry。
    library.put({
      id: 'foo',
      collection: 'tech',
      title: 'foo',
      summary: '',
      tags: [],
      links: [],
      content: 'x',
      source: { type: 'inline' }, // 不带路径，避免被去重
      updated: new Date().toISOString(),
    });

    const { hydrator } = makeFakeHydrator({ idFor: () => 'foo' });
    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.ok).toBe(1);
    expect(r.results[0].id).toBe('foo-2');
  });
});

describe('runBatch — 错误处理', () => {
  it('429 错误自动重试 ≤ 3 次，最终成功', async () => {
    const file = makeFile('flaky.md');
    let count = 0;
    const { hydrator } = makeFakeHydrator({
      errorFor: () => {
        count += 1;
        // 前两次抛 429，第三次成功。
        if (count <= 2) {
          const err = new Error('rate limited') as Error & { status?: number };
          err.status = 429;
          return err;
        }
        return null;
      },
    });

    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.ok).toBe(1);
    expect(r.results[0].attempts).toBe(3); // 1 + 2 retry
    expect(count).toBe(3);
  }, 15_000); // 退避 1s + 2s 累积，给宽松超时

  it('非 429 错误立即失败（不重试）', async () => {
    const file = makeFile('bad.md');
    const { hydrator, calls } = makeFakeHydrator({
      errorFor: () => {
        const err = new Error('JSON invalid') as Error & { status?: number };
        err.status = 500;
        return err;
      },
    });

    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.failed).toBe(1);
    expect(calls).toHaveLength(1); // 只调了一次，没有重试
    expect(r.results[0].reason).toContain('JSON invalid');
  });

  it('429 重试用尽后归类为 failed', async () => {
    const file = makeFile('always-429.md');
    const { hydrator } = makeFakeHydrator({
      errorFor: () => {
        const err = new Error('still rate limited') as Error & { status?: number };
        err.status = 429;
        return err;
      },
    });

    const r = await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.failed).toBe(1);
    expect(r.results[0].attempts).toBe(4); // 1 + 3 retry
  }, 30_000); // 1s + 2s + 4s 退避

  it('混合：3 个 ok + 1 个 fail，counts 正确', async () => {
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('bad.md'), makeFile('c.md')];
    const { hydrator } = makeFakeHydrator({
      errorFor: (input) => {
        if (input.source.value?.endsWith('bad.md')) {
          return new Error('intentional fail');
        }
        return null;
      },
    });

    const r = await runBatch({
      files,
      collection: 'tech',
      force: false,
      concurrency: 2,
      hydrator,
      library,
      log: () => {},
    });

    expect(r.ok).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);
  });
});

describe('runBatch — linkCandidates snapshot 模式', () => {
  it('hydrator 收到的 linkCandidates 是批次开始前的 snapshot', async () => {
    // 预置 1 条已存在的 entry。
    library.put({
      id: 'pre-existing',
      collection: 'tech',
      title: 'pre',
      summary: 'pre summary',
      tags: [],
      links: [],
      content: 'x',
      source: { type: 'inline' },
      updated: new Date().toISOString(),
    });

    const files = [makeFile('a.md'), makeFile('b.md')];
    const { hydrator, calls } = makeFakeHydrator();

    await runBatch({
      files,
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    // 两个文件的 hydrate 调用都应该收到同一个 snapshot
    // （即只包含 pre-existing，不包含批次内刚刚 put 的 a/b）。
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.linkCandidates).toBeDefined();
      const ids = c.linkCandidates!.map((e) => e.id);
      expect(ids).toContain('pre-existing');
      // 关键：snapshot 不会包含同批次正在写入的兄弟
      expect(ids).not.toContain('a');
      expect(ids).not.toContain('b');
    }
  });

  it('hydrator 收到 filenameHint = basename', async () => {
    const file = makeFile('agent-retry-policy.md');
    const { hydrator, calls } = makeFakeHydrator();

    await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: () => {},
    });

    expect(calls[0].filenameHint).toBe('agent-retry-policy.md');
  });
});

describe('runBatch — 日志', () => {
  it('每个文件完成时输出一条 [N/Total] 格式日志', async () => {
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')];
    const { hydrator } = makeFakeHydrator();
    const seen: string[] = [];

    await runBatch({
      files,
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: (line) => seen.push(line),
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('[1/3]');
    expect(seen[1]).toContain('[2/3]');
    expect(seen[2]).toContain('[3/3]');
    for (const line of seen) expect(line).toContain('✓ ingested');
  });

  it('skipped 条目用 ⊘ 标记', async () => {
    const file = makeFile('exists.md');
    library.put({
      id: 'exists',
      collection: 'tech',
      title: 'x',
      summary: '',
      tags: [],
      links: [],
      content: 'x',
      source: { type: 'file', value: file },
      updated: new Date().toISOString(),
    });

    const { hydrator } = makeFakeHydrator();
    const seen: string[] = [];

    await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: (line) => seen.push(line),
    });

    expect(seen[0]).toContain('⊘ skipped');
  });

  it('failed 条目用 ✗ 标记 + 包含 reason', async () => {
    const file = makeFile('fail.md');
    const { hydrator } = makeFakeHydrator({
      errorFor: () => new Error('boom'),
    });
    const seen: string[] = [];

    await runBatch({
      files: [file],
      collection: 'tech',
      force: false,
      concurrency: 1,
      hydrator,
      library,
      log: (line) => seen.push(line),
    });

    expect(seen[0]).toContain('✗ failed');
    expect(seen[0]).toContain('boom');
  });
});
