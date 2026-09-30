import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAgent, type CodexAgentOptions } from '../src/llm/codexAgent.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-codex-process-'));
  dirs.push(dir);
  return dir;
}

function options(overrides: Partial<CodexAgentOptions> = {}): CodexAgentOptions {
  return { binary: process.execPath, model: '', systemPrompt: '', env: process.env, log: () => {}, ...overrides };
}

// Exercise send() with real OS processes, without a Codex account or network calls.
function fixture(source: string) {
  const file = path.join(directory(), 'cli.mjs');
  fs.writeFileSync(file, source);
  class FixtureAgent extends CodexAgent {
    outputPath = '';
    override buildArgs(prompt: string, outFile: string) {
      this.outputPath = outFile;
      return [file, ...super.buildArgs(prompt, outFile)];
    }
  }
  return new FixtureAgent(options());
}

describe('CodexAgent process lifecycle', () => {
  it('rejects a missing binary with an actionable error instead of crashing the host', async () => {
    const binary = path.join(directory(), 'missing-codex');
    const agent = new CodexAgent(options({ binary }));
    await expect(agent.send('hello')).rejects.toThrow(/ENOENT/);
    await expect(agent.send('retry')).rejects.toThrow(/binary/);
    expect(agent.exportHistory()).toEqual([
      { role: 'user', content: 'hello' }, { role: 'user', content: 'retry' },
    ]);
  }, 1500);

  it('reports a missing working directory without an unhandled process error', async () => {
    const agent = new CodexAgent(options({ cwd: path.join(directory(), 'missing') }));
    await expect(agent.send('hello')).rejects.toThrow(/工作目录/);
  }, 1500);

  it.skipIf(process.platform === 'win32')('reports a non-executable binary with its path', async () => {
    const binary = path.join(directory(), 'not-executable');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    const agent = new CodexAgent(options({ binary }));
    await expect(agent.send('hello')).rejects.toThrow(/执行权限/);
    await expect(agent.send('retry')).rejects.toThrow(binary);
  });

  it('keeps final output, thread resumption and output-file cleanup working', async () => {
    const agent = fixture(`
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.writeFileSync(args[args.indexOf('-o') + 1], args.includes('resume') ? 'resumed' : 'answer');
      console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'stream'}}));
    `);
    const onAssistantText = vi.fn();
    await expect(agent.send('hello', { events: { onAssistantText } })).resolves.toBe('answer');
    expect(onAssistantText).toHaveBeenLastCalledWith({ text: 'answer', final: true });
    expect(fs.existsSync(agent.outputPath)).toBe(false);
    await expect(agent.send('again')).resolves.toBe('resumed');
    expect(fs.existsSync(agent.outputPath)).toBe(false);
  });

  it('preserves stderr on unsuccessful CLI exits', async () => {
    const agent = fixture(`console.error('fixture failure'); process.exitCode = 7;`);
    await expect(agent.send('hello')).rejects.toThrow('fixture failure');
    expect(fs.existsSync(agent.outputPath)).toBe(false);
  });

  it('does not spawn for an already cancelled request', async () => {
    const agent = fixture(`process.exit(0);`);
    const build = vi.spyOn(agent, 'buildArgs');
    await expect(agent.send('hello', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(build).not.toHaveBeenCalled();
    expect(agent.exportHistory()).toEqual([]);
  });

  it('cancels an active process and cleans up its output file', async () => {
    const agent = fixture(`
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'partial');
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    await expect(agent.send('hello', {
      signal: controller.signal,
      events: { onAssistantText: () => controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(agent.outputPath)).toBe(false);
  });

  it('keeps cancellation active after stdout ends until the process closes', async () => {
    const agent = fixture(`
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));
      process.stdout.end();
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    await expect(agent.send('hello', {
      signal: controller.signal,
      events: { onAssistantText: () => { setTimeout(() => controller.abort(), 50); } },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
