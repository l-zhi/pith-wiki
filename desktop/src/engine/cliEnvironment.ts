import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const START = '\0PITH_PATH\0';
const END = '\0PITH_END\0';
// Fixed command, no interpolated user input. printenv also handles fish's PATH array.
const PATH_COMMAND = "printf '\\000PITH_PATH\\000'; /usr/bin/printenv PATH; printf '\\000PITH_END\\000'";

function shellPath(shell: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', PATH_COMMAND], {
      env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    let output = '';
    let settled = false;
    const finish = (value?: string, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined, true), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) finish(undefined, true);
    });
    child.on('error', () => finish());
    child.on('close', (code) => {
      const start = output.indexOf(START);
      const end = output.indexOf(END, start + START.length);
      if (code !== 0 || start < 0 || end < 0) return finish();
      const value = output.slice(start + START.length, end).replace(/\r?\n$/, '');
      finish(value && !/[\0\r\n]/.test(value) ? value : undefined);
    });
  });
}

/** Engine-owned PATH. Refreshing it never rebuilds services or chat sessions. */
export class CliEnvironment {
  private readonly inheritedPath: string;
  private pending?: Promise<void>;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: { platform?: NodeJS.Platform; home?: string; timeoutMs?: number } = {},
  ) {
    this.inheritedPath = env.PATH ?? '';
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.refreshPath().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refreshPath(): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    if (platform === 'win32') return; // Preserve the Windows environment as supplied.
    const home = this.options.home ?? os.homedir();
    const fallback = [
      ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
      '/usr/local/bin', '/usr/local/sbin', path.join(home, '.local', 'bin'),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ];
    const merge = (...values: string[]) => [...new Set(values.flatMap((p) => p.split(':'))
      .filter((p) => path.isAbsolute(p) && !/[\0\r\n]/.test(p)))].join(':');
    // Always start from the launch environment, not the last refresh's nvm/fnm paths.
    const base = merge(this.inheritedPath, ...fallback);
    let discovered: string | undefined;
    try {
      const shell = this.env.SHELL || os.userInfo().shell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
      if (path.isAbsolute(shell)) {
        discovered = await shellPath(shell, { ...this.env, PATH: base }, this.options.timeoutMs ?? 2_000);
      }
    } catch { /* A broken shell must not prevent the desktop from starting. */ }
    this.env.PATH = merge(discovered ?? '', base);
  }
}

export const cliEnvironment = new CliEnvironment();
