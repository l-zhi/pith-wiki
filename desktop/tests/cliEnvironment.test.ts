import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliEnvironment } from '../src/engine/cliEnvironment.js';
import { runSkillCommandProbe } from '../src/engine/skillCommandProbe.js';
import { runCommandTool, type RunCommandResult } from '../../src/tools/run_command.js';
import type { ToolContext } from '../../src/tools/index.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { checkRequirements } from '../../src/skills/install.js';
import { withCurrentPath } from '../../src/runtime/commandEnvironment.js';
import { CodexAgent } from '../../src/llm/codexAgent.js';
import { ClaudeCodeAgent } from '../src/engine/claudeCodeAgent.js';
import { PiAgent } from '../src/engine/piAgent.js';

let dir: string;
let originalPath: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-cli-env-'));
  originalPath = process.env.PATH;
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string, shebang = process.execPath) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${shebang}\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A noisy login shell with a changeable PATH; execute the actual fixed probe command. */
function loginShell() {
  const config = path.join(dir, 'shell-path.json');
  fs.writeFileSync(config, JSON.stringify('/usr/bin:/bin'));
  const shell = script('shell', `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    if (process.argv[2] !== '-ilc') process.exit(2);
    console.log('welcome banner');
    const r = spawnSync('/bin/sh', ['-c', process.argv[3]], {
      env: {...process.env, PATH: JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8')), SHELL_SECRET: 'not imported'},
      stdio: 'inherit'
    });
    process.exit(r.status ?? 1);
  `);
  return { shell, setPath: (value: string) => fs.writeFileSync(config, JSON.stringify(value)) };
}

describe.skipIf(process.platform === 'win32')('desktop CLI environment', () => {
  it('merges login-shell, inherited and Homebrew/user paths, retaining priority and no other env', async () => {
    const { shell, setPath } = loginShell();
    const npm = path.join(dir, 'npm global/bin');
    setPath(`${npm}:/usr/bin:${npm}`);
    const env = { SHELL: shell, PATH: '/usr/bin:/bin', TOKEN: 'unchanged' };
    await new CliEnvironment(env, { platform: 'darwin', home: dir }).refresh();
    const dirs = env.PATH.split(':');
    expect(dirs[0]).toBe(npm);
    expect(dirs.filter((d) => d === npm)).toHaveLength(1);
    expect(dirs).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(dir, '.local/bin')]));
    expect(env.TOKEN).toBe('unchanged');
    expect(env).not.toHaveProperty('SHELL_SECRET');
  });

  it('reads real zsh login and interactive profiles without changing them on the host', async () => {
    if (!fs.existsSync('/bin/zsh')) return;
    fs.writeFileSync(path.join(dir, '.zprofile'), 'export PATH="/login/bin:$PATH"\n');
    fs.writeFileSync(path.join(dir, '.zshrc'), 'export PATH="/npm/bin:$PATH"\n');
    const env = { SHELL: '/bin/zsh', ZDOTDIR: dir, PATH: '/usr/bin:/bin' };
    await new CliEnvironment(env).refresh();
    expect(env.PATH.split(':').slice(0, 2)).toEqual(['/npm/bin', '/login/bin']);
  });

  it.each(['missing', 'timeout', 'overflow', 'invalid'])('falls back after a %s shell without blocking startup', async (failure) => {
    const shell = failure === 'missing' ? path.join(dir, 'absent') : script('broken-shell',
      failure === 'timeout' ? 'setInterval(() => {}, 1000)' :
      failure === 'overflow' ? 'process.stdout.write("x".repeat(70000)); setInterval(() => {}, 1000)' :
      'process.stdout.write("unparseable output");');
    const env = { SHELL: shell, PATH: '/usr/bin:/bin' };
    const start = Date.now();
    await new CliEnvironment(env, { platform: 'darwin', home: dir, timeoutMs: 200 }).refresh();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).not.toContain('unparseable');
  });

  it('shares concurrent refreshes and replaces obsolete shell paths on the next refresh', async () => {
    const { shell, setPath } = loginShell();
    const env = { SHELL: shell, PATH: '/usr/bin:/bin' };
    const manager = new CliEnvironment(env);
    setPath('/old-node/bin:/usr/bin');
    const first = manager.refresh();
    expect(manager.refresh()).toBe(first);
    await first;
    setPath('/new-node/bin:/usr/bin');
    await manager.refresh();
    expect(env.PATH).toContain('/new-node/bin');
    expect(env.PATH).not.toContain('/old-node/bin');
  });

  it('keeps Windows PATH untouched and never invokes a login shell', async () => {
    const env = { Path: 'C:\\Windows;C:\\Node', SHELL: '/absent' };
    await new CliEnvironment(env, { platform: 'win32' }).refresh();
    expect(env).toEqual({ Path: 'C:\\Windows;C:\\Node', SHELL: '/absent' });
  });

  it('discovers a post-launch install, runs its Node shebang, and updates an existing chat context', async () => {
    const { shell, setPath } = loginShell();
    vi.stubEnv('SHELL', shell);
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const manager = new CliEnvironment(process.env);
    const registry = new SkillRegistry();
    registry.register({ name: 'lark', description: '', body: '', dir, commands: ['pith-test-lark'],
      requires: [{ bin: 'pith-test-lark' }], httpAllow: [] });
    const ctx = { config: { workspaceRoot: dir, commandTimeoutMs: 2000, maxToolPayloadBytes: 10000 },
      skillRegistry: registry, approvedCommands: new Set<string>(), requestCommandApproval: async () => 'always',
    } as unknown as ToolContext;
    const probe = () => runSkillCommandProbe('pith-test-lark', ['auth', 'status'], ctx, manager);
    expect((await probe()).detail).toContain('not found');
    const skill = registry.get('lark')!;
    expect(checkRequirements(skill)).toHaveLength(1);

    // Simulate installation while the same engine/context remains alive.
    const cliDir = path.join(dir, 'npm global/bin');
    const nodeDir = path.join(dir, 'node runtime');
    script('npm global/bin/pith-test-lark', 'console.log(process.argv.slice(2).join(" "))', '/usr/bin/env node');
    fs.mkdirSync(nodeDir);
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    setPath(`${cliDir}:${nodeDir}:/usr/bin:/bin`);
    expect(await probe()).toMatchObject({ ok: true, detail: 'auth status' });
    expect(checkRequirements(skill)).toEqual([]);
    const chat = await runCommandTool.handler({ command: 'pith-test-lark', args: ['chat-next-call'] }, ctx) as RunCommandResult;
    expect(chat).toMatchObject({ ok: true, output: 'chat-next-call\n' });
    expect(ctx.approvedCommands.has('pith-test-lark')).toBe(true);

    script('npm global/bin/pith-test-lark', 'console.error("Please log in again"); process.exit(4)', '/usr/bin/env node');
    expect(await probe()).toMatchObject({ ok: false, detail: expect.stringContaining('Please log in again') });
    // A found CLI with a missing interpreter is different from an absent command.
    script('npm global/bin/pith-test-lark', '', '/missing/runtime');
    expect(await probe()).toMatchObject({ ok: false, detail: expect.stringContaining('check its runtime') });
  });

  it.each(['codex', 'claude', 'pi'] as const)('refreshes PATH for an existing %s agent on its next turn, retaining history and credentials', async (kind) => {
    const { shell, setPath } = loginShell();
    vi.stubEnv('SHELL', shell);
    process.env.PATH = '/usr/bin:/bin';
    const manager = new CliEnvironment(process.env);
    const file = script('delegate', `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('pith-test-child', [], {encoding:'utf8'});
      const answer = result.status === 0 ? result.stdout.trim() : 'before install';
      if (process.env.OPENAI_API_KEY) process.exit(9);
      const messages = {
        codex: [{type:'thread.started',thread_id:'thread-test'}, {type:'item.completed',item:{type:'agent_message',text:answer}}],
        claude: [{type:'result',session_id:'session-test',result:answer}],
        pi: [{type:'session',id:'session-test'},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:answer}],stopReason:'stop'}}]
      };
      for (const event of messages[${JSON.stringify(kind)}]) console.log(JSON.stringify(event));
    `);
    const base = { PATH: process.env.PATH };
    const common = { binary: file, model: '', systemPrompt: '', env: base,
      getEnv: () => withCurrentPath(base), cwd: dir };
    const agent = kind === 'codex' ? new CodexAgent({ ...common, log: () => {} }) :
      kind === 'claude' ? new ClaudeCodeAgent({ ...common, mcpConfigPath: path.join(dir, 'mcp.json') }) :
      new PiAgent(common);
    expect(await agent.send('first')).toBe('before install');
    script('new bin/pith-test-child', 'console.log("after install")');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reintroduce');
    setPath(`${path.join(dir, 'new bin')}:/usr/bin:/bin`);
    await manager.refresh();
    expect(await agent.send('second')).toBe('after install');
    expect(agent.exportHistory()).toHaveLength(4);
  });
});
