/**
 * `pith-wiki init` 单元测试。
 *
 * 用 homeDirOverride 把目标 home 指到 tmpdir，避免污染开发者本机的 ~/.pith-wiki/。
 * 覆盖：
 *   - 全新安装路径：minimal .env 内容 + chmod 600
 *   - 幂等：已存在 .env 不覆盖
 *   - --force：备份 + 覆盖
 *   - --api-key：内联进 .env 而不是留占位符
 *   - --provider：写 config.json + activeProvider 正确
 *   - --watch-dir：config.json 里有 watchDirs 条目
 *   - 默认 provider（deepseek）+ 无 watchDir → 不写 config.json
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
  renderEnv,
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

describe('runInit — 全新安装（默认 provider，最简）', () => {
  it('home 不存在 → mkdir + 写 .env，wrote=true，wroteConfig=false', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    expect(fs.existsSync(home)).toBe(false);

    const result = runInit({ homeDirOverride: home });

    expect(result.wrote).toBe(true);
    expect(result.wroteConfig).toBe(false);
    expect(result.envFile).toBe(path.join(home, '.env'));
    expect(result.configFile).toBeUndefined();
    expect(result.backupFile).toBeUndefined();
    expect(result.provider.id).toBe(DEFAULT_PROVIDER_ID);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
  });

  it('写出的 .env 是最小化的——只含 DEEPSEEK_API_KEY 一行，没有注释墙', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');

    // 必须含：占位符
    expect(body).toContain('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');

    // 必须不含：旧版模板里那些 commented-out 字段
    expect(body).not.toMatch(/PITH_WIKI_PROVIDER/);
    expect(body).not.toMatch(/PITH_WIKI_READ_PATHS/);
    expect(body).not.toMatch(/PITH_WIKI_BASE_URL/);
    expect(body).not.toMatch(/DASHSCOPE_API_KEY/);

    // 行数应当很少（一个 header 注释 + 一行 KV，可能加尾换行 = 3 行内）
    expect(body.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(2);
  });

  it('chmod 600：仅 owner 可读写（POSIX 平台）', () => {
    if (process.platform === 'win32') return;
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    const stat = fs.statSync(path.join(home, '.env'));
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
    expect(fs.readFileSync(result.backupFile!, 'utf8')).toBe('OLD_CONTENT=keep_safe\n');
    expect(fs.readFileSync(existing, 'utf8')).toContain('DEEPSEEK_API_KEY=');
  });

  it('config.json 已存在 + --force → 备份 + 覆盖（同 .env 规则）', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    fs.mkdirSync(home);
    const cfg = path.join(home, 'config.json');
    fs.writeFileSync(cfg, '{"old":true}', 'utf8');

    const result = runInit({ homeDirOverride: home, provider: 'openai', force: true });

    expect(result.wroteConfig).toBe(true);
    expect(result.configBackupFile).toBe(path.join(home, 'config.json.pre-init.bak'));
    expect(fs.readFileSync(result.configBackupFile!, 'utf8')).toBe('{"old":true}');
    const newCfg = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(newCfg.activeProvider).toBe('openai');
  });
});

describe('runInit — --api-key 内联', () => {
  it('传 apiKey → 写到选中 provider 的 env var 那行', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const realKey = 'sk-real-deadbeef-fake-token';

    runInit({ homeDirOverride: home, apiKey: realKey });

    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(body).toContain(`DEEPSEEK_API_KEY=${realKey}`);
    expect(body).not.toContain('sk-xxxxxxxxxxxxxxxx');
  });

  it('--provider openai + --api-key 一起 → 用 OPENAI_API_KEY 作为变量名', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, provider: 'openai', apiKey: 'sk-openai-key' });
    const body = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(body).toContain('OPENAI_API_KEY=sk-openai-key');
    expect(body).not.toContain('DEEPSEEK_API_KEY');
  });

  it('不传 apiKey → 占位符保留', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home });
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toContain('sk-xxxxxxxxxxxxxxxx');
  });
});

describe('runInit — provider 选择', () => {
  it('默认 provider deepseek → 不写 config.json', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home, provider: 'deepseek' });
    expect(result.wroteConfig).toBe(false);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
  });

  it('非默认 provider → 写 config.json，含 providers 表 + activeProvider', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const result = runInit({ homeDirOverride: home, provider: 'qwen' });

    expect(result.wroteConfig).toBe(true);
    expect(result.configFile).toBe(path.join(home, 'config.json'));

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.activeProvider).toBe('qwen');
    expect(cfg.providers.qwen).toBeDefined();
    expect(cfg.providers.qwen.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
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
  it('默认 provider + watchDir → 写 config.json，含 watchDirs[0].path，initialScan=true（默认）', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    const watchDir = '/Users/me/Obsidian';

    const result = runInit({ homeDirOverride: home, watchDir });

    expect(result.wroteConfig).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.watchDirs).toHaveLength(1);
    expect(cfg.watchDirs[0].path).toBe(watchDir);
    expect(cfg.watchDirs[0].collectionFromSubdir).toBe(true);
    // 默认 true：init-时加 watch-dir 的语义就是"把这个目录入库"，
    // 老默认 false 导致"加了 watch 但什么都没动"的 UX bug。
    expect(cfg.watchDirs[0].initialScan).toBe(true);
  });

  it('显式 initialScan=false → 关掉首次扫描', () => {
    const home = path.join(tmpDir, '.pith-wiki');
    runInit({ homeDirOverride: home, watchDir: '/tmp/v', initialScan: false });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.watchDirs[0].initialScan).toBe(false);
  });

  it('watchDir 自动进 additionalReadPaths（否则 watcher 沙箱拒绝启动）', () => {
    // 真实 bug 复盘：init 写了 watchDirs 但没写 additionalReadPaths，watcher
    // resolveWatchTarget 报 "watch path outside read sandbox" 然后静默挂掉，
    // dashboard 还显示 watch 1/1 给用户"加了但没动"的诡异错觉。
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
    expect(cfg.watchDirs[0].initialScan).toBe(true); // 同样默认 true
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

  it('有文件 → 蓝色提示 "will queue N existing file(s)"', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: true,
      configFile: '/x/config.json',
      provider: ds,
      watchDirPreview: { absPath: '/foo', count: 12, capped: false, missing: false },
    };
    const out = formatInitResult(result);
    expect(out).toContain('/foo');
    expect(out).toContain('12 existing files');
    expect(out).toContain('--no-initial-scan');
  });

  it('1 个文件 → 单数 "file" 而不是 "files"', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: true,
      configFile: '/x/config.json',
      provider: ds,
      watchDirPreview: { absPath: '/foo', count: 1, capped: false, missing: false },
    };
    expect(formatInitResult(result)).toContain('1 existing file ');
  });

  it('命中 cap → 显示 "10000+"', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: true,
      configFile: '/x/config.json',
      provider: ds,
      watchDirPreview: { absPath: '/big', count: 10000, capped: true, missing: false },
    };
    expect(formatInitResult(result)).toContain('10000+');
  });

  it('目录不存在 → 黄色警告 "does not exist yet"', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: true,
      configFile: '/x/config.json',
      provider: ds,
      watchDirPreview: { absPath: '/missing', count: 0, capped: false, missing: true },
    };
    const out = formatInitResult(result);
    expect(out).toContain('does not exist yet');
    expect(out).toContain('/missing');
  });

  it('count=0 但目录存在 → 灰色"no supported files yet"', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: true,
      configFile: '/x/config.json',
      provider: ds,
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
    expect(() => lookupProvider('bogus')).toThrow(/deepseek/); // 列了已知 id 帮用户改正
  });
});

describe('renderEnv / renderConfigJson —— 纯函数', () => {
  it('renderEnv 不带 key → 占位符', () => {
    const out = renderEnv(lookupProvider('deepseek'), undefined);
    expect(out).toContain('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');
  });

  it('renderEnv 带 key → 内联', () => {
    const out = renderEnv(lookupProvider('openai'), 'sk-actual');
    expect(out).toContain('OPENAI_API_KEY=sk-actual');
  });

  it('renderConfigJson 不带 watchDir → 无 watchDirs 字段', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('qwen'), undefined));
    expect(out.watchDirs).toBeUndefined();
    expect(out.activeProvider).toBe('qwen');
  });

  it('renderConfigJson 带 watchDir → watchDirs 数组，initialScan=true（默认）', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('deepseek'), '/foo/bar'));
    expect(out.watchDirs).toHaveLength(1);
    expect(out.watchDirs[0].path).toBe('/foo/bar');
    expect(out.watchDirs[0].initialScan).toBe(true);
  });

  it('renderConfigJson initialScan=false 显式关掉', () => {
    const out = JSON.parse(renderConfigJson(lookupProvider('deepseek'), '/foo', false));
    expect(out.watchDirs[0].initialScan).toBe(false);
  });
});

describe('formatInitResult — 输出消息', () => {
  const ds = lookupProvider('deepseek');

  it('wrote=true 时含 ✓ + envFile 路径 + next-step 提示', () => {
    const result = { envFile: '/x/.env', wrote: true, wroteConfig: false, provider: ds };
    const out = formatInitResult(result);
    expect(out).toContain('✓');
    expect(out).toContain('/x/.env');
    expect(out).toContain('next:');
    expect(out).toContain('DEEPSEEK_API_KEY');
  });

  it('wrote=false + wroteConfig=false → ✗ 提示用 --force', () => {
    const result = { envFile: '/x/.env', wrote: false, wroteConfig: false, provider: ds };
    const out = formatInitResult(result);
    expect(out).toContain('✗');
    expect(out).toContain('--force');
  });

  it('apiKey 给了 → 输出提示 key 已内联', () => {
    const result = { envFile: '/x/.env', wrote: true, wroteConfig: false, provider: ds };
    const out = formatInitResult(result, { apiKey: 'sk-x' });
    expect(out).toContain('filled inline');
  });

  it('有 backupFile → 输出里显示备份路径', () => {
    const result = {
      envFile: '/x/.env',
      wrote: true,
      wroteConfig: false,
      backupFile: '/x/.env.pre-init.bak',
      provider: ds,
    };
    const out = formatInitResult(result, { force: true });
    expect(out).toContain('backup:');
    expect(out).toContain('.env.pre-init.bak');
  });

  it('写了 config.json 时也输出', () => {
    const result = {
      envFile: '/x/.env',
      configFile: '/x/config.json',
      wrote: true,
      wroteConfig: true,
      provider: lookupProvider('openai'),
    };
    const out = formatInitResult(result);
    expect(out).toContain('/x/config.json');
    expect(out).toContain('OPENAI_API_KEY');
  });
});
