import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderSchema } from '../../src/config.js';
import {
  applyProviderModelSettings,
  readCodexModelOptions,
} from '../src/engine/providerModelSettings.js';
import { CodexAgent } from '../../src/llm/codexAgent.js';

const dirs: string[] = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-model-settings-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('provider model settings', () => {
  it('round-trips model overrides, preserves unmanaged fields, and clears defaults', () => {
    const old = {
      kind: 'codex',
      model: 'old-model',
      binary: '/custom/codex',
      apiKeyEnv: 'KEY',
      custom: true,
    };
    const saved = applyProviderModelSettings(old, {
      kind: 'codex',
      model: ' custom-model ',
      reasoningEffort: 'high',
      verbosity: 'low',
    });
    const parsed = ProviderSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(parsed).toMatchObject({
      model: 'custom-model',
      reasoningEffort: 'high',
      verbosity: 'low',
      binary: '/custom/codex',
    });
    expect(saved.custom).toBe(true);
    const cleared = applyProviderModelSettings(saved, {
      kind: 'codex',
      model: 'default',
      reasoningEffort: null,
      verbosity: null,
    });
    expect(cleared).not.toHaveProperty('reasoningEffort');
    expect(cleared).not.toHaveProperty('verbosity');
    expect(cleared.apiKeyEnv).toBe('KEY');
    expect(applyProviderModelSettings(saved, { kind: 'codex', model: 'another' })).toMatchObject({
      reasoningEffort: 'high',
      verbosity: 'low',
    });
  });

  it('rejects unsupported provider settings before writing', () => {
    expect(() =>
      applyProviderModelSettings(
        {},
        { kind: 'claude-code', model: 'sonnet', reasoningEffort: 'ultra' },
      ),
    ).toThrow(/reasoningEffort/);
    expect(() =>
      applyProviderModelSettings({}, { kind: 'pi', model: 'default', verbosity: 'high' }),
    ).toThrow(/verbosity/);
    expect(() =>
      applyProviderModelSettings({}, { kind: 'codex', model: 'x', reasoningEffort: 'typo' }),
    ).toThrow();
    expect(() => applyProviderModelSettings({}, { kind: 'codex', model: '  ' })).toThrow();
  });

  it('uses cached model capabilities, hides internal models, and tolerates absent or broken caches', () => {
    const dir = tmp();
    expect(readCodexModelOptions(dir)).toEqual([]);
    const file = path.join(dir, 'models_cache.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        models: [
          {
            slug: 'visible',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'high' },
              { effort: 'ultra' },
              { effort: 'bad' },
              null,
            ],
          },
          { slug: 'internal', visibility: 'hide' },
          null,
          {},
        ],
      }),
    );
    expect(readCodexModelOptions(dir)).toEqual([
      { id: 'visible', reasoningEfforts: ['high', 'ultra'] },
    ]);
    fs.writeFileSync(file, 'broken');
    expect(readCodexModelOptions(dir)).toEqual([]);
  });

  it('passes saved model settings to the spawned CLI on new and resumed turns', async () => {
    const dir = tmp();
    const binary = path.join(dir, 'codex');
    const captured = path.join(dir, 'args.jsonl');
    fs.writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        [
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
          `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-test'}));`,
          `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));`,
        ].join('\n'),
      { mode: 0o755 },
    );
    const config = ProviderSchema.parse(
      applyProviderModelSettings(
        { binary },
        {
          kind: 'codex',
          model: 'custom-model',
          reasoningEffort: 'high',
          verbosity: 'low',
        },
      ),
    );
    const agent = new CodexAgent({
      ...config,
      binary,
      systemPrompt: '',
      cwd: dir,
      env: {},
      log: () => {},
    });
    expect(await agent.send('first')).toBe('ok');
    expect(await agent.send('second')).toBe('ok');
    const calls: string[][] = fs
      .readFileSync(captured, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0][0]).toBe('exec');
    expect(calls[1].slice(0, 3)).toEqual(['exec', 'resume', 'thread-test']);
    for (const args of calls) {
      expect(args[args.indexOf('-m') + 1]).toBe('custom-model');
      expect(args).toContain('model_reasoning_effort="high"');
      expect(args).toContain('model_verbosity="low"');
    }
    expect(calls[1]).not.toContain('-C');
    const defaults = new CodexAgent({
      binary,
      model: 'default',
      systemPrompt: '',
      env: {},
    }).buildArgs('hi', '/tmp/out');
    expect(defaults).not.toContain('-m');
    expect(
      defaults.some(
        (v) => v.startsWith('model_reasoning_effort=') || v.startsWith('model_verbosity='),
      ),
    ).toBe(false);
  });
});
