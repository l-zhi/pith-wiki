/**
 * SOUL.md 加载器单元测试。
 *
 * 测点：
 *   - 显式 soulFile（CLI/config）短路掉默认查找
 *   - PITH_WIKI_SOUL env 等价于 soulFile
 *   - 默认查找：~/.pith-wiki/SOUL.md + <workspaceRoot>/SOUL.md 叠加
 *   - 都不存在 → 空内容
 *   - 显式 soul 文件不存在 → 不退化到默认（语义清晰，避免 silent fallback）
 *   - composeSystemPrompt：空 soul → 原样；非空 → 追加 "## Voice and style" 段
 *
 * HOME 目录用 mkdtemp + monkey-patch os.homedir 隔离，避免污染真实 ~/.pith-wiki。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSystemPrompt, loadSoul } from '../src/llm/soul.js';

let tmpRoot: string;
let fakeHome: string;
let workspaceRoot: string;
let origHomedir: typeof os.homedir;
let origEnv: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-soul-'));
  fakeHome = path.join(tmpRoot, 'home');
  workspaceRoot = path.join(tmpRoot, 'project');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.pith-wiki'), { recursive: true });
  origHomedir = os.homedir;
  os.homedir = () => fakeHome;
  origEnv = process.env.PITH_WIKI_SOUL;
  delete process.env.PITH_WIKI_SOUL;
});

afterEach(() => {
  os.homedir = origHomedir;
  if (origEnv === undefined) delete process.env.PITH_WIKI_SOUL;
  else process.env.PITH_WIKI_SOUL = origEnv;
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadSoul', () => {
  it('显式 soulFile：只读这一份，忽略默认位置', () => {
    fs.writeFileSync(path.join(fakeHome, '.pith-wiki', 'SOUL.md'), 'default-user', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'SOUL.md'), 'default-project', 'utf8');
    const explicit = path.join(tmpRoot, 'custom.md');
    fs.writeFileSync(explicit, 'just me', 'utf8');
    const r = loadSoul({ soulFile: explicit, workspaceRoot });
    expect(r.content).toBe('just me');
    expect(r.sources).toEqual([explicit]);
  });

  it('显式 soulFile 不存在：返回空，不退化到默认', () => {
    fs.writeFileSync(path.join(fakeHome, '.pith-wiki', 'SOUL.md'), 'default', 'utf8');
    const r = loadSoul({ soulFile: path.join(tmpRoot, 'missing.md'), workspaceRoot });
    expect(r.content).toBe('');
    expect(r.sources).toEqual([]);
  });

  it('PITH_WIKI_SOUL env 等价于 soulFile', () => {
    const f = path.join(tmpRoot, 'env-soul.md');
    fs.writeFileSync(f, 'from env', 'utf8');
    process.env.PITH_WIKI_SOUL = f;
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('from env');
    expect(r.sources).toEqual([f]);
  });

  it('显式 soulFile 优先于 env', () => {
    fs.writeFileSync(path.join(tmpRoot, 'env.md'), 'env content', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'explicit.md'), 'explicit content', 'utf8');
    process.env.PITH_WIKI_SOUL = path.join(tmpRoot, 'env.md');
    const r = loadSoul({ soulFile: path.join(tmpRoot, 'explicit.md'), workspaceRoot });
    expect(r.content).toBe('explicit content');
  });

  it('默认双层：~/.pith-wiki/SOUL.md + <workspaceRoot>/SOUL.md 都存在 → 顺序叠加', () => {
    fs.writeFileSync(path.join(fakeHome, '.pith-wiki', 'SOUL.md'), 'user-base', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'SOUL.md'), 'project-override', 'utf8');
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('user-base\n\nproject-override');
    expect(r.sources).toEqual([
      path.join(fakeHome, '.pith-wiki', 'SOUL.md'),
      path.join(workspaceRoot, 'SOUL.md'),
    ]);
  });

  it('默认双层：只有 user 存在 → 用 user', () => {
    fs.writeFileSync(path.join(fakeHome, '.pith-wiki', 'SOUL.md'), 'only me', 'utf8');
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('only me');
    expect(r.sources).toEqual([path.join(fakeHome, '.pith-wiki', 'SOUL.md')]);
  });

  it('默认双层：只有 project 存在 → 用 project', () => {
    fs.writeFileSync(path.join(workspaceRoot, 'SOUL.md'), 'only project', 'utf8');
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('only project');
    expect(r.sources).toEqual([path.join(workspaceRoot, 'SOUL.md')]);
  });

  it('都不存在 → 空 content + 空 sources', () => {
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('');
    expect(r.sources).toEqual([]);
  });

  it('空白文件不算 source（避免给 prompt 加无意义段头）', () => {
    fs.writeFileSync(path.join(fakeHome, '.pith-wiki', 'SOUL.md'), '   \n\t  ', 'utf8');
    const r = loadSoul({ workspaceRoot });
    expect(r.content).toBe('');
    expect(r.sources).toEqual([]);
  });

  it('支持 ~/ 展开', () => {
    const dir = path.join(fakeHome, 'personas');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'work.md'), 'work voice', 'utf8');
    const r = loadSoul({ soulFile: '~/personas/work.md', workspaceRoot });
    expect(r.content).toBe('work voice');
    expect(r.sources).toEqual([path.join(dir, 'work.md')]);
  });
});

describe('composeSystemPrompt', () => {
  it('空 soul：返回原样 base prompt（不留空段头）', () => {
    const r = composeSystemPrompt('You are foo.', { content: '', sources: [] });
    expect(r).toBe('You are foo.');
  });

  it('非空 soul：追加 ## Voice and style 段', () => {
    const r = composeSystemPrompt('You are foo.', {
      content: 'Be terse and direct.',
      sources: ['/whatever'],
    });
    expect(r).toBe('You are foo.\n\n## Voice and style\n\nBe terse and direct.');
  });

  it('多段 soul（默认双层叠加结果）：原样并入 prompt', () => {
    const r = composeSystemPrompt('base', {
      content: 'base voice\n\nproject refinement',
      sources: ['/a', '/b'],
    });
    expect(r).toContain('base voice');
    expect(r).toContain('project refinement');
    expect(r).toContain('## Voice and style');
  });
});
