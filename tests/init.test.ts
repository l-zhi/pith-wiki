/**
 * `pith-wiki init` 单元测试。
 *
 * 用 homeDirOverride 把目标 home 指到 tmpdir，避免污染开发者本机的 ~/.pith-wiki/。
 * 覆盖：
 *   - 全新安装路径（mkdir + 写文件 + chmod）
 *   - 幂等：已存在 .env 不覆盖
 *   - --force：覆盖 + 自动备份成 .env.pre-init.bak
 *   - --api-key：模板里的占位符被替换
 *   - chmod 600 真的被设上（owner-only）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, formatInitResult } from '../src/cli/initCommand.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-init-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runInit — 全新安装', () => {
  it('home 不存在 → mkdir + 写 .env，wrote=true', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    expect(fs.existsSync(home)).toBe(false);

    const result = runInit({ homeDirOverride: home });

    expect(result.wrote).toBe(true);
    expect(result.envFile).toBe(path.join(home, '.env'));
    expect(result.backupFile).toBeUndefined();
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(result.envFile)).toBe(true);
  });

  it('写出的 .env 包含模板里的关键 placeholder', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(body).toContain('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');
    expect(body).toMatch(/PITH_WIKI_PROVIDER/); // 注释里的开关 hint
    expect(body).toMatch(/PITH_WIKI_READ_PATHS/);
  });

  it('chmod 600：仅 owner 可读写（POSIX 平台）', () => {
    if (process.platform === 'win32') return; // chmod 在 Windows 上语义不同
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const stat = fs.statSync(path.join(home, '.env'));
    // mode 低 9 位 = 600 (rw-------)
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('runInit — 幂等 / --force', () => {
  it('.env 已存在 + 没 --force → 不写，wrote=false', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    fs.mkdirSync(home);
    const existing = path.join(home, '.env');
    fs.writeFileSync(existing, 'KEEP_THIS=yes\n', 'utf8');

    const result = runInit({ homeDirOverride: home });

    expect(result.wrote).toBe(false);
    expect(result.backupFile).toBeUndefined();
    // 原 .env 内容必须没动
    expect(fs.readFileSync(existing, 'utf8')).toBe('KEEP_THIS=yes\n');
  });

  it('.env 已存在 + --force → 备份到 .pre-init.bak 然后覆盖', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    fs.mkdirSync(home);
    const existing = path.join(home, '.env');
    fs.writeFileSync(existing, 'OLD_CONTENT=keep_safe\n', 'utf8');

    const result = runInit({ homeDirOverride: home, force: true });

    expect(result.wrote).toBe(true);
    expect(result.backupFile).toBe(path.join(home, '.env.pre-init.bak'));
    // 备份保留旧内容
    expect(fs.readFileSync(result.backupFile!, 'utf8')).toBe('OLD_CONTENT=keep_safe\n');
    // 新 .env 是模板
    expect(fs.readFileSync(existing, 'utf8')).toContain('DEEPSEEK_API_KEY=');
  });
});

describe('runInit — --api-key 内联', () => {
  it('传 apiKey → 模板里的占位符被替换成真实 key', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const realKey = 'sk-real-deadbeef-fake-token';

    runInit({ homeDirOverride: home, apiKey: realKey });

    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(body).toContain(`DEEPSEEK_API_KEY=${realKey}`);
    expect(body).not.toContain('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');
  });

  it('不传 apiKey → 占位符保留，让用户后续手工编辑', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(body).toContain('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');
  });
});

describe('formatInitResult — 输出消息', () => {
  it('wrote=true 时含 ✓ + envFile 路径', () => {
    const result = { envFile: '/x/.env', wrote: true };
    const out = formatInitResult(result);
    expect(out).toContain('✓');
    expect(out).toContain('/x/.env');
    expect(out).toContain('next:'); // 提示用户下一步
  });

  it('wrote=false 时含 ✗ + 提示用 --force', () => {
    const result = { envFile: '/x/.env', wrote: false };
    const out = formatInitResult(result);
    expect(out).toContain('✗');
    expect(out).toContain('--force');
  });

  it('apiKey 给了 → 输出提示 key 已内联', () => {
    const result = { envFile: '/x/.env', wrote: true };
    const out = formatInitResult(result, { apiKey: 'sk-x' });
    expect(out).toContain('DEEPSEEK_API_KEY filled inline');
  });

  it('有 backupFile → 输出里显示备份路径', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      backupFile: '/x/.env.pre-init.bak',
    };
    const out = formatInitResult(result, { force: true });
    expect(out).toContain('backup:');
    expect(out).toContain('.env.pre-init.bak');
  });
});
