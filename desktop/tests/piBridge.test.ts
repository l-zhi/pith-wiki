import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePiBridge,
  PI_BRIDGE_RELATIVE_PATH,
  PI_BRIDGE_SOURCE,
} from '../src/engine/piBridgeSource.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pith-pi-bridge-'));
}

describe('ensurePiBridge', () => {
  it('写出桥接扩展到 <home>/pi/ 下并返回绝对路径', () => {
    const home = tmpHome();
    const p = ensurePiBridge(home);
    expect(p).toBe(path.join(home, PI_BRIDGE_RELATIVE_PATH));
    expect(fs.readFileSync(p, 'utf8')).toBe(PI_BRIDGE_SOURCE);
  });

  it('内容一致时不重写（按 mtime 判断幂等）', () => {
    const home = tmpHome();
    const p = ensurePiBridge(home);
    const before = fs.statSync(p).mtimeMs;
    // 保证时间戳分辨率不会掩盖重写
    const again = ensurePiBridge(home);
    expect(again).toBe(p);
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('内容不一致时覆盖（升级 pith 后旧桥接自动换掉）', () => {
    const home = tmpHome();
    const p = ensurePiBridge(home);
    fs.writeFileSync(p, '// stale bridge from an older pith\n', 'utf8');
    ensurePiBridge(home);
    expect(fs.readFileSync(p, 'utf8')).toBe(PI_BRIDGE_SOURCE);
  });

  it('生成的扩展是合法的 ESM（node --check 通过）', () => {
    const home = tmpHome();
    const p = ensurePiBridge(home);
    // .mjs 后缀让 node 以 ESM 解析；语法错会以非 0 退出并抛异常。
    expect(() => execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })).not.toThrow();
  });

  it('未配 PITH_MCP_COMMAND 时扩展 no-op（不注册任何工具、不 spawn）', async () => {
    const home = tmpHome();
    const p = ensurePiBridge(home);
    delete process.env.PITH_MCP_COMMAND;
    const mod = (await import(`file://${p}?nocmd=1`)) as {
      default: (pi: unknown) => Promise<void>;
    };
    const registered: unknown[] = [];
    await mod.default({
      registerTool: (t: unknown) => registered.push(t),
      on: () => {},
    });
    expect(registered).toEqual([]);
  });
});
