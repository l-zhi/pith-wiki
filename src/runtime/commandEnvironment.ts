import fs from 'node:fs';
import path from 'node:path';

/** Use the same executable lookup for dependency checks and process launches. */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  const windows = process.platform === 'win32';
  const pathKey = windows ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const dirs = (env[pathKey ?? 'PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const explicit = command.includes('/') || (windows && command.includes('\\'));
  const candidates = explicit
    ? [path.resolve(cwd, command)]
    : dirs.map((dir) => path.resolve(cwd, dir, command));
  // shell:false cannot run .cmd/.bat wrappers. Do not report those as runnable.
  const suffixes = windows && !path.extname(command) ? ['', '.exe', '.com'] : [''];
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      const file = candidate + suffix;
      try {
        if (windows && /\.(cmd|bat)$/i.test(file)) continue;
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return file;
      } catch { /* Try the next directory, including after a dangling symlink. */ }
    }
  }
  return undefined;
}

/** Refresh PATH without reintroducing credentials removed from a provider's env. */
export function withCurrentPath(base: NodeJS.ProcessEnv, current = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    const key = Object.keys(current).find((k) => k.toUpperCase() === 'PATH');
    if (key) env[key] = current[key];
  } else {
    env.PATH = current.PATH;
  }
  return env;
}
