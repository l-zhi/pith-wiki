/**
 * Config 解析单元测试。
 *
 * 重点测 parseReadPathsFromEnv —— 这是 .env / 环境变量里把"路径列表"喂给系统
 * 的入口。两种语法（JSON 数组与分隔符串）都要稳定，并且 ~ 展开要正确。
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReadPathsFromEnv } from '../src/config.js';

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

describe('process.env 端到端（loadConfig 钩进 LLM_WIKI_READ_PATHS）', () => {
  // 这一组没有直接测 loadConfig（因为它会读 ~/.llm-wiki/config.json，要 mock 文件系统才公平），
  // 但通过临时设置 process.env.LLM_WIKI_READ_PATHS 验证 parseReadPathsFromEnv 在
  // 真实环境变量值上工作。
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.LLM_WIKI_READ_PATHS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.LLM_WIKI_READ_PATHS;
    else process.env.LLM_WIKI_READ_PATHS = original;
  });

  it('从真实 process.env 取到 JSON 数组并解析', () => {
    process.env.LLM_WIKI_READ_PATHS = '["/tmp/a","/tmp/b"]';
    expect(parseReadPathsFromEnv(process.env.LLM_WIKI_READ_PATHS)).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('从真实 process.env 取到分隔符串并解析', () => {
    process.env.LLM_WIKI_READ_PATHS = `/tmp/a${path.delimiter}/tmp/b`;
    expect(parseReadPathsFromEnv(process.env.LLM_WIKI_READ_PATHS)).toEqual(['/tmp/a', '/tmp/b']);
  });
});
