/**
 * http_request 工具 + skill http_allow 白名单 单测。
 *
 * 覆盖白名单 / https-only / 鉴权注入 / 缺 key / 跨域重定向拒绝 / 截断，以及
 * frontmatter http_allow 解析与 allowedHosts() 映射。fetch 用 vi mock。
 * 注意：声明即授权 —— host 在 http_allow 即放行，无运行时审批。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSkillRegistry, loadSkill } from '../src/skills/index.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { httpRequestTool } from '../src/tools/http_request.js';
import type { ToolContext } from '../src/tools/index.js';
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

/** 声明即授权后，ToolContext 只需 config + skillRegistry。 */
function makeCtx(registry: SkillRegistry): ToolContext {
  return {
    config: { httpTimeoutMs: 30_000, maxToolPayloadBytes: 100_000 },
    skillRegistry: registry,
  } as unknown as ToolContext;
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

const bearer = (host: string, auth_env?: string): HttpAllowRule => ({
  host,
  ...(auth_env ? { auth_env } : {}),
  auth_header: 'Authorization',
  auth_scheme: 'Bearer',
});

const run = (args: Record<string, unknown>, ctx: ToolContext) =>
  httpRequestTool.handler(args as never, ctx) as Promise<HttpRequestResult>;

describe('http_request — 白名单 + 协议', () => {
  it('host 不在白名单 → 拒绝，不发请求', async () => {
    const { calls } = stubFetch();
    const r = await run({ url: 'https://evil.com/x', method: 'GET' }, makeCtx(registryWith([bearer('i.weread.qq.com')])));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not declared');
    expect(calls).toHaveLength(0);
  });

  it('非 https → 拒绝', async () => {
    const r = await run({ url: 'http://i.weread.qq.com/x' }, makeCtx(registryWith([bearer('i.weread.qq.com')])));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('https');
  });

  it('白名单内 → 直接发请求（声明即授权，无审批）', async () => {
    const { calls } = stubFetch({ text: '{"books":[]}' });
    const r = await run(
      { url: 'https://api.example.com/v1', method: 'POST', body: '{"q":1}' },
      makeCtx(registryWith([bearer('api.example.com')])),
    );
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
    await run(
      { url: 'https://api.example.com/x', method: 'POST', body: '{}' },
      makeCtx(registryWith([bearer('api.example.com', 'TEST_TOKEN')])),
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('auth_scheme="" → 裸值（如 X-API-Key）', async () => {
    process.env.TEST_TOKEN = 'k';
    const { calls } = stubFetch();
    const reg = registryWith([
      { host: 'api.example.com', auth_env: 'TEST_TOKEN', auth_header: 'X-API-Key', auth_scheme: '' },
    ]);
    await run({ url: 'https://api.example.com/x' }, makeCtx(reg));
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('k');
  });

  it('声明了 auth_env 但未设置 → 拒绝并提示', async () => {
    const { calls } = stubFetch();
    const r = await run(
      { url: 'https://api.example.com/x' },
      makeCtx(registryWith([bearer('api.example.com', 'MISSING_TOKEN')])),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MISSING_TOKEN');
    expect(calls).toHaveLength(0);
  });
});

describe('http_request — 安全兜底', () => {
  it('跨域重定向到白名单外 host → 拒绝', async () => {
    stubFetch({ url: 'https://evil.com/landed' }); // res.url 落到别处
    const r = await run({ url: 'https://api.example.com/x' }, makeCtx(registryWith([bearer('api.example.com')])));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('redirected');
  });

  it('响应体超 maxToolPayloadBytes 被截断', async () => {
    stubFetch({ text: 'x'.repeat(5000) });
    const ctx = {
      config: { httpTimeoutMs: 30_000, maxToolPayloadBytes: 100 },
      skillRegistry: registryWith([bearer('api.example.com')]),
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
