/**
 * Skill 子系统单测:buildSkillRegistry 的发现 / 校验 / 容错 / 优先级,
 * 以及 `skill` 工具的回包。
 *
 * 用 tmpdir fixtures(与 wiki-tools.test.ts / converters.test.ts 同风格)。
 * 纯 prompt skill —— 无代码执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillRegistry, loadSkill } from '../src/skills/index.js';
import { makeSkillTool } from '../src/tools/skill.js';
import type { ToolContext } from '../src/tools/index.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-skills-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 在 <root>/<name>/SKILL.md 写入给定 markdown(含 frontmatter)。返回 skill 目录。 */
function mkSkill(root: string, name: string, md: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  return dir;
}

function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

// ---- 发现 + 校验 ----

describe('buildSkillRegistry', () => {
  it('发现合法 skill,暴露 name/description/body', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'changelog', skillMd('changelog', 'Draft a release changelog.', 'Step 1: gather commits.'));

    const reg = await buildSkillRegistry({ skillDirs: [root] });
    const s = reg.get('changelog');
    expect(s?.description).toBe('Draft a release changelog.');
    expect(s?.body).toBe('Step 1: gather commits.');
  });

  it('忽略额外 frontmatter 字段(兼容 Claude Code 的 type/version/metadata)', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(
      root,
      'lark',
      `---\nname: lark\ndescription: a lark skill\ntype: tool\nversion: 1.0.0\nmetadata:\n  requires:\n    bins: ["lark-cli"]\n---\n指令正文。\n`,
    );
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    expect(reg.get('lark')?.body).toBe('指令正文。');
  });

  it('空 body 被跳过 + warn', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'empty', skillMd('empty', 'desc', ''));
    const warnings: string[] = [];
    const reg = await buildSkillRegistry({ skillDirs: [root], onWarn: (m) => warnings.push(m) });
    expect(reg.has('empty')).toBe(false);
    expect(warnings.join('\n')).toMatch(/empty/i);
  });

  it('frontmatter 不合法(缺 description)→ 跳过,不致命', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'bad', `---\nname: bad\n---\nbody\n`);
    mkSkill(root, 'good', skillMd('good', 'fine', 'body'));
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    expect(reg.has('bad')).toBe(false);
    expect(reg.has('good')).toBe(true);
  });

  it('跳过 dotdir 和无 SKILL.md 的目录', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, '.hidden', skillMd('hidden', 'd', 'b'));
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });
    mkSkill(root, 'real', skillMd('real', 'd', 'b'));
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    expect(reg.names()).toEqual(['real']);
  });

  it('skillDirs 顺序即优先级:后面的目录覆盖前面的同名 skill', async () => {
    const userDir = path.join(tmp, 'user');
    const projDir = path.join(tmp, 'proj');
    mkSkill(userDir, 'dup', skillMd('dup', 'user version', 'USER BODY'));
    mkSkill(projDir, 'dup', skillMd('dup', 'proj version', 'PROJ BODY'));
    const reg = await buildSkillRegistry({ skillDirs: [userDir, projDir] });
    expect(reg.get('dup')?.body).toBe('PROJ BODY');
    expect(reg.get('dup')?.description).toBe('proj version');
  });

  it('不存在的 skillDir 被静默忽略', async () => {
    const reg = await buildSkillRegistry({ skillDirs: [path.join(tmp, 'nope')] });
    expect(reg.list()).toEqual([]);
  });
});

// ---- catalog ----

describe('SkillRegistry.catalog', () => {
  it('列出 skills 为 "- name: desc",无则空串', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'a', skillMd('a', 'does A', 'b'));
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    expect(reg.catalog()).toBe('- a: does A');

    const empty = await buildSkillRegistry({ skillDirs: [path.join(tmp, 'none')] });
    expect(empty.catalog()).toBe('');
  });
});

// ---- skill 工具 ----

describe('skill tool', () => {
  it('handler 返回正文', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'writer', skillMd('writer', 'd', 'INSTRUCTIONS HERE'));
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    const tool = makeSkillTool(reg);
    const ctx = { skillRegistry: reg } as unknown as ToolContext;
    const r = (await tool.handler({ name: 'writer' }, ctx)) as { ok: boolean; instructions: string };
    expect(r.ok).toBe(true);
    expect(r.instructions).toBe('INSTRUCTIONS HERE');
  });

  it('未知 skill → ok:false', async () => {
    const reg = await buildSkillRegistry({ skillDirs: [] });
    const tool = makeSkillTool(reg);
    const ctx = { skillRegistry: reg } as unknown as ToolContext;
    const r = (await tool.handler({ name: 'ghost' }, ctx)) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown skill/);
  });

  it('description baked 进 catalog', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'alpha', skillMd('alpha', 'the alpha skill', 'b'));
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    const tool = makeSkillTool(reg);
    expect(tool.description).toContain('alpha: the alpha skill');
  });
});

// ---- 自测探针 test 字段 ----

describe('loadSkill — 自测探针 test', () => {
  it('解析 command 探针', () => {
    const dir = mkSkill(
      tmp,
      'lark-x',
      '---\nname: lark-x\ndescription: d\ncommands: [lark-cli]\ntest:\n  kind: command\n  command: lark-cli\n  args: [auth, status]\n---\nbody\n',
    );
    expect(loadSkill(dir).test).toEqual({
      kind: 'command',
      command: 'lark-cli',
      args: ['auth', 'status'],
    });
  });

  it('解析 http 探针', () => {
    const dir = mkSkill(
      tmp,
      'wr-x',
      '---\nname: wr-x\ndescription: d\ntest:\n  kind: http\n  url: https://i.weread.qq.com/api/agent/gateway\n  method: POST\n---\nbody\n',
    );
    expect(loadSkill(dir).test).toMatchObject({
      kind: 'http',
      url: 'https://i.weread.qq.com/api/agent/gateway',
      method: 'POST',
    });
  });

  it('无 test → undefined', () => {
    const dir = mkSkill(tmp, 'plain', skillMd('plain', 'd', 'body'));
    expect(loadSkill(dir).test).toBeUndefined();
  });

  it('bundled lark / weread 都声明了探针', () => {
    const lark = loadSkill(path.join(process.cwd(), 'bundled-skills', 'lark'));
    const weread = loadSkill(path.join(process.cwd(), 'bundled-skills', 'weread'));
    expect(lark.test).toMatchObject({ kind: 'command', command: 'lark-cli' });
    expect(weread.test).toMatchObject({ kind: 'http' });
  });
});
