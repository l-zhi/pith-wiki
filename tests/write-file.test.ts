/**
 * write_file 工具：收敛到 <wikiRoot>/output、免审批、冗余 output/ 前缀防呆。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileTool } from '../src/tools/write_file.js';
import type { ToolContext } from '../src/tools/index.js';

let wiki: string;
let ws: string;
beforeEach(() => {
  wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wf-wk-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wf-ws-'));
});
afterEach(() => {
  fs.rmSync(wiki, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

/** 不提供 requestApproval/approvedWritePaths —— 验证写入不依赖审批（免审批）。 */
function ctx(): ToolContext {
  return {
    config: { workspaceRoot: ws, wikiRoot: wiki, maxToolPayloadBytes: 100_000, readOnly: false },
  } as unknown as ToolContext;
}

const run = (p: string, content = 'hi') =>
  writeFileTool.handler({ path: p, content } as never, ctx()) as Promise<{
    ok: boolean;
    path?: string;
    error?: string;
  }>;

const outDir = () => path.join(fs.realpathSync(wiki), 'output');

describe('write_file — 收敛到 output + 免审批', () => {
  it('相对文件名落 <wikiRoot>/output，无审批回调也成功', async () => {
    const r = await run('reading-report-2026.html');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'reading-report-2026.html'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'reading-report-2026.html'))).toBe(false);
  });

  it('子路径保留层级', async () => {
    const r = await run('books/三体.md');
    expect(r.ok).toBe(true);
    expect(r.path!.startsWith(outDir())).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'books', '三体.md'))).toBe(true);
  });
});

describe('write_file — 冗余 output/ 前缀防呆', () => {
  it('"output/report.html" 不产生 output/output', async () => {
    const r = await run('output/report.html');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'report.html'))).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'output'))).toBe(false);
  });

  it('"output/sub/x.md" 剥一层后保留其余层级', async () => {
    const r = await run('output/sub/x.md');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'sub', 'x.md'))).toBe(true);
    expect(fs.existsSync(path.join(wiki, 'output', 'output'))).toBe(false);
  });
});

describe('write_file — 收敛边界', () => {
  it('想写当前工作目录的绝对路径被拒', async () => {
    const r = await run(path.join(ws, 'evil.html'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('escapes sandbox');
  });

  it('../ 爬出 output 被拒', async () => {
    const r = await run('../../evil.md');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('escapes sandbox');
  });
});
