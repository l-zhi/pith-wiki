/**
 * SafetyLayer 单元测试。
 *
 * 测试范围（仅外部行为）：
 * - resolveSafePath：路径沙箱、symlink 拒绝、不存在路径的 realpath 攀升、--read-only
 * - truncatePayload：按字节计数截断（UTF-8 多字节字符正确处理）
 *
 * 重点验证已踩过的坑：
 * - macOS /var → /private/var 软链接需要 root 也走 realpath
 * - 写入目标不存在时 realpath 沿目录树向上查找，避免误拒
 * - 中文等多字节字符按字节而非字符计数
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSafePath, SafetyError, truncatePayload } from '../src/tools/safety.js';

let workspace: string;
let wiki: string;

beforeEach(() => {
  // 工作区与 wiki 根分别用独立临时目录，模拟生产配置。
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-ws-'));
  wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-wk-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(wiki, { recursive: true, force: true });
});

/** 便捷构造：默认 SafetyOptions，调用方按需覆盖。 */
const opts = (overrides: Partial<{ readOnly: boolean; maxPayloadBytes: number }> = {}) => ({
  workspaceRoot: workspace,
  wikiRoot: wiki,
  maxPayloadBytes: overrides.maxPayloadBytes ?? 100,
  readOnly: overrides.readOnly ?? false,
});

describe('resolveSafePath — 沙箱接受', () => {
  it('工作区根目录下的相对路径被接受', () => {
    const target = path.join(workspace, 'foo.md');
    fs.writeFileSync(target, 'x');
    const safe = resolveSafePath('foo.md', 'read', opts());
    // 返回的应是经 realpath 归一化的绝对路径（macOS 的 /var → /private/var）。
    expect(safe).toBe(fs.realpathSync(target));
  });

  it('工作区子目录中的嵌套路径被接受', () => {
    // 模拟用户在 src/wiki/types.ts 这种深层文件上调用工具。
    const nested = path.join(workspace, 'src', 'wiki', 'types.ts');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'export {};');

    const safe = resolveSafePath('src/wiki/types.ts', 'read', opts());
    expect(safe).toBe(fs.realpathSync(nested));
  });

  it('wiki 根下的路径被接受（即使在 workspace 之外）', () => {
    // wiki 根可以独立于 workspace；这是分层沙箱的关键。
    const target = path.join(wiki, 'note.md');
    fs.writeFileSync(target, 'x');
    const safe = resolveSafePath(target, 'read', opts());
    expect(safe).toBe(fs.realpathSync(target));
  });

  it('包含 .. 但展开后仍在沙箱内的路径被接受', () => {
    // 例如 "src/../bin/foo"，展开后等价于 "bin/foo"，仍在 workspace 内。
    fs.mkdirSync(path.join(workspace, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'bin', 'foo'), 'x');

    const safe = resolveSafePath('src/../bin/foo', 'read', opts());
    expect(safe.startsWith(fs.realpathSync(workspace))).toBe(true);
  });
});

describe('resolveSafePath — 沙箱拒绝', () => {
  it('绝对路径在沙箱外被拒绝', () => {
    expect(() => resolveSafePath('/etc/passwd', 'read', opts())).toThrow(SafetyError);
  });

  it('包含 .. 越过沙箱根的路径被拒绝', () => {
    // ../../../../etc/passwd 这种典型路径穿越攻击向量。
    expect(() => resolveSafePath('../../../../etc/passwd', 'read', opts())).toThrow(SafetyError);
  });

  it('指向沙箱外的 symlink 被 realpath 后拒绝', () => {
    // 模拟攻击者在 workspace 里建一个软链接指向 /tmp 之外的目录。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-out-'));
    const link = path.join(workspace, 'escape');
    fs.symlinkSync(outside, link);

    try {
      expect(() => resolveSafePath('escape', 'read', opts())).toThrow(SafetyError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('readOnly=true 时拒绝写操作（即使路径合法）', () => {
    // --read-only flag 必须在 sandbox 校验之前就把所有写拒绝。
    expect(() => resolveSafePath('foo.md', 'write', opts({ readOnly: true }))).toThrow(SafetyError);
  });

  it('readOnly=true 时仍允许读操作', () => {
    fs.writeFileSync(path.join(workspace, 'foo.md'), 'x');
    expect(() => resolveSafePath('foo.md', 'read', opts({ readOnly: true }))).not.toThrow();
  });

  it('空字符串路径被拒绝', () => {
    expect(() => resolveSafePath('', 'read', opts())).toThrow(SafetyError);
  });
});

describe('resolveSafePath — 不存在路径的 realpath 攀升', () => {
  it('写入到尚不存在的子目录被允许（父目录在沙箱内）', () => {
    // 实施踩坑：fs.realpathSync 对不存在路径会抛错；
    // 我们的实现沿目录树向上找已存在的祖先，再 realpath，再拼回缺失尾部。
    const safe = resolveSafePath('subdir/new.md', 'write', opts());
    expect(safe.startsWith(fs.realpathSync(workspace))).toBe(true);
  });

  it('写入到深层不存在路径仍被允许', () => {
    const safe = resolveSafePath('a/b/c/d/new.md', 'write', opts());
    expect(safe.startsWith(fs.realpathSync(workspace))).toBe(true);
  });

  it('写入到沙箱外的不存在路径仍被拒绝', () => {
    // 即使父目录不存在，也不能允许逃逸。
    expect(() =>
      resolveSafePath('/var/never/exists/foo.md', 'write', opts()),
    ).toThrow(SafetyError);
  });
});

describe('resolveSafePath — macOS 兼容性', () => {
  it('workspace 是 /var/... 的软链接时仍能正确归一化（隐式覆盖）', () => {
    // 这条测试在 macOS 上 tmpDir 通常就是 /var/folders/... 形式（指向 /private/var/...）。
    // 创建一个文件后通过 'foo.md' 引用，realpath 后应该是 /private/var/...，仍在沙箱内。
    fs.writeFileSync(path.join(workspace, 'foo.md'), 'x');
    const safe = resolveSafePath('foo.md', 'read', opts());

    // 接受不抛 SafetyError 即视为通过（具体路径前缀因平台而异）。
    expect(safe).toBeTruthy();
    expect(typeof safe).toBe('string');
  });
});

describe('truncatePayload — 按字节计数', () => {
  it('小于上限的内容原样返回', () => {
    expect(truncatePayload('hello', 100)).toBe('hello');
  });

  it('恰好等于上限的内容不被截断', () => {
    const exact = 'a'.repeat(100);
    expect(truncatePayload(exact, 100)).toBe(exact);
  });

  it('超过上限的内容尾部追加 truncated 标记', () => {
    const big = 'a'.repeat(500);
    const out = truncatePayload(big, 100);
    expect(out.length).toBeLessThan(big.length + 100);
    expect(out).toContain('truncated');
  });

  it('truncated 标记包含具体被丢弃的字节数', () => {
    const big = 'a'.repeat(500);
    const out = truncatePayload(big, 100);
    expect(out).toMatch(/truncated \d+ bytes/);
  });

  it('UTF-8 多字节字符按字节而非字符计数（中文）', () => {
    // 一个中文字符在 UTF-8 下是 3 字节。
    // 50 个中文字符 = 150 字节，超过 100 字节上限。
    const chinese = '中'.repeat(50);
    expect(Buffer.byteLength(chinese, 'utf8')).toBe(150);

    const out = truncatePayload(chinese, 100);
    expect(out).toContain('truncated');
    // 截断后的字节数大致应该在 100 ~ 100 + 标记长度 之间。
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(150 + 50);
  });

  it('混合 ASCII + 中文也能正确截断', () => {
    const mixed = 'hello 中文 '.repeat(20); // 大概 240 字节
    const out = truncatePayload(mixed, 100);
    expect(out).toContain('truncated');
  });

  it('空字符串保持空字符串', () => {
    expect(truncatePayload('', 100)).toBe('');
  });
});
