import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSafePath, SafetyError, truncatePayload } from '../src/tools/safety.js';

let workspace: string;
let wiki: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-ws-'));
  wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-wk-'));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(wiki, { recursive: true, force: true });
});

const opts = () => ({
  workspaceRoot: workspace,
  wikiRoot: wiki,
  maxPayloadBytes: 100,
  readOnly: false,
});

describe('resolveSafePath', () => {
  it('accepts a relative path inside the workspace', () => {
    const target = path.join(workspace, 'foo.md');
    fs.writeFileSync(target, 'x');
    const safe = resolveSafePath('foo.md', 'read', opts());
    expect(safe).toBe(fs.realpathSync(target));
  });

  it('accepts a path inside the wiki root', () => {
    const target = path.join(wiki, 'note.md');
    fs.writeFileSync(target, 'x');
    const safe = resolveSafePath(target, 'read', opts());
    expect(safe).toBe(fs.realpathSync(target));
  });

  it('rejects a path outside both roots', () => {
    expect(() => resolveSafePath('/etc/passwd', 'read', opts())).toThrow(SafetyError);
  });

  it('rejects symlink escaping the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-out-'));
    const link = path.join(workspace, 'escape');
    fs.symlinkSync(outside, link);
    try {
      expect(() => resolveSafePath('escape', 'read', opts())).toThrow(SafetyError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects writes when readOnly=true', () => {
    expect(() =>
      resolveSafePath('foo.md', 'write', { ...opts(), readOnly: true }),
    ).toThrow(SafetyError);
  });

  it('allows write to a file that does not yet exist if parent is inside the sandbox', () => {
    const safe = resolveSafePath('subdir/new.md', 'write', opts());
    expect(safe.startsWith(fs.realpathSync(workspace))).toBe(true);
  });
});

describe('truncatePayload', () => {
  it('returns content unchanged when under the limit', () => {
    expect(truncatePayload('hello', 100)).toBe('hello');
  });

  it('appends a marker when truncated', () => {
    const big = 'a'.repeat(500);
    const out = truncatePayload(big, 100);
    expect(out.length).toBeLessThan(big.length + 50);
    expect(out).toContain('truncated');
  });
});
