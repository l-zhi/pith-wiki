/**
 * removeSkillByName 在多个 skillDir 撞名时,必须删掉注册表会加载的那一份。
 * 默认顺序是 user-global 在前、project-local 在后,后者胜出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { removeSkillByName } from '../src/skills/install.js';
import { buildSkillRegistry } from '../src/skills/index.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-skill-rm-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

/** 在 <root>/<name>/SKILL.md 放一份 skill。返回该 skill 目录。 */
function writeSkill(root: string, name: string, description: string, body: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name, description, body), 'utf8');
  return dir;
}

function cfg(skillDirs: string[]): Config {
  return { skillDirs } as unknown as Config;
}

describe('removeSkillByName collision', () => {
  it('deletes the later skillDir the registry loads, and leaves the earlier copy', async () => {
    const globalRoot = path.join(tmp, 'global');
    const projectRoot = path.join(tmp, 'project');
    const globalDir = writeSkill(globalRoot, 'field-notes', 'global copy', 'GLOBAL BODY');
    const projectDir = writeSkill(projectRoot, 'field-notes', 'project copy', 'PROJECT BODY');
    const skillDirs = [globalRoot, projectRoot];

    const before = await buildSkillRegistry({ skillDirs });
    expect(before.get('field-notes')?.dir).toBe(projectDir);
    expect(before.get('field-notes')?.body).toBe('PROJECT BODY');

    const removed = removeSkillByName('field-notes', cfg(skillDirs));

    expect(removed?.dir).toBe(projectDir);
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(fs.readFileSync(path.join(globalDir, 'SKILL.md'), 'utf8')).toContain('GLOBAL BODY');

    const after = await buildSkillRegistry({ skillDirs });
    expect(after.get('field-notes')?.dir).toBe(globalDir);
    expect(after.get('field-notes')?.body).toBe('GLOBAL BODY');
  });

  it('still removes a skill that exists only in an earlier skillDir', () => {
    const globalRoot = path.join(tmp, 'global');
    const projectRoot = path.join(tmp, 'project');
    const globalDir = writeSkill(globalRoot, 'field-notes', 'global copy', 'GLOBAL BODY');
    fs.mkdirSync(projectRoot, { recursive: true });

    const removed = removeSkillByName('field-notes', cfg([globalRoot, projectRoot]));

    expect(removed?.dir).toBe(globalDir);
    expect(fs.existsSync(globalDir)).toBe(false);
  });

  it('skips a later copy the registry rejects and removes the one it loads', async () => {
    const globalRoot = path.join(tmp, 'global');
    const projectRoot = path.join(tmp, 'project');
    const globalDir = writeSkill(globalRoot, 'field-notes', 'global copy', 'GLOBAL BODY');
    const brokenDir = path.join(projectRoot, 'field-notes');
    fs.mkdirSync(brokenDir, { recursive: true });
    // 空正文:loadSkill 抛错,buildSkillRegistry 会跳过,胜出者仍是前面的合法副本。
    fs.writeFileSync(
      path.join(brokenDir, 'SKILL.md'),
      '---\nname: field-notes\ndescription: broken\n---\n',
      'utf8',
    );
    const skillDirs = [globalRoot, projectRoot];

    const before = await buildSkillRegistry({ skillDirs });
    expect(before.get('field-notes')?.dir).toBe(globalDir);

    const removed = removeSkillByName('field-notes', cfg(skillDirs));

    expect(removed?.dir).toBe(globalDir);
    expect(fs.existsSync(globalDir)).toBe(false);
    expect(fs.existsSync(path.join(brokenDir, 'SKILL.md'))).toBe(true);
  });

  it('does not delete a later directory whose frontmatter name is a different skill', async () => {
    const globalRoot = path.join(tmp, 'global');
    const projectRoot = path.join(tmp, 'project');
    const globalDir = writeSkill(globalRoot, 'field-notes', 'global copy', 'GLOBAL BODY');
    const otherDir = path.join(projectRoot, 'field-notes');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, 'SKILL.md'),
      skillMd('other-skill', 'different skill', 'OTHER BODY'),
      'utf8',
    );
    const skillDirs = [globalRoot, projectRoot];

    const before = await buildSkillRegistry({ skillDirs });
    expect(before.get('field-notes')?.dir).toBe(globalDir);
    expect(before.get('other-skill')?.dir).toBe(otherDir);

    const removed = removeSkillByName('field-notes', cfg(skillDirs));

    expect(removed?.dir).toBe(globalDir);
    expect(fs.existsSync(globalDir)).toBe(false);
    expect(fs.readFileSync(path.join(otherDir, 'SKILL.md'), 'utf8')).toContain('OTHER BODY');
  });
});
