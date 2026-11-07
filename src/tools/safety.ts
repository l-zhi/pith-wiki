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
   * 写不走这些目录。writeRoot 一旦传入（write_file 固定为 `<wikiRoot>/output`），
   * workspaceRoot ∪ wikiRoot 也不再是合法写根。
   */
  additionalReadPaths?: string[];
  /**
   * 写操作的根目录收敛（仅 kind='write' 生效）。一旦提供：
   *   - 相对路径相对它（而非 workspaceRoot）解析；
   *   - 写目标必须落在它之内 —— 不再接受 workspaceRoot/wikiRoot 顶层的其他位置。
   * write_file 用它把 agent 的输出钳进 `<wikiRoot>/output`，杜绝写到用户的当前
   * 工作目录。绝对路径若落在它之外会被拒绝。
   */
  writeRoot?: string;
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

  // 写且收敛 writeRoot 时：相对路径相对 writeRoot 解析，沙箱根只有 writeRoot。
  // 其余情况（读，或未收敛的写）：相对 workspaceRoot 解析，沙箱根 = workspace ∪ wiki。
  const confineWrite = kind === 'write' && !!opts.writeRoot;
  const base = confineWrite ? (opts.writeRoot as string) : opts.workspaceRoot;
  const resolved = path.resolve(base, inputPath);
  const realCheck = realPathClimbing(resolved);

  // realPathClimbing 解析 writeRoot（output 目录可能尚不存在）：爬到已存在的
  // 祖先 realpath 再接尾，与 realCheck 的前缀口径一致（防 wikiRoot 是 symlink 时误判）。
  const allowedRoots: string[] = confineWrite
    ? [realPathClimbing(opts.writeRoot as string)]
    : [realPathOrLiteral(opts.workspaceRoot), realPathOrLiteral(opts.wikiRoot)];
  if (!confineWrite && kind === 'read' && opts.additionalReadPaths?.length) {
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

/** UTF-8 prefix of at most `maxBytes`, never splitting a code point. */
function utf8Prefix(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;
  // Continuation bytes are 10xxxxxx. Step back to the lead byte and drop it
  // so the cut stays on a code-point boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function truncatePayload(content: string, max: number): string {
  const total = Buffer.byteLength(content, 'utf8');
  if (total <= max) return content;
  const marker = (dropped: number) => `\n…[truncated ${dropped} bytes]\n`;
  // Digit length is monotonic and dropped <= total, so a marker sized for
  // `total` is an upper bound on the marker we actually append.
  const room = max - Buffer.byteLength(marker(total), 'utf8');
  if (room < 0) return utf8Prefix(marker(total), max);
  const slice = utf8Prefix(content, room);
  const dropped = total - Buffer.byteLength(slice, 'utf8');
  return `${slice}${marker(dropped)}`;
}
