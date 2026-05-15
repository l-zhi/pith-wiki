/**
 * Slash 命令注册表的纯函数单测：filterCommands + completeOnTab。
 * UI 渲染不在这里测——ink 组件在 vitest 里跑成本高，且这两个函数已经把
 * 行为锁住，渲染层只是把它们的结果摆出来。
 */
import { describe, expect, it } from 'vitest';
import {
  completeOnTab,
  filterCommands,
  SLASH_COMMANDS,
} from '../src/cli/slashCommands.js';

describe('filterCommands', () => {
  it('单个 "/" 返回全部主条目', () => {
    const result = filterCommands('/');
    expect(result).toHaveLength(SLASH_COMMANDS.length);
    expect(result.map((c) => c.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
  });

  it('按前缀过滤', () => {
    // /digest + /dashboard 都以 /d 开头
    expect(filterCommands('/d').map((c) => c.name).sort()).toEqual(['/dashboard', '/digest']);
    // /di 唯一命中 /digest
    expect(filterCommands('/di').map((c) => c.name)).toEqual(['/digest']);
    // /clear + /converters 都以 /c 开头
    expect(filterCommands('/c').map((c) => c.name)).toEqual(['/clear', '/converters']);
    expect(filterCommands('/r').map((c) => c.name)).toEqual(['/reset']);
  });

  it('多匹配前缀返回所有候选', () => {
    // /e + /exit, 没别的命令以 /e 开头 → 只有 /exit
    expect(filterCommands('/e').map((c) => c.name)).toEqual(['/exit']);
  });

  it('别名前缀也算匹配', () => {
    // /quit 是 /exit 的别名；/queue 本名也以 /q 开头 → 一并匹配
    expect(filterCommands('/q').map((c) => c.name).sort()).toEqual(['/exit', '/queue']);
  });

  it('完整命令名返回该条目', () => {
    expect(filterCommands('/help').map((c) => c.name)).toEqual(['/help']);
  });

  it('不以 / 开头返回空数组', () => {
    expect(filterCommands('hello')).toEqual([]);
    expect(filterCommands('')).toEqual([]);
  });

  it('不存在的前缀返回空', () => {
    expect(filterCommands('/zzz')).toEqual([]);
  });

  it('只取空格前的命令头做匹配，参数不参与', () => {
    // "/digest tech" 仍只过滤 /digest 这一条
    expect(filterCommands('/digest tech').map((c) => c.name)).toEqual(['/digest']);
  });
});

describe('completeOnTab', () => {
  it('无匹配 → 不变', () => {
    expect(completeOnTab('/zzz', [])).toBe('/zzz');
  });

  it('1 个匹配（无 takesArg）→ 完整补全', () => {
    // /cl 只匹配 /clear（/converters 不以 /cl 开头）
    const matches = filterCommands('/cl');
    expect(completeOnTab('/cl', matches)).toBe('/clear');
  });

  it('1 个匹配（takesArg）→ 补全后追加空格', () => {
    // /di 唯一匹配 /digest（takesArg=true），Tab 应补全为 "/digest "
    const matches = filterCommands('/di');
    expect(completeOnTab('/di', matches)).toBe('/digest ');
  });

  it('多匹配且共享前缀 → 取 LCP，不追加空格（哪怕其中有 takesArg）', () => {
    // /d 同时匹配 /digest 和 /dashboard，LCP 只是 /d 本身（/digest 以 /di 起头，
    // /dashboard 以 /da 起头）→ 输入未变长，completeOnTab 应原样返回。
    const matches = filterCommands('/d');
    expect(completeOnTab('/d', matches)).toBe('/d');
  });

  it('多匹配 → 取最长公共前缀', () => {
    // 构造一个假场景验证 LCP 逻辑
    const fakeMatches = [
      { name: '/foobar', description: 'a' },
      { name: '/foobaz', description: 'b' },
    ];
    expect(completeOnTab('/f', fakeMatches)).toBe('/fooba');
  });

  it('LCP 没比当前输入长 → 不变（避免 Tab 反复无效更新）', () => {
    const fakeMatches = [
      { name: '/abc', description: 'a' },
      { name: '/xyz', description: 'b' },
    ];
    expect(completeOnTab('/', fakeMatches)).toBe('/'); // LCP 是 "/"
  });

  it('已含空格（进入参数区）→ 不补全，让用户自由编辑参数', () => {
    const matches = filterCommands('/digest');
    // matches 里其实只有 /digest 一条，但因为 input 有空格，应保持原样
    expect(completeOnTab('/digest tech', matches)).toBe('/digest tech');
  });

  it('不以 / 开头 → 不变', () => {
    expect(completeOnTab('hello', [])).toBe('hello');
  });
});
