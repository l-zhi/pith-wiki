import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExecutable, withCurrentPath } from '../src/runtime/commandEnvironment.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-command-env-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('executable discovery', () => {
  it('honors PATH order and explicit paths, including spaces, and checks executable permission', () => {
    const first = path.join(dir, 'npm bin');
    const second = path.join(dir, 'homebrew');
    for (const d of [first, second]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'cli'), '#!/bin/sh\nexit 0', { mode: 0o755 });
    }
    const env = { PATH: [first, second].join(path.delimiter) };
    expect(resolveExecutable('cli', env)).toBe(path.join(first, 'cli'));
    expect(resolveExecutable(path.join(second, 'cli'), env)).toBe(path.join(second, 'cli'));
    expect(resolveExecutable('./homebrew/cli', env, dir)).toBe(path.join(second, 'cli'));
    expect(resolveExecutable('/missing/cli', env)).toBeUndefined();
    fs.chmodSync(path.join(first, 'cli'), 0o644);
    expect(resolveExecutable('cli', env)).toBe(path.join(second, 'cli'));
    fs.rmSync(path.join(first, 'cli'));
    fs.mkdirSync(path.join(first, 'cli'));
    expect(resolveExecutable('cli', env)).toBe(path.join(second, 'cli'));
    fs.rmSync(path.join(first, 'cli'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'missing'), path.join(first, 'cli'));
    expect(resolveExecutable('cli', env)).toBe(path.join(second, 'cli'));
  });

  it('overlays only PATH and preserves provider credential isolation', () => {
    const base = { PATH: '/old', TOKEN: 'provider-token' };
    expect(withCurrentPath(base, { PATH: '/new', OPENAI_API_KEY: 'must-not-return' }))
      .toEqual({ PATH: '/new', TOKEN: 'provider-token' });
    expect(base.PATH).toBe('/old');
  });
});
