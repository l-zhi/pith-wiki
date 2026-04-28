import fs from 'node:fs';
import path from 'node:path';

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

export interface SafetyOptions {
  workspaceRoot: string;
  wikiRoot: string;
  maxPayloadBytes: number;
  readOnly: boolean;
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realPathOrLiteral(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function realPathClimbing(p: string): string {
  // Walk upward until we find a directory that exists, then re-attach the
  // missing tail (so write targets in fresh subdirs still get sandboxed).
  let current = p;
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const realRoot = realPathOrLiteral(current);
  return tail.length ? path.join(realRoot, ...tail) : realRoot;
}

export function resolveSafePath(
  inputPath: string,
  kind: 'read' | 'write',
  opts: SafetyOptions,
): string {
  if (kind === 'write' && opts.readOnly) {
    throw new SafetyError('Writes are disabled (read-only mode).');
  }
  if (!inputPath) throw new SafetyError('Empty path');

  const resolved = path.resolve(opts.workspaceRoot, inputPath);
  const realCheck = realPathClimbing(resolved);

  const realWorkspace = realPathOrLiteral(opts.workspaceRoot);
  const realWiki = realPathOrLiteral(opts.wikiRoot);
  const allowed = isWithin(realWorkspace, realCheck) || isWithin(realWiki, realCheck);
  if (!allowed) {
    throw new SafetyError(
      `Path escapes sandbox: ${realCheck} is outside ${realWorkspace} and ${realWiki}`,
    );
  }
  return realCheck;
}

export function truncatePayload(content: string, max: number): string {
  if (Buffer.byteLength(content, 'utf8') <= max) return content;
  const slice = content.slice(0, max);
  const dropped = Buffer.byteLength(content, 'utf8') - Buffer.byteLength(slice, 'utf8');
  return `${slice}\n…[truncated ${dropped} bytes]\n`;
}
