/**
 * `pith-wiki init` 单元测试。
 *
 * 用 homeDirOverride 把目标 home 指到 tmpdir，避免污染开发者本机的 ~/.pith-wiki/。
 * init 现在只写 config.json（无 .env）——API key 作为 provider entry 的字面 `apiKey`。
 * 覆盖：
 *   - 全新安装：写 config.json + chmod 600
 *   - 幂等：已存在 config.json 不覆盖
 *   - --force：备份 + 覆盖
 *   - --api-key：写成 provider entry 的字面 apiKey
 *   - --provider：activeProvider 正确
 *   - --watch-dir：config.json 里有 watchDirs 条目
 *   - PROVIDER_CATALOG / lookupProvider 行为
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runInit,
  formatInitResult,
  lookupProvider,
  PROVIDER_CATALOG,
  DEFAULT_PROVIDER_ID,
  renderConfigJson,
  previewWatchDir,
} from '../src/cli/initCommand.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-init-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runInit — 全新安装（默认 provider）', () => {
  it('home 不存在 → mkdir + 写 config.json，wrote=true', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    expect(fs.existsSync(home)).toBe(false);

    const result = runInit({ homeDirOverride: home });

    expect(result.wrote).toBe(true);
    expect(result.configFile).toBe(path.join(home, 'config.json'));
    expect(result.backupFile).toBeUndefined();
    expect(result.apiKeyFilled).toBe(false);
    expect(result.provider.id).toBe(DEFAULT_PROVIDER_ID);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(true);
    // 不再写 .env
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false);
  });

  it('默认 provider 写出的 config.json 含 deepseek entry + activeProvider', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));

    expect(cfg.activeProvider).toBe('deepseek');
    expect(cfg.providers.deepseek.baseURL).toContain('deepseek');
    expect(cfg.providers.deepseek.model).toBe('deepseek-chat');
    // 没传 key → 不写 apiKey 字段，也不写 apiKeyEnv（不再用 .env 间接引用）
    expect(cfg.providers.deepseek.apiKey).toBeUndefined();
    expect(cfg.providers.deepseek.apiKeyEnv).toBeUndefined();
  });

  it('chmod 600：仅 owner 可读写（POSIX 平台）——config.json 持有明文 key', () => {
    if (process.platform === 'win32') return;
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const stat = fs.statSync(path.join(home, 'config.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('runInit — 幂等 / --force', () => {
  it('config.json 已存在 + 没 --force → 不写，wrote=false', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    fs.mkdirSync(home);
    const existing = path.join(home, 'config.json');
    fs.writeFileSync(existing, '{"keep":true}\n', 'utf8');

    const result = runInit({ homeDirOverride: home });

    expect(result.wrote).toBe(false);
    expect(result.backupFile).toBeUndefined();
    expect(fs.readFileSync(existing, 'utf8')).toBe('{"keep":true}\n');
  });

  it('config.json 已存在 + --force → 备份到 .pre-init.bak 然后覆盖', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    fs.mkdirSync(home);
    const existing = path.join(home, 'config.json');
    fs.writeFileSync(existing, '{"old":true}', 'utf8');

    const result = runInit({ homeDirOverride: home, provider: 'openai', force: true });

    expect(result.wrote).toBe(true);
    expect(result.backupFile).toBe(path.join(home, 'config.json.pre-init.bak'));
    expect(fs.readFileSync(result.backupFile!, 'utf8')).toBe('{"old":true}');
    const newCfg = JSON.parse(fs.readFileSync(existing, 'utf8'));
    expect(newCfg.activeProvider).toBe('openai');
  });
});

describe('runInit — --api-key 写进 config.json', () => {
  it('传 apiKey → 写成选中 provider entry 的字面 apiKey', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const realKey = 'sk-real-deadbeef-fake-token';

    const result = runInit({ homeDirOverride: home, apiKey: realKey });

    expect(result.apiKeyFilled).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.providers.deepseek.apiKey).toBe(realKey);
  });

  it('--provider openai + --api-key 一起 → key 落在 openai entry 上', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, provider: 'openai', apiKey: 'sk-openai-key' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.providers.openai.apiKey).toBe('sk-openai-key');
    expect(cfg.providers.deepseek).toBeUndefined();
  });

  it('不传 apiKey → entry 无 apiKey 字段，apiKeyFilled=false', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home });
    expect(result.apiKeyFilled).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.providers.deepseek.apiKey).toBeUndefined();
  });
});

describe('runInit — provider 选择', () => {
  it('非默认 provider → config.json 含 providers 表 + activeProvider', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home, provider: 'qwen' });

    expect(result.wrote).toBe(true);
    expect(result.configFile).toBe(path.join(home, 'config.json'));

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.activeProvider).toBe('qwen');
    expect(cfg.providers.qwen).toBeDefined();
    expect(cfg.providers.qwen.baseURL).toContain('dashscope');
    // 没传 watch-dir → 不该有 watchDirs
    expect(cfg.watchDirs).toBeUndefined();
  });

  it('未知 provider id → 抛错', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    expect(() => runInit({ homeDirOverride: home, provider: 'nonexistent' })).toThrow(
      /Unknown provider/,
    );
  });
});

describe('runInit — --watch-dir', () => {
  it('watchDir → 写 config.json，含 watchDirs[0].path，initialScan=true（默认）', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const watchDir = '/Users/me/Obsidian';

    const result = runInit({ homeDirOverride: home, watchDir });

    expect(result.wrote).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.watchDirs).toHaveLength(1);
    expect(cfg.watchDirs[0].path).toBe(watchDir);
    expect(cfg.watchDirs[0].collectionFromSubdir).toBe(true);
    expect(cfg.watchDirs[0].initialScan).toBe(true);
  });

  it('显式 initialScan=false → 关掉首次扫描', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, watchDir: '/tmp/v', initialScan: false });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.watchDirs[0].initialScan).toBe(false);
  });

  it('watchDir 自动进 additionalReadPaths（否则 watcher 沙箱拒绝启动）', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, watchDir: '/Users/me/Obsidian' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.additionalReadPaths).toEqual(['/Users/me/Obsidian']);
  });

  it('没设 watchDir → 不写 additionalReadPaths', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, provider: 'openai' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.additionalReadPaths).toBeUndefined();
  });

  it('非默认 provider + watchDir → config.json 同时包含两者', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, provider: 'openai', watchDir: '/tmp/vault' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.activeProvider).toBe('openai');
    expect(cfg.watchDirs[0].path).toBe('/tmp/vault');
    expect(cfg.watchDirs[0].initialScan).toBe(true);
  });
});

describe('previewWatchDir', () => {
  it('真实目录里有 3 个 .md → count=3，missing=false', () => {
    const dir = path.join(tmpDir, 'vault');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'b.markdown'), 'b');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'c.md'), 'c');
    // 非支持扩展不被算
    fs.writeFileSync(path.join(dir, 'noise.json'), '{}');

    const r = previewWatchDir(dir);
    expect(r?.missing).toBe(false);
    expect(r?.count).toBe(3);
    expect(r?.capped).toBe(false);
    expect(r?.absPath).toBe(path.resolve(dir));
  });

  it('目录不存在 → missing=true，count=0', () => {
    const r = previewWatchDir(path.join(tmpDir, 'nope'));
    expect(r?.missing).toBe(true);
    expect(r?.count).toBe(0);
  });

  it('空目录 → count=0，missing=false', () => {
    const dir = path.join(tmpDir, 'empty');
    fs.mkdirSync(dir);
    const r = previewWatchDir(dir);
    expect(r?.missing).toBe(false);
    expect(r?.count).toBe(0);
  });

  it('runInit 自动填充 watchDirPreview（initialScan 默认 true）', () => {
    const dir = path.join(tmpDir, 'vault2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');
    fs.writeFileSync(path.join(dir, 'y.pdf'), 'y');

    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home, watchDir: dir });
    expect(result.watchDirPreview).toBeDefined();
    expect(result.watchDirPreview!.count).toBe(2);
  });

  it('runInit 在 initialScan=false 时不算预览（省 I/O）', () => {
    const dir = path.join(tmpDir, 'vault3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');

    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home, watchDir: dir, initialScan: false });
    expect(result.watchDirPreview).toBeUndefined();
  });
});

describe('formatInitResult — watchDirPreview 输出', () => {
  const ds = lookupProvider('deepseek');
  const base = { configFile: '/x/config.json', wrote: true, apiKeyFilled: false, provider: ds };

  it('有文件 → 蓝色提示 "will queue N existing file(s)"', () => {
    const result = {
      ...base,
      watchDirPreview: { absPath: '/foo', count: 12, capped: false, missing: false },
    };
    const out = formatInitResult(result);
    expect(out).toContain('/foo');
    expect(out).toContain('12 existing files');
    expect(out).toContain('--no-initial-scan');
  });

  it('1 个文件 → 单数 "file" 而不是 "files"', () => {
    const result = {
      ...base,
      watchDirPreview: { absPath: '/foo', count: 1, capped: false, missing: false },
    };
    expect(formatInitResult(result)).toContain('1 existing file ');
  });

  it('命中 cap → 显示 "10000+"', () => {
    const result = {
      ...base,
      watchDirPreview: { absPath: '/big', count: 10000, capped: true, missing: false },
    };
    expect(formatInitResult(result)).toContain('10000+');
  });

  it('目录不存在 → 黄色警告 "does not exist yet"', () => {
    const result = {
      ...base,
      watchDirPreview: { absPath: '/missing', count: 0, capped: false, missing: true },
    };
    const out = formatInitResult(result);
    expect(out).toContain('does not exist yet');
    expect(out).toContain('/missing');
  });

  it('count=0 但目录存在 → 灰色"no supported files yet"', () => {
    const result = {
      ...base,
      watchDirPreview: { absPath: '/empty', count: 0, capped: false, missing: false },
    };
    const out = formatInitResult(result);
    expect(out).toContain('no supported files yet');
  });
});

describe('PROVIDER_CATALOG / lookupProvider', () => {
  it('包含 5 个 provider，且都有必备字段', () => {
    expect(PROVIDER_CATALOG.length).toBe(5);
    for (const p of PROVIDER_CATALOG) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(p.baseURL).toMatch(/^https?:\/\//);
      expect(p.model).toBeTruthy();
      expect(p.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('id 全部唯一', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEFAULT_PROVIDER_ID 在目录里', () => {
    expect(PROVIDER_CATALOG.find((p) => p.id === DEFAULT_PROVIDER_ID)).toBeDefined();
  });

  it('lookupProvider 已知 id → 拿到对象', () => {
    expect(lookupProvider('deepseek').apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('lookupProvider 未知 id → 抛错，错误信息含已知 id 列表', () => {
    expect(() => lookupProvider('bogus')).toThrow(/Unknown provider "bogus"/);
    expect(() => lookupProvider('bogus')).toThrow(/deepseek/);
  });
});

describe('renderConfigJson —— 纯函数', () => {
  it('不带 key → entry 无 apiKey', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('qwen'), undefined, undefined));
    expect(out.providers.qwen.apiKey).toBeUndefined();
    expect(out.activeProvider).toBe('qwen');
  });

  it('带 key → entry 含字面 apiKey', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('openai'), 'sk-actual', undefined));
    expect(out.providers.openai.apiKey).toBe('sk-actual');
  });

  it('不带 watchDir → 无 watchDirs 字段', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('qwen'), undefined, undefined));
    expect(out.watchDirs).toBeUndefined();
  });

  it('带 watchDir → watchDirs 数组，initialScan=true（默认）', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('deepseek'), undefined, '/foo/bar'));
    expect(out.watchDirs).toHaveLength(1);
    expect(out.watchDirs[0].path).toBe('/foo/bar');
    expect(out.watchDirs[0].initialScan).toBe(true);
  });

  it('initialScan=false 显式关掉', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('deepseek'), undefined, '/foo', false));
    expect(out.watchDirs[0].initialScan).toBe(false);
  });
});

describe('formatInitResult — 输出消息', () => {
  const ds = lookupProvider('deepseek');

  it('wrote=true 时含 ✓ + configFile 路径 + next-step 提示', () => {
    const result = { configFile: '/x/config.json', wrote: true, apiKeyFilled: false, provider: ds };
    const out = formatInitResult(result);
    expect(out).toContain('✓');
    expect(out).toContain('/x/config.json');
    expect(out).toContain('next:');
    expect(out).toContain('apiKey');
  });

  it('wrote=false → ✗ 提示用 --force', () => {
    const result = { configFile: '/x/config.json', wrote: false, apiKeyFilled: false, provider: ds };
    const out = formatInitResult(result);
    expect(out).toContain('✗');
    expect(out).toContain('--force');
  });

  it('apiKeyFilled=true → 输出提示 key 已写入', () => {
    const result = { configFile: '/x/config.json', wrote: true, apiKeyFilled: true, provider: ds };
    const out = formatInitResult(result);
    expect(out).toContain('written to config.json');
  });

  it('有 backupFile → 输出里显示备份路径', () => {
    const result = {
      configFile: '/x/config.json',
      wrote: true,
      apiKeyFilled: false,
      backupFile: '/x/config.json.pre-init.bak',
      provider: ds,
    };
    const out = formatInitResult(result, { force: true });
    expect(out).toContain('backup:');
    expect(out).toContain('config.json.pre-init.bak');
  });
});
