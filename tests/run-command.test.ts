/**
 * run_command 工具 + skill commands 白名单 单测。
 *
 * 覆盖三层闸门:白名单拒绝 / 审批(y/a/n)/ 超时 / 截断 / exit code,
 * 以及 frontmatter commands·requires 解析与 allowedCommands() 并集。
 * 用真实子进程(node -e ...)跑,不 mock spawn —— 验证 spawn(shell:false) 行为本身。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillRegistry, loadSkill } from '../src/skills/index.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { runCommandTool } from '../src/tools/run_command.js';
import type { ToolContext, ApprovalAnswer } from '../src/tools/index.js';
import type { RunCommandResult } from '../src/tools/run_command.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-runcmd-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mkSkill(root: string, name: string, md: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  return dir;
}

/** 造一个最小 ToolContext，只填 run_command 真正用到的字段。 */
function makeCtx(opts: {
  registry: SkillRegistry;
  approval?: ApprovalAnswer;
  approvedCommands?: Set<string>;
  noApprovalChannel?: boolean;
  commandTimeoutMs?: number;
  maxToolPayloadBytes?: number;
}): { ctx: ToolContext; approvalCalls: string[] } {
  const approvalCalls: string[] = [];
  const ctx = {
    config: {
      workspaceRoot: tmp,
      commandTimeoutMs: opts.commandTimeoutMs ?? 60_000,
      maxToolPayloadBytes: opts.maxToolPayloadBytes ?? 100_000,
    },
    skillRegistry: opts.registry,
    approvedCommands: opts.approvedCommands ?? new Set<string>(),
    requestCommandApproval: opts.noApprovalChannel
      ? undefined
      : async (command: string, argv: string) => {
          approvalCalls.push(argv);
          return opts.approval ?? 'yes';
        },
  } as unknown as ToolContext;
  return { ctx, approvalCalls };
}

/** 注册一个声明了 commands 的 skill 的 registry。 */
function registryWith(commands: string[]): SkillRegistry {
  const reg = new SkillRegistry();
  reg.register({
    name: 'test',
    description: 'd',
    body: 'b',
    dir: tmp,
    commands,
    requires: [],
  });
  return reg;
}

const run = (args: Record<string, unknown>, ctx: ToolContext) =>
  runCommandTool.handler(args as never, ctx) as Promise<RunCommandResult>;

describe('run_command — 白名单闸门', () => {
  it('未声明的命令被拒绝，不执行', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['weread']) });
    const r = await run({ command: 'rm', args: ['-rf', '/'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not declared');
    expect(r.error).toContain('weread'); // 列出白名单
  });

  it('声明过的命令放行并执行', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']) });
    const r = await run({ command: 'node', args: ['-e', 'process.stdout.write("hi")'] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hi');
  });
});

describe('run_command — 审批闸门', () => {
  it('答 no → 拒绝执行', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']), approval: 'no' });
    const r = await run({ command: 'node', args: ['-e', '1'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('declined');
  });

  it('答 always → 加入 approvedCommands，二次不再询问', async () => {
    const approvedCommands = new Set<string>();
    const { ctx, approvalCalls } = makeCtx({
      registry: registryWith(['node']),
      approval: 'always',
      approvedCommands,
    });
    await run({ command: 'node', args: ['-e', '0'] }, ctx);
    expect(approvedCommands.has('node')).toBe(true);
    await run({ command: 'node', args: ['-e', '0'] }, ctx);
    expect(approvalCalls).toHaveLength(1); // 第二次没再问
  });

  it('已在 approvedCommands 里 → 跳过审批', async () => {
    const { ctx, approvalCalls } = makeCtx({
      registry: registryWith(['node']),
      approvedCommands: new Set(['node']),
    });
    const r = await run({ command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, ctx);
    expect(r.ok).toBe(true);
    expect(approvalCalls).toHaveLength(0);
  });

  it('无审批通道（非交互路径）→ 拒绝', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']), noApprovalChannel: true });
    const r = await run({ command: 'node', args: ['-e', '1'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REPL');
  });
});

describe('run_command — 执行兜底', () => {
  it('非零 exit code 透传', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']) });
    const r = await run({ command: 'node', args: ['-e', 'process.exit(3)'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it('stderr 合并进 output 并标注', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']) });
    const r = await run(
      { command: 'node', args: ['-e', 'process.stderr.write("boom")'] },
      ctx,
    );
    expect(r.output).toContain('--- stderr ---');
    expect(r.output).toContain('boom');
  });

  it('超时 → timedOut，进程被杀', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']), commandTimeoutMs: 200 });
    const r = await run(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it('输出超出 maxToolPayloadBytes 被截断', async () => {
    const { ctx } = makeCtx({
      registry: registryWith(['node']),
      maxToolPayloadBytes: 100,
    });
    const r = await run(
      { command: 'node', args: ['-e', 'process.stdout.write("x".repeat(5000))'] },
      ctx,
    );
    expect(r.output!.length).toBeLessThan(500);
    expect(r.output).toContain('truncated');
  });

  it('ENOENT（命令不存在但在白名单里）→ 友好错误', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['definitely-not-a-real-bin-xyz']) });
    const r = await run({ command: 'definitely-not-a-real-bin-xyz', args: [] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Failed to (run|spawn)/);
  });

  it('args 不经 shell —— 注入字符按字面量传递', async () => {
    const { ctx } = makeCtx({ registry: registryWith(['node']) });
    // 若经 shell，`;` 会拆成两条命令；这里它只是 echo 的一个字面参数
    const r = await run(
      { command: 'node', args: ['-e', 'process.stdout.write(process.argv[1])', '; rm -rf /'] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('; rm -rf /');
  });
});

describe('frontmatter commands·requires + allowedCommands()', () => {
  it('解析 commands / requires', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(
      root,
      'weread',
      `---
name: weread
description: 微信读书
commands: [weread]
requires:
  - bin: weread
    install: npm i -g weread-cli
---
body`,
    );
    const s = loadSkill(path.join(root, 'weread'));
    expect(s.commands).toEqual(['weread']);
    expect(s.requires).toEqual([{ bin: 'weread', install: 'npm i -g weread-cli' }]);
  });

  it('纯 prompt skill：commands/requires 缺省为空数组', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'plain', `---\nname: plain\ndescription: d\n---\nbody`);
    const s = loadSkill(path.join(root, 'plain'));
    expect(s.commands).toEqual([]);
    expect(s.requires).toEqual([]);
  });

  it('allowedCommands() 是所有 skill 的并集去重', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'a', `---\nname: a\ndescription: d\ncommands: [weread, shared]\n---\nb`);
    mkSkill(root, 'b', `---\nname: b\ndescription: d\ncommands: [lark-cli, shared]\n---\nb`);
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    expect([...reg.allowedCommands()].sort()).toEqual(['lark-cli', 'shared', 'weread']);
  });

  it('非法 command 名（含路径分隔）→ skill 被跳过', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'bad', `---\nname: bad\ndescription: d\ncommands: ["../evil"]\n---\nb`);
    const warnings: string[] = [];
    const reg = await buildSkillRegistry({ skillDirs: [root], onWarn: (m) => warnings.push(m) });
    expect(reg.has('bad')).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
