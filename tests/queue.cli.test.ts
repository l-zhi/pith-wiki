/**
 * CLI queue add --dir / queue retry 回归。
 *
 * --dir 必须按转换器扩展名枚举（与 watcher 同一份 extensions），
 * retry 只重置 dead，非 dead 记入 skipped。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQueueCommands } from '../src/cli/queueCommands.js';
import type { Config } from '../src/config.js';
import { QueueStore } from '../src/wiki/queue/store.js';
import type { QueueJob } from '../src/wiki/queue/state.js';

let tmpDir: string;
let config: Config;
let store: QueueStore;
let exitCode: number | string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-queue-cli-'));
  config = {
    wikiRoot: path.join(tmpDir, 'wiki'),
    workspaceRoot: tmpDir,
    queueStatePath: path.join(tmpDir, 'queue', 'state.json'),
    queueLogDir: path.join(tmpDir, 'queue', 'logs'),
    cacheConverted: false,
    maxToolPayloadBytes: 1_000_000,
    readOnly: false,
    additionalReadPaths: [],
  } as Config;
  store = new QueueStore(config.queueStatePath);
  exitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = exitCode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function job(partial: Pick<QueueJob, 'id' | 'status'>): QueueJob {
  return {
    file: path.join(tmpDir, `${partial.id}.md`),
    collection: 'tech',
    force: false,
    attempts: partial.status === 'dead' ? 3 : 1,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    lastError: partial.status === 'dead' ? 'boom' : undefined,
    ...partial,
  };
}

async function run(argv: string[]): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    const program = new Command();
    program.exitOverride();
    buildQueueCommands(program, { configFor: () => config });
    await program.parseAsync(['node', 'pith-wiki', ...argv]);
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function plain(chunks: string[]): string {
  return chunks.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
}

describe('queue add --dir', () => {
  it('enqueues pdf and txt alongside md, and skips unrelated extensions', async () => {
    const dir = path.join(tmpDir, 'inbox');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'note.md'), '# n\n');
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-1.4\n');
    fs.writeFileSync(path.join(dir, 'nested', 'plain.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'image.png'), 'png\n');

    await run(['queue', 'add', '--collection', 'tech', '--dir', dir]);

    const names = Object.values(store.load().jobs)
      .map((j) => path.basename(j.file))
      .sort();
    expect(names).toEqual(['note.md', 'paper.pdf', 'plain.txt']);
  });
});

describe('queue retry', () => {
  it('resets a dead job and skips a non-dead job', async () => {
    store.mutate((s) => {
      s.jobs.dead1 = job({ id: 'dead1', status: 'dead' });
      s.jobs.run1 = job({ id: 'run1', status: 'running' });
      s.jobs.done1 = job({ id: 'done1', status: 'completed' });
    });

    const { logs, errors } = await run(['queue', 'retry', 'dead1', 'run1', 'done1', 'missing']);

    const state = store.load();
    expect(state.jobs.dead1.status).toBe('pending');
    expect(state.jobs.dead1.attempts).toBe(0);
    expect(state.jobs.run1.status).toBe('running');
    expect(state.jobs.done1.status).toBe('completed');

    const text = plain([...logs, ...errors]);
    expect(text).toMatch(/reset 1/);
    expect(text).toMatch(/skipped:.*run1/);
    expect(text).toMatch(/done1/);
    expect(text).toMatch(/not found:.*missing/);
  });
});
