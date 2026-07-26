/**
 * Config 解析单元测试。
 *
 * 重点测 parseReadPathsFromEnv —— 这是 .env / 环境变量里把"路径列表"喂给系统
 * 的入口。两种语法（JSON 数组与分隔符串）都要稳定，并且 ~ 展开要正确。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyActiveProvider,
  loadConfig,
  parsePositiveIntEnv,
  parseReadPathsFromEnv,
  pickHydrationProvider,
  requireApiKey,
  resolveProviderEntry,
  type Config,
} from '../src/config.js';

// 文件级 isolation：让所有 loadConfig 调用看不到维护者本机的 ~/.pith-wiki/config.json。
// 通过 PITH_WIKI_CONFIG_PATH 把 loadFileConfig 指向一个不存在的临时路径，等价于"没有配置文件"。
// 不这样做的话，本仓库的开发者只要本地放过 config.json，这个 test 文件就会红。
const ORIGINAL_PITH_WIKI_CONFIG_PATH = process.env.PITH_WIKI_CONFIG_PATH;
const ISOLATED_CONFIG_PATH = path.join(
  os.tmpdir(),
  `pith-wiki-config-test-nonexistent-${process.pid}-${Date.now()}.json`,
);

beforeAll(() => {
  process.env.PITH_WIKI_CONFIG_PATH = ISOLATED_CONFIG_PATH;
});

afterAll(() => {
  if (ORIGINAL_PITH_WIKI_CONFIG_PATH === undefined) {
    delete process.env.PITH_WIKI_CONFIG_PATH;
  } else {
    process.env.PITH_WIKI_CONFIG_PATH = ORIGINAL_PITH_WIKI_CONFIG_PATH;
  }
});

describe('parseReadPathsFromEnv — JSON 数组语法', () => {
  it('标准 JSON 数组被解析成路径数组', () => {
    expect(parseReadPathsFromEnv('["/a","/b","/c"]')).toEqual(['/a', '/b', '/c']);
  });

  it('JSON 数组前后带空格也能解析', () => {
    expect(parseReadPathsFromEnv('  ["/a", "/b"]  ')).toEqual(['/a', '/b']);
  });

  it('JSON 数组里的 ~/ 自动展开成 home 目录', () => {
    const out = parseReadPathsFromEnv('["~/notes", "~/papers"]');
    expect(out).toEqual([path.join(os.homedir(), 'notes'), path.join(os.homedir(), 'papers')]);
  });

  it('JSON 数组里单独的 ~ 等于 home 目录', () => {
    const out = parseReadPathsFromEnv('["~"]');
    expect(out).toEqual([os.homedir()]);
  });

  it('空 JSON 数组返回 undefined（让上层走默认）', () => {
    expect(parseReadPathsFromEnv('[]')).toBeUndefined();
  });

  it('JSON 数组里掺空字符串会被过滤掉', () => {
    expect(parseReadPathsFromEnv('["", "/a", " "]')).toEqual(['/a']);
  });

  it('非法 JSON 抛出可读错误（不静默吞）', () => {
    // 实施意图：如果用户写错了语法，应该立刻知道，而不是悄悄回退到分隔符模式
    // 把整段 JSON 当一个路径处理。
    expect(() => parseReadPathsFromEnv('[not json')).toThrow(/JSON/);
  });

  it('JSON 不是数组（是对象）抛错', () => {
    expect(() => parseReadPathsFromEnv('{"foo":"bar"}')).toThrow(/array/);
  });

  it('JSON 数组里有非字符串元素抛错', () => {
    expect(() => parseReadPathsFromEnv('["/a", 42]')).toThrow(/string/);
  });
});

describe('parseReadPathsFromEnv — 分隔符语法', () => {
  it('单条路径不带分隔符正常返回', () => {
    expect(parseReadPathsFromEnv('/a')).toEqual(['/a']);
  });

  it(`使用 path.delimiter (${path.delimiter}) 分隔多条路径`, () => {
    const input = ['/a', '/b', '/c'].join(path.delimiter);
    expect(parseReadPathsFromEnv(input)).toEqual(['/a', '/b', '/c']);
  });

  it('分隔符语法里的 ~/ 也展开', () => {
    const input = ['~/notes', '/abs/path'].join(path.delimiter);
    expect(parseReadPathsFromEnv(input)).toEqual([
      path.join(os.homedir(), 'notes'),
      '/abs/path',
    ]);
  });

  it('分隔符之间的空白被 trim', () => {
    const input = ` /a ${path.delimiter} /b `;
    expect(parseReadPathsFromEnv(input)).toEqual(['/a', '/b']);
  });

  it('连续分隔符产生的空段被过滤', () => {
    const input = `/a${path.delimiter}${path.delimiter}/b`;
    expect(parseReadPathsFromEnv(input)).toEqual(['/a', '/b']);
  });
});

describe('parseReadPathsFromEnv — 输入边界', () => {
  it('undefined 返回 undefined（让上层走更低优先级配置源）', () => {
    expect(parseReadPathsFromEnv(undefined)).toBeUndefined();
  });

  it('空字符串返回 undefined', () => {
    expect(parseReadPathsFromEnv('')).toBeUndefined();
  });

  it('纯空白返回 undefined', () => {
    expect(parseReadPathsFromEnv('   ')).toBeUndefined();
  });

  it('只有一个分隔符产生全部空段，最终返回 undefined', () => {
    expect(parseReadPathsFromEnv(path.delimiter)).toBeUndefined();
  });
});

describe('parseReadPathsFromEnv — 集成：.env 实际写法', () => {
  // 模拟用户在 .env 文件里可能写的若干合法 / 不合法形式，
  // 锁定我们对各种"野生输入"的容错。

  it('用户用 JSON 数组配置两条本地目录', () => {
    const env = '["~/research/papers", "~/Library/Mobile Documents"]';
    expect(parseReadPathsFromEnv(env)).toEqual([
      path.join(os.homedir(), 'research/papers'),
      path.join(os.homedir(), 'Library/Mobile Documents'),
    ]);
  });

  it('用户用分隔符配置混合绝对/家目录路径', () => {
    const env = `~/notes${path.delimiter}/Volumes/External/papers`;
    expect(parseReadPathsFromEnv(env)).toEqual([
      path.join(os.homedir(), 'notes'),
      '/Volumes/External/papers',
    ]);
  });
});

describe('process.env 端到端（loadConfig 钩进 PITH_WIKI_READ_PATHS）', () => {
  // 这一组没有直接测 loadConfig（因为它会读 ~/.pith-wiki/config.json，要 mock 文件系统才公平），
  // 但通过临时设置 process.env.PITH_WIKI_READ_PATHS 验证 parseReadPathsFromEnv 在
  // 真实环境变量值上工作。
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.PITH_WIKI_READ_PATHS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PITH_WIKI_READ_PATHS;
    else process.env.PITH_WIKI_READ_PATHS = original;
  });

  it('从真实 process.env 取到 JSON 数组并解析', () => {
    process.env.PITH_WIKI_READ_PATHS = '["/tmp/a","/tmp/b"]';
    expect(parseReadPathsFromEnv(process.env.PITH_WIKI_READ_PATHS)).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('从真实 process.env 取到分隔符串并解析', () => {
    process.env.PITH_WIKI_READ_PATHS = `/tmp/a${path.delimiter}/tmp/b`;
    expect(parseReadPathsFromEnv(process.env.PITH_WIKI_READ_PATHS)).toEqual(['/tmp/a', '/tmp/b']);
  });
});

/**
 * Multi-provider 解析测试。
 *
 * 重点：
 *   1. resolveProviderEntry 优先级（apiKey 字面 > apiKeyEnv > 空）
 *   2. applyActiveProvider 把 entry 覆盖到顶层 apiKey/baseURL/model
 *   3. activeProvider 指向不存在的 entry → 抛错（不能 silent 回退）
 *   4. loadConfig 端到端：CLI override > env > 配置文件 activeProvider
 */
describe('multi-provider — resolveProviderEntry', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      QWEN_KEY: process.env.QWEN_KEY,
      DEEPSEEK_KEY: process.env.DEEPSEEK_KEY,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('字面 apiKey 直接返回', () => {
    const r = resolveProviderEntry({
      baseURL: 'https://api.example.com',
      model: 'm',
      apiKey: 'literal-key',
    });
    expect(r).toEqual({
      apiKey: 'literal-key',
      baseURL: 'https://api.example.com',
      model: 'm',
      supportsJsonMode: true, // 缺省视为支持
    });
  });

  it('apiKeyEnv → 从 process.env 取值', () => {
    process.env.QWEN_KEY = 'sk-from-env';
    const r = resolveProviderEntry({
      baseURL: 'https://api.example.com',
      model: 'm',
      apiKeyEnv: 'QWEN_KEY',
    });
    expect(r.apiKey).toBe('sk-from-env');
  });

  it('字面 apiKey 和 apiKeyEnv 都给 → 字面优先', () => {
    process.env.QWEN_KEY = 'env-key';
    const r = resolveProviderEntry({
      baseURL: 'https://api.example.com',
      model: 'm',
      apiKey: 'literal',
      apiKeyEnv: 'QWEN_KEY',
    });
    expect(r.apiKey).toBe('literal');
  });

  it('字面 apiKey 是空串 → 退化到 apiKeyEnv', () => {
    process.env.QWEN_KEY = 'env-key';
    const r = resolveProviderEntry({
      baseURL: 'https://api.example.com',
      model: 'm',
      apiKey: '',
      apiKeyEnv: 'QWEN_KEY',
    });
    expect(r.apiKey).toBe('env-key');
  });

  it('两者都没给 → 空串（让 require API key 在调用时报错）', () => {
    const r = resolveProviderEntry({ baseURL: 'https://api.example.com', model: 'm' });
    expect(r.apiKey).toBe('');
  });

  it('supportsJsonMode 缺省 → true', () => {
    const r = resolveProviderEntry({ baseURL: 'https://api.example.com', model: 'm' });
    expect(r.supportsJsonMode).toBe(true);
  });

  it('supportsJsonMode 显式 false 透传（doubao coding endpoint 类）', () => {
    const r = resolveProviderEntry({
      baseURL: 'https://api.example.com',
      model: 'm',
      supportsJsonMode: false,
    });
    expect(r.supportsJsonMode).toBe(false);
  });
});

describe('multi-provider — applyActiveProvider', () => {
  function baseConfig(extra: Partial<Config> = {}): Config {
    return {
      apiKey: 'top-level-key',
      baseURL: 'https://top-level.example.com',
      model: 'top-level-model',
      providers: {},
      activeProvider: undefined,
      workspaceRoot: '/tmp/ws',
      wikiRoot: '/tmp/wiki',
      readOnly: false,
      maxToolPayloadBytes: 100_000,
      historyFile: '/tmp/h',
      additionalReadPaths: [],
      queueStatePath: '/tmp/q/state.json',
      queueLogDir: '/tmp/q/logs',
      queueConcurrency: 2,
      queueMaxAttempts: 3,
      queueAutoStart: true,
      watchDirs: [],
      watchAutoStart: true,
      outputDir: '/tmp/out',
      transcriptEnabled: true,
      digestCollection: 'output',
      ...extra,
    } as Config;
  }

  it('activeProvider 未设 → 顶层值原样返回（v0 单 provider 行为）', () => {
    const result = applyActiveProvider(baseConfig());
    expect(result.apiKey).toBe('top-level-key');
    expect(result.baseURL).toBe('https://top-level.example.com');
    expect(result.model).toBe('top-level-model');
  });

  it('activeProvider 指向有效 entry → entry 的值覆盖顶层', () => {
    const cfg = baseConfig({
      providers: {
        qwen: {
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKey: 'qwen-literal',
        },
      },
      activeProvider: 'qwen',
    });
    const result = applyActiveProvider(cfg);
    expect(result.apiKey).toBe('qwen-literal');
    expect(result.baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(result.model).toBe('qwen-plus');
    // 非 provider 字段保持
    expect(result.workspaceRoot).toBe('/tmp/ws');
  });

  it('entry 声明 supportsJsonMode=false → 折到顶层 config.supportsJsonMode', () => {
    const cfg = baseConfig({
      providers: {
        doubao: {
          baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
          model: 'DeepSeek-V4-Flash',
          apiKey: 'k',
          supportsJsonMode: false,
        },
      },
      activeProvider: 'doubao',
    });
    const result = applyActiveProvider(cfg);
    expect(result.supportsJsonMode).toBe(false);
  });

  it('entry 不声明 supportsJsonMode → 顶层默认 true', () => {
    const cfg = baseConfig({
      providers: {
        qwen: { baseURL: 'https://x.example.com', model: 'q', apiKey: 'k' },
      },
      activeProvider: 'qwen',
    });
    const result = applyActiveProvider(cfg);
    expect(result.supportsJsonMode).toBe(true);
  });

  it('activeProvider 指向不存在的 entry → 抛错（避免静默用顶层 fallback）', () => {
    const cfg = baseConfig({
      providers: {
        qwen: { baseURL: 'https://x', model: 'q' },
      },
      activeProvider: 'openai',
    });
    expect(() => applyActiveProvider(cfg)).toThrow(/not found/);
  });

  it('codex entry（无 baseURL）→ providerKind=codex + baseURL 占位兜底', () => {
    const cfg = baseConfig({
      providers: {
        codex: { kind: 'codex', model: 'gpt-5.6-sol' },
      },
      activeProvider: 'codex',
    });
    const result = applyActiveProvider(cfg);
    expect(result.providerKind).toBe('codex');
    expect(result.model).toBe('gpt-5.6-sol');
    // createClient 会 new OpenAI（即便 codex 分支从不调用它），故顶层 baseURL 必须合法
    expect(() => new URL(result.baseURL)).not.toThrow();
  });
});

describe('委托型 CLI provider — codex', () => {
  it('resolveProviderEntry：codex 无 baseURL → 占位 https://api.openai.com', () => {
    const r = resolveProviderEntry({ kind: 'codex', model: 'gpt-5.6-sol' });
    expect(r.baseURL).toBe('https://api.openai.com');
  });

  it('pickHydrationProvider：codex 永不入选水合（不能做批量 JSON 水合）', () => {
    const cfg = {
      providers: {
        codex: { kind: 'codex', model: 'gpt-5.6-sol' },
      },
      hydrationProvider: undefined,
    } as unknown as Config;
    expect(pickHydrationProvider(cfg)).toBeUndefined();
  });

  it('pickHydrationProvider：显式选 codex 也被拒（回退到自动选 openai）', () => {
    const cfg = {
      providers: {
        codex: { kind: 'codex', model: 'gpt-5.6-sol' },
        api: { kind: 'openai', baseURL: 'https://x.example.com', model: 'm', apiKey: 'k' },
      },
      hydrationProvider: 'codex',
    } as unknown as Config;
    // 显式选了 codex（非法）→ 跳过，自动落到第一个 openai
    expect(pickHydrationProvider(cfg)?.model).toBe('m');
  });

  it('requireApiKey：codex 在 CLI 侧 fail-fast（委托型 provider 仅桌面端可用）', () => {
    const cfg = { providerKind: 'codex', activeProvider: 'codex', apiKey: '' } as unknown as Config;
    expect(() => requireApiKey(cfg)).toThrow(/desktop-only|codex/);
  });
});

describe('multi-provider — loadConfig 端到端', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      PITH_WIKI_PROVIDER: process.env.PITH_WIKI_PROVIDER,
      DEEPSEEK_KEY: process.env.DEEPSEEK_KEY,
      QWEN_KEY: process.env.QWEN_KEY,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('CLI override 的 activeProvider 覆盖 env', () => {
    process.env.PITH_WIKI_PROVIDER = 'qwen';
    process.env.QWEN_KEY = 'qwen-env';
    process.env.DEEPSEEK_KEY = 'deepseek-env';
    const cfg = loadConfig({
      activeProvider: 'deepseek',
      providers: {
        deepseek: {
          baseURL: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKeyEnv: 'DEEPSEEK_KEY',
        },
        qwen: {
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKeyEnv: 'QWEN_KEY',
        },
      },
    });
    // CLI 赢：active 是 deepseek
    expect(cfg.activeProvider).toBe('deepseek');
    expect(cfg.apiKey).toBe('deepseek-env');
    expect(cfg.model).toBe('deepseek-chat');
  });

  it('env PITH_WIKI_PROVIDER 在没 CLI override 时被采用', () => {
    process.env.PITH_WIKI_PROVIDER = 'qwen';
    process.env.QWEN_KEY = 'qwen-from-env';
    const cfg = loadConfig({
      providers: {
        deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
        qwen: {
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKeyEnv: 'QWEN_KEY',
        },
      },
    });
    expect(cfg.activeProvider).toBe('qwen');
    expect(cfg.apiKey).toBe('qwen-from-env');
    expect(cfg.model).toBe('qwen-plus');
  });

  it('providers 空 + activeProvider 也空 → 完全 v0 行为（顶层默认）', () => {
    delete process.env.PITH_WIKI_PROVIDER;
    const cfg = loadConfig({});
    expect(cfg.activeProvider).toBeUndefined();
    expect(cfg.providers).toEqual({});
    // baseURL 走 DEFAULTS
    expect(cfg.baseURL).toBe('https://api.deepseek.com');
  });
});

/**
 * PITH_WIKI_CONFIG_PATH env 契约。
 *
 * 这条 env 让 `loadFileConfig` 改读指定路径而不是默认的 `~/.pith-wiki/config.json`。
 * 目的：测试隔离（让 npm test 在维护者机器上不被本地真实 config 污染）+ 嵌入场景的
 * 自定义配置文件路径。下面三个 case 把这条契约焊死，未来不会被无意改坏。
 *
 * 注：本文件顶部已经有 beforeAll 把 PITH_WIKI_CONFIG_PATH 指向不存在的路径；
 * 下面三个 case 各自临时改写 env，afterEach 还原成那个不存在的"全文件 isolation 路径"。
 */
describe('PITH_WIKI_CONFIG_PATH — 显式 config 文件路径', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-wiki-config-path-'));
  });

  afterEach(() => {
    // 还原成文件级 isolation 设置的"不存在路径"。
    process.env.PITH_WIKI_CONFIG_PATH = ISOLATED_CONFIG_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('指向有效 config.json → loadConfig 读得到它的字段', () => {
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        providers: {
          custom: { baseURL: 'https://custom.example.com/v1', model: 'custom-model' },
        },
        activeProvider: 'custom',
      }),
    );
    process.env.PITH_WIKI_CONFIG_PATH = cfgFile;

    const cfg = loadConfig({});
    expect(cfg.activeProvider).toBe('custom');
    expect(cfg.baseURL).toBe('https://custom.example.com/v1');
    expect(cfg.model).toBe('custom-model');
  });

  it('config 文件的 hydrationProvider / reviewProvider 会被带进 config（回归：曾漏进 merged）', () => {
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        providers: {
          a: { baseURL: 'https://a.example.com/v1', model: 'ma' },
          b: { baseURL: 'https://b.example.com/v1', model: 'mb' },
        },
        activeProvider: 'a',
        hydrationProvider: 'b',
        reviewProvider: 'b',
        reviewMaxRounds: 3,
      }),
    );
    process.env.PITH_WIKI_CONFIG_PATH = cfgFile;

    const cfg = loadConfig({});
    expect(cfg.hydrationProvider).toBe('b');
    expect(cfg.reviewProvider).toBe('b');
    expect(cfg.reviewMaxRounds).toBe(3);
  });

  it('reviewMaxRounds 缺省为 2', () => {
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ providers: {}, activeProvider: undefined }));
    process.env.PITH_WIKI_CONFIG_PATH = cfgFile;
    expect(loadConfig({}).reviewMaxRounds).toBe(2);
  });

  it('指向不存在的文件 → 等价于"没有 config"（silent fallback 到默认 + overrides）', () => {
    process.env.PITH_WIKI_CONFIG_PATH = path.join(tmpDir, 'does-not-exist.json');

    const cfg = loadConfig({});
    // 没有任何 provider 配置 → 顶层默认 baseURL
    expect(cfg.activeProvider).toBeUndefined();
    expect(cfg.providers).toEqual({});
    expect(cfg.baseURL).toBe('https://api.deepseek.com');
  });

  it('指向格式错误的 JSON → 抛带文件路径的可读错误', () => {
    const cfgFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(cfgFile, '{ not valid json');
    process.env.PITH_WIKI_CONFIG_PATH = cfgFile;

    expect(() => loadConfig({})).toThrow(/Failed to parse/);
    expect(() => loadConfig({})).toThrow(cfgFile);
  });
});

describe('parsePositiveIntEnv — LLM 请求超时解析', () => {
  it('正整数字符串 → number', () => {
    expect(parsePositiveIntEnv('60000')).toBe(60000);
    expect(parsePositiveIntEnv('  90000  ')).toBe(90000);
  });
  it('空 / undefined / 非数字 / 非正 / 小数 → undefined（回落默认）', () => {
    expect(parsePositiveIntEnv(undefined)).toBeUndefined();
    expect(parsePositiveIntEnv('')).toBeUndefined();
    expect(parsePositiveIntEnv('abc')).toBeUndefined();
    expect(parsePositiveIntEnv('0')).toBeUndefined();
    expect(parsePositiveIntEnv('-5')).toBeUndefined();
    expect(parsePositiveIntEnv('1.5')).toBeUndefined();
  });
});

describe('requestTimeoutMs — 配置链', () => {
  const original = process.env.PITH_WIKI_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.PITH_WIKI_TIMEOUT_MS;
    else process.env.PITH_WIKI_TIMEOUT_MS = original;
  });
  it('默认 120_000', () => {
    delete process.env.PITH_WIKI_TIMEOUT_MS;
    expect(loadConfig({}).requestTimeoutMs).toBe(120_000);
  });
  it('PITH_WIKI_TIMEOUT_MS 覆盖默认', () => {
    process.env.PITH_WIKI_TIMEOUT_MS = '45000';
    expect(loadConfig({}).requestTimeoutMs).toBe(45_000);
  });
  it('overrides 优先级高于 env', () => {
    process.env.PITH_WIKI_TIMEOUT_MS = '45000';
    expect(loadConfig({ requestTimeoutMs: 5000 }).requestTimeoutMs).toBe(5000);
  });
});
