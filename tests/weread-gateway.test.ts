/**
 * weread_gateway MCP 工具单测：mock fetch + WEREAD_API_KEY，焊死请求拼装与错误路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wereadGatewayTool, type WereadGatewayResult } from '../src/tools/weread_gateway.js';
import type { ToolContext } from '../src/tools/index.js';

const ctx = { config: { httpTimeoutMs: 5000, maxToolPayloadBytes: 100_000 } } as unknown as ToolContext;

interface Captured {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string };
}
let captured: Captured | null;

function mockFetch(status: number, text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: Captured['init']) => {
      captured = { url, init };
      return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
    }),
  );
}

beforeEach(() => {
  captured = null;
  process.env.WEREAD_API_KEY = 'wrk-test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WEREAD_API_KEY;
});

const run = (args: { api_name: string; params?: Record<string, unknown> }) =>
  wereadGatewayTool.handler(args, ctx) as Promise<WereadGatewayResult>;

describe('weread_gateway', () => {
  it('缺 WEREAD_API_KEY → 友好错误，不发请求', async () => {
    delete process.env.WEREAD_API_KEY;
    mockFetch(200, '{}');
    const r = await run({ api_name: '/_list' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WEREAD_API_KEY is not set/);
    expect(captured).toBeNull();
  });

  it('POST 固定网关，注入 Bearer，body 含 api_name + skill_version + 扁平 params', async () => {
    mockFetch(200, '{"books":[]}');
    const r = await run({ api_name: '/store/search', params: { keyword: '三体', count: 10 } });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(captured!.url).toBe('https://i.weread.qq.com/api/agent/gateway');
    expect(captured!.init.method).toBe('POST');
    expect(captured!.init.headers?.Authorization).toBe('Bearer wrk-test');
    expect(captured!.init.redirect).toBe('manual');
    const body = JSON.parse(captured!.init.body!);
    expect(body).toMatchObject({ api_name: '/store/search', keyword: '三体', count: 10 });
    expect(body.skill_version).toBe('1.0.3');
  });

  it('调用方可覆盖 skill_version', async () => {
    mockFetch(200, '{}');
    await run({ api_name: '/_list', params: { skill_version: '9.9.9' } });
    expect(JSON.parse(captured!.init.body!).skill_version).toBe('9.9.9');
  });

  it('非 2xx → ok:false + HTTP 状态', async () => {
    mockFetch(401, 'unauthorized');
    const r = await run({ api_name: '/_list' });
    expect(r).toMatchObject({ ok: false, status: 401, error: 'HTTP 401' });
  });

  it('3xx 重定向 → 拒绝（不跟随，防 Bearer 泄漏）', async () => {
    mockFetch(302, '');
    const r = await run({ api_name: '/_list' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirect/);
  });
});
