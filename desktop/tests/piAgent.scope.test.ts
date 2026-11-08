/**
 * pi 委托把非空 scope 拼进送出的 prompt（复用 pi-core 的 buildScopePreamble）。
 * 空 scope 不读库、不加 preamble。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAgent } from '../src/engine/piAgent.js';
import { LibraryService } from '@core/wiki/library.js';
import type { Entry } from '@core/wiki/types.js';
import type { ScopeDTO } from '../src/shared/protocol.js';

const dirs: string[] = [];
const envKeys = ['PITH_WIKI_CONFIG_PATH', 'PITH_WIKI_ROOT'] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of envKeys) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  savedEnv.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function rememberEnv(): void {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-pi-scope-'));
  dirs.push(dir);
  return dir;
}

function entry(o: Partial<Entry>): Entry {
  return {
    id: o.id ?? 'x',
    collection: o.collection ?? 'tech',
    subpath: o.subpath,
    title: o.title ?? 'x',
    summary: o.summary ?? '',
    tags: o.tags ?? [],
    links: o.links ?? [],
    content: o.content ?? 'x',
    source: { type: 'inline' },
    updated: new Date().toISOString(),
  };
}

function recording(dir: string, systemPrompt = '') {
  const file = path.join(dir, 'cli.mjs');
  fs.writeFileSync(
    file,
    [
      "console.log(JSON.stringify({type:'session', id:'session-1'}));",
      "console.log(JSON.stringify({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text', text:'ok'}]}}));",
    ].join('\n'),
  );
  class RecordingAgent extends PiAgent {
    prompts: string[] = [];
    override buildArgs(prompt: string): string[] {
      this.prompts.push(prompt);
      return [file, ...super.buildArgs(prompt)];
    }
  }
  return new RecordingAgent({
    binary: process.execPath,
    model: '',
    systemPrompt,
    env: process.env,
  });
}

describe('PiAgent scope preamble', () => {
  it('puts a non-empty collection scope into the outgoing prompt and leaves history as the question', async () => {
    rememberEnv();
    const dir = directory();
    const wikiRoot = path.join(dir, 'wiki');
    process.env.PITH_WIKI_CONFIG_PATH = path.join(dir, 'absent.json');
    process.env.PITH_WIKI_ROOT = wikiRoot;
    const lib = new LibraryService(wikiRoot, { persist: false });
    lib.put(entry({ id: 'in-tech', collection: 'tech', title: 'agent design', content: 'ONLY-TECH' }));
    lib.put(entry({ id: 'in-life', collection: 'life', title: 'agent design', content: 'ONLY-LIFE' }));

    const agent = recording(dir, 'PERSONA');
    await expect(
      agent.send('agent design', { scope: { collections: ['tech'], folders: [], entryIds: ['in-tech'] } }),
    ).resolves.toBe('ok');

    const prompt = agent.prompts[0];
    expect(prompt.startsWith('[Scoped context for this question — collections: tech · pinned entries: in-tech. ')).toBe(true);
    expect(prompt).toContain(
      'Answer primarily from the entries below; use wiki_query (already scoped) only if you need more.',
    );
    expect(prompt).toContain('ONLY-TECH');
    expect(prompt).not.toContain('ONLY-LIFE');
    expect(prompt).not.toContain('PERSONA');
    expect(prompt.endsWith('\n\n---\n\nagent design')).toBe(true);
    expect(agent.exportHistory()[0]).toEqual({ role: 'user', content: 'agent design' });

    await agent.send('agent design again', {
      scope: { collections: ['tech'], folders: [], entryIds: [] },
    });
    const resumed = agent.prompts[1];
    expect(resumed.startsWith('[Scoped context for this question — collections: tech. ')).toBe(true);
    expect(resumed).toContain('ONLY-TECH');
    expect(resumed).not.toContain('ONLY-LIFE');
    expect(resumed).not.toContain('PERSONA');
    expect(resumed.endsWith('\n\n---\n\nagent design again')).toBe(true);
  });

  it('narrows a folder scope the same way', async () => {
    rememberEnv();
    const dir = directory();
    const wikiRoot = path.join(dir, 'wiki');
    process.env.PITH_WIKI_CONFIG_PATH = path.join(dir, 'absent.json');
    process.env.PITH_WIKI_ROOT = wikiRoot;
    const lib = new LibraryService(wikiRoot, { persist: false });
    lib.put(entry({ id: 'in-folder', collection: 'work', subpath: '2024', title: 'agent', content: 'IN-FOLDER' }));
    lib.put(entry({ id: 'out-folder', collection: 'work', subpath: '2023', title: 'agent', content: 'OUT-FOLDER' }));

    const agent = recording(dir);
    const scope: ScopeDTO = {
      collections: [],
      folders: [{ collection: 'work', subpath: '2024' }],
      entryIds: [],
    };
    await agent.send('agent', { scope });
    const prompt = agent.prompts[0];
    expect(prompt).toContain('folders: work/2024');
    expect(prompt).toContain('IN-FOLDER');
    expect(prompt).not.toContain('OUT-FOLDER');
    expect(prompt.endsWith('\n\n---\n\nagent')).toBe(true);
  });

  it('omits the preamble when the scope recalls nothing', async () => {
    rememberEnv();
    const dir = directory();
    const wikiRoot = path.join(dir, 'wiki');
    process.env.PITH_WIKI_CONFIG_PATH = path.join(dir, 'absent.json');
    process.env.PITH_WIKI_ROOT = wikiRoot;
    const lib = new LibraryService(wikiRoot, { persist: false });
    lib.put(entry({ id: 'in-life', collection: 'life', title: 'agent design', content: 'ONLY-LIFE' }));

    const agent = recording(dir);
    await agent.send('agent design', {
      scope: { collections: ['tech'], folders: [], entryIds: [] },
    });
    expect(agent.prompts[0]).toBe('agent design');
  });

  it('does not read config or add a preamble for an empty or absent scope', async () => {
    rememberEnv();
    const dir = directory();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{');
    process.env.PITH_WIKI_CONFIG_PATH = bad;

    const agent = recording(dir);
    const empty: ScopeDTO = { collections: [], folders: [], entryIds: [] };
    await expect(agent.send('hello', { scope: empty })).resolves.toBe('ok');
    await expect(agent.send('again')).resolves.toBe('ok');
    expect(agent.prompts).toEqual(['hello', 'again']);
  });
});
