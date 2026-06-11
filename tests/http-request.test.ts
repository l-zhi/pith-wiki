/**
 * http_request 工具 + skill http_allow 白名单 单测。
 *
 * 覆盖白名单 / 审批(y·a·n)/ https-only / 鉴权注入 / 缺 key / 跨域重定向拒绝 /
 * 截断,以及 frontmatter http_allow 解析与 allowedHosts() 映射。fetch 用 vi mock。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSkillRegistry, loadSkill } from '../src/skills/index.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { httpRequestTool } from '../src/tools/http_request.js';
import type { ToolContext, ApprovalAnswer } from '../src/tools/index.js';
import type { HttpRequestResult } from '../src/tools/http_request.js';
import type { HttpAllowRule } from '../src/skills/types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pith-http-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.TEST_TOKEN;
});

function mkSkill(root: string, name: string, md: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  return dir;
}

function registryWith(rules: HttpAllowRule[]): SkillRegistry {
  const reg = new SkillRegistry();
  reg.register({
    name: 'test',
    description: 'd',
    body: 'b',
    dir: tmp,
    commands: [],
    requires: [],
    httpAllow: rules,
  });
  return reg;
}

function makeCtx(opts: {
  registry: SkillRegistry;
  approval?: ApprovalAnswer;
  approvedHosts?: Set<string>;
  noApprovalChannel?: boolean;
}): { ctx: ToolContext; approvals: string[] } {
  const approvals: string[] = [];
  const ctx = {
    config: { httpTimeoutMs: 30_000, maxToolPayloadBytes: 100_000 },
    skillRegistry: opts.registry,
    approvedHosts: opts.approvedHosts ?? new Set<string>(),
    requestNetworkApproval: opts.noApprovalChannel
      ? undefined
      : async (host: string, preview: string) => {
          approvals.push(preview);
          return opts.approval ?? 'yes';
        },
  } as unknown as ToolContext;
  return { ctx, approvals };
}

/** mock 一个 fetch，返回固定响应；记录被调用的 url/init。 */
function stubFetch(
  response: { ok?: boolean; status?: number; text?: string; url?: string } = {},
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      url: response.url ?? url,
      text: async () => response.text ?? '{}',
    };
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

const run = (args: Record<string, unknown>, ctx: ToolContext) =>
  httpRequestTool.handler(args as never, ctx) as Promise<HttpRequestResult>;

describe('http_request — 白名单 + 协议', () => {
  it('host 不在白名单 → 拒绝，不发请求', async () => {
    const { calls } = stubFetch();
    const { ctx } = makeCtx({ registry: registryWith([{ host: 'i.weread.qq.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]) });
    const r = await run({ url: 'https://evil.com/x', method: 'GET' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not declared');
    expect(calls).toHaveLength(0);
  });

  it('非 https → 拒绝', async () => {
    const { ctx } = makeCtx({ registry: registryWith([{ host: 'i.weread.qq.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]) });
    const r = await run({ url: 'http://i.weread.qq.com/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('https');
  });

  it('白名单内 + 审批通过 → 发请求', async () => {
    const { calls } = stubFetch({ text: '{"books":[]}' });
    const { ctx } = makeCtx({ registry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]) });
    const r = await run({ url: 'https://api.example.com/v1', method: 'POST', body: '{"q":1}' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toContain('books');
    expect(calls[0].url).toBe('https://api.example.com/v1');
    expect((calls[0].init as { body?: string }).body).toBe('{"q":1}');
  });
});

describe('http_request — 鉴权注入', () => {
  it('按 rule 从 env 注入 Bearer，模型未传 key', async () => {
    process.env.TEST_TOKEN = 'secret-123';
    const { calls } = stubFetch();
    const { ctx } = makeCtx({
      registry: registryWith([
        { host: 'api.example.com', auth_env: 'TEST_TOKEN', auth_header: 'Authorization', auth_scheme: 'Bearer' },
      ]),
    });
    await run({ url: 'https://api.example.com/x', method: 'POST', body: '{}' }, ctx);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('auth_scheme="" → 裸值（如 X-API-Key）', async () => {
    process.env.TEST_TOKEN = 'k';
    const { calls } = stubFetch();
    const { ctx } = makeCtx({
      registry: registryWith([
        { host: 'api.example.com', auth_env: 'TEST_TOKEN', auth_header: 'X-API-Key', auth_scheme: '' },
      ]),
    });
    await run({ url: 'https://api.example.com/x' }, ctx);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('k');
  });

  it('声明了 auth_env 但未设置 → 拒绝并提示', async () => {
    const { calls } = stubFetch();
    const { ctx } = makeCtx({
      registry: registryWith([
        { host: 'api.example.com', auth_env: 'MISSING_TOKEN', auth_header: 'Authorization', auth_scheme: 'Bearer' },
      ]),
    });
    const r = await run({ url: 'https://api.example.com/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MISSING_TOKEN');
    expect(calls).toHaveLength(0);
  });
});

describe('http_request — 审批闸门', () => {
  it('答 no → 不发请求', async () => {
    const { calls } = stubFetch();
    const { ctx } = makeCtx({
      registry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]),
      approval: 'no',
    });
    const r = await run({ url: 'https://api.example.com/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('答 always → 入 approvedHosts，二次不再问', async () => {
    stubFetch();
    const approvedHosts = new Set<string>();
    const { ctx, approvals } = makeCtx({
      registry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]),
      approval: 'always',
      approvedHosts,
    });
    await run({ url: 'https://api.example.com/a' }, ctx);
    expect(approvedHosts.has('api.example.com')).toBe(true);
    await run({ url: 'https://api.example.com/b' }, ctx);
    expect(approvals).toHaveLength(1);
  });

  it('无审批通道（非交互）→ 拒绝', async () => {
    stubFetch();
    const { ctx } = makeCtx({
      registry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]),
      noApprovalChannel: true,
    });
    const r = await run({ url: 'https://api.example.com/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REPL');
  });
});

describe('http_request — 安全兜底', () => {
  it('跨域重定向到白名单外 host → 拒绝', async () => {
    stubFetch({ url: 'https://evil.com/landed' }); // res.url 落到别处
    const { ctx } = makeCtx({ registry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]) });
    const r = await run({ url: 'https://api.example.com/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('redirected');
  });

  it('响应体超 maxToolPayloadBytes 被截断', async () => {
    stubFetch({ text: 'x'.repeat(5000) });
    const ctx = {
      config: { httpTimeoutMs: 30_000, maxToolPayloadBytes: 100 },
      skillRegistry: registryWith([{ host: 'api.example.com', auth_header: 'Authorization', auth_scheme: 'Bearer' }]),
      approvedHosts: new Set(['api.example.com']),
      requestNetworkApproval: async () => 'yes' as const,
    } as unknown as ToolContext;
    const r = await run({ url: 'https://api.example.com/x' }, ctx);
    expect(r.body!.length).toBeLessThan(500);
    expect(r.body).toContain('truncated');
  });
});

describe('frontmatter http_allow + allowedHosts()', () => {
  it('解析 http_allow，默认 auth_header/scheme', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(
      root,
      'weread',
      `---
name: weread
description: 微信读书
http_allow:
  - host: i.weread.qq.com
    auth_env: WEREAD_API_KEY
---
body`,
    );
    const s = loadSkill(path.join(root, 'weread'));
    expect(s.httpAllow).toEqual([
      { host: 'i.weread.qq.com', auth_env: 'WEREAD_API_KEY', auth_header: 'Authorization', auth_scheme: 'Bearer' },
    ]);
  });

  it('allowedHosts() 汇总各 skill 的 host→rule', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'a', `---\nname: a\ndescription: d\nhttp_allow:\n  - host: a.com\n    auth_env: A\n---\nb`);
    mkSkill(root, 'b', `---\nname: b\ndescription: d\nhttp_allow:\n  - host: b.com\n---\nb`);
    const reg = await buildSkillRegistry({ skillDirs: [root] });
    const hosts = reg.allowedHosts();
    expect([...hosts.keys()].sort()).toEqual(['a.com', 'b.com']);
    expect(hosts.get('a.com')?.auth_env).toBe('A');
  });

  it('非法 host（带 scheme）→ skill 被跳过', async () => {
    const root = path.join(tmp, 'skills');
    mkSkill(root, 'bad', `---\nname: bad\ndescription: d\nhttp_allow:\n  - host: "https://x.com"\n---\nb`);
    const warnings: string[] = [];
    const reg = await buildSkillRegistry({ skillDirs: [root], onWarn: (m) => warnings.push(m) });
    expect(reg.has('bad')).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
