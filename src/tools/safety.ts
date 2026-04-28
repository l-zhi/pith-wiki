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
  /**
   * 额外允许读取的目录列表（仅 kind='read' 生效）。
   * 写操作仍只接受 workspaceRoot ∪ wikiRoot，确保 LLM 不会篡改这些"参考资料"目录。
   */
  additionalReadPaths?: string[];
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

  // 写：永远只接受 workspaceRoot ∪ wikiRoot。
  // 读：上述两者 ∪ 用户配置的 additionalReadPaths（也走 realpath 防 symlink 逃逸）。
  const allowedRoots: string[] = [realWorkspace, realWiki];
  if (kind === 'read' && opts.additionalReadPaths?.length) {
    for (const extra of opts.additionalReadPaths) {
      allowedRoots.push(realPathOrLiteral(extra));
    }
  }

  const allowed = allowedRoots.some((root) => isWithin(root, realCheck));
  if (!allowed) {
    throw new SafetyError(
      `Path escapes sandbox: ${realCheck} is outside ${allowedRoots.join(', ')}`,
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
