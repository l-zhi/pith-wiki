import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { ScheduledOutputArchive } from '../src/schedule/output.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleStore } from '../src/schedule/store.js';
import { LibraryService } from '../src/wiki/library.js';
import { ContextAssembler } from '../src/wiki/assembler.js';
import { writeFileTool } from '../src/tools/write_file.js';
import { wikiIngestTool } from '../src/tools/wiki_ingest.js';
import type { ToolContext } from '../src/tools/index.js';

let dir: string;
let library: LibraryService;
const task = { taskId: 'daily', subpath: '日报' };
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-output-')));
  library = new LibraryService(dir, {
    persist: false,
    ignoredDirs: [path.join(dir, 'output/transcripts')],
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(relative: string, text: string): string {
  const file = path.join(dir, 'output', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function context(): ToolContext {
  return {
    config: { wikiRoot: dir, workspaceRoot: dir, maxToolPayloadBytes: 100_000, readOnly: false },
    library,
    scheduledOutput: task,
    origin: 'scheduled',
  } as unknown as ToolContext;
}

describe('scheduled output', () => {
  it('native write_file confines legacy and relative paths to the task folder; rejects traversal', async () => {
    for (const input of [
      '2026-09-04.md',
      'output/2026-09-04.md',
      'output/日报/2026-09-04.md',
      path.join(dir, 'output/2026-09-04.md'),
    ]) {
      const r = await writeFileTool.handler(
        { path: input, content: '# 项目账本\n\n可检索的全文。' },
        context(),
      );
      expect(r).toMatchObject({ ok: true, path: path.join(dir, 'output/日报/2026-09-04.md') });
    }
    expect(
      await writeFileTool.handler({ path: '../other.md', content: 'x' }, context()),
    ).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(dir, 'output/2026-09-04.md'))).toBe(false);
  });

  it('archives a delegated legacy path and immediately retrieves it after reloading the persisted index', () => {
    library = new LibraryService(dir);
    const archive = new ScheduledOutputArchive(library, task);
    const file = write('2026-09-04.md', '# 项目账本\n\n核对工作项闭环进度。');
    const other = write('manual.md', '无关的并发对话产物');
    const result = archive.finish(`[日报](${file})`);
    expect(result.moved.get(file)).toBe(path.join(dir, 'output/日报/2026-09-04.md'));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    const reloaded = new LibraryService(dir);
    expect(reloaded.get('2026-09-04', 'output')).toMatchObject({
      title: '项目账本',
      subpath: '日报',
      scheduledTaskId: 'daily',
      tags: ['scheduled'],
      content: '# 项目账本\n\n核对工作项闭环进度。',
    });
    expect(new ContextAssembler(reloaded).query('项目账本').referencedEntries).toContain(
      '2026-09-04',
    );
  });

  it('two tasks with the same date filename keep separate globally retrievable entries', () => {
    const a = new ScheduledOutputArchive(library, task);
    write('日报/2026-09-04.md', '# 工作进度\n\n第一份');
    a.finish('完成');
    const b = new ScheduledOutputArchive(library, { taskId: 'weekly', subpath: '周报' });
    write('周报/2026-09-04.md', '# 阅读进度\n\n第二份');
    b.finish('完成');
    const entries = library.list('output');
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    for (const entry of entries)
      expect(library.get(entry.id, 'output')?.content).toBe(entry.content);
    expect(new ContextAssembler(library).query('阅读进度').references[0].title).toBe('阅读进度');
  });

  it('normalizes invalid Markdown filenames and archives plain-text replies without an LLM', () => {
    const archive = new ScheduledOutputArchive(library, task);
    write('日报/My Report.md', '# 学习进度\n\n保留全文');
    archive.finish('完成');
    expect(library.get('my-report')?.title).toBe('学习进度');
    const next = new ScheduledOutputArchive(library, { ...task, firedAt: '2026-09-03T02:00:00Z' });
    next.finish('昨天的阅读笔记：系统思考。');
    expect(library.get('2026-09-03')?.content).toContain('系统思考');
  });

  it('migration preserves entry ids and both files when the target name already exists', () => {
    write('日报/report.md', '# 已有归档');
    const file = write('report.md', '# 另一份日报');
    library.rebuildIndex();
    const archive = new ScheduledOutputArchive(library, task);
    archive.archiveFiles([file]);
    expect(fs.readFileSync(path.join(dir, 'output/日报/report.md'), 'utf8')).toBe('# 已有归档');
    expect(library.list('output')).toHaveLength(2);
  });

  it('archives only changed output and excludes transcripts and symlinks', () => {
    const original = write('old.md', '# 旧资料');
    const archive = new ScheduledOutputArchive(library, task);
    write('transcripts/session.md', '# 原始记录');
    fs.symlinkSync(path.join(dir, 'output/transcripts'), path.join(dir, 'output/linked'));
    archive.finish(`引用旧资料 ${original}`);
    expect(fs.existsSync(original)).toBe(true);
    expect(library.list().some((e) => e.content === '# 原始记录')).toBe(false);
    expect(fs.existsSync(path.join(dir, 'output/日报/session.md'))).toBe(false);
  });

  it('wiki_ingest uses the same task folder and keeps equal hydrated ids from different tasks distinct', async () => {
    const ctx = context();
    ctx.hydrator = {
      hydrate: async () => ({
        id: 'report',
        title: '日报',
        collection: 'elsewhere',
        tags: [],
        links: [],
        content: '正文',
        source: { type: 'inline' },
        updated: new Date().toISOString(),
      }),
    } as unknown as ToolContext['hydrator'];
    const args = {
      collection: 'elsewhere',
      raw_content: '正文',
      source_type: 'inline' as const,
      auto_link: false,
    };
    await wikiIngestTool.handler(args, ctx);
    await wikiIngestTool.handler(args, {
      ...ctx,
      scheduledOutput: { taskId: 'weekly', subpath: '周报' },
    });
    expect(
      library
        .list('output')
        .map((e) => e.subpath)
        .sort(),
    ).toEqual(['周报', '日报']);
    expect(library.list('elsewhere')).toEqual([]);
    expect(
      await wikiIngestTool.handler(args, { ...ctx, config: { ...ctx.config, readOnly: true } }),
    ).toMatchObject({ ok: false });
  });
});

describe('stable task directories', () => {
  it('assigns separate folders for equal titles and preserves the folder after rename', () => {
    const service = new ScheduleService(new ScheduleStore(path.join(dir, 'schedule.json')));
    const input = {
      input: '生成日报',
      title: '日报',
      schedule: { kind: 'once' as const, at: '2026-09-05T10:00:00Z' },
    };
    const a = service.create(input);
    const b = service.create(input);
    expect(a.outputSubpath).toBe('日报');
    expect(b.outputSubpath).toBe('日报-2');
    service.update(a.id, { title: '新标题' });
    expect(service.ensureOutputSubpath(a.id)).toBe('日报');
  });
});
