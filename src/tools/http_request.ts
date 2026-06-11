import { z } from 'zod';
import type { ToolDef } from './index.js';
import { truncatePayload } from './safety.js';

/**
 * http_request:向已安装 skill 声明过的 host 发 HTTP 请求(weread 网关这类
 * "prompt skill + HTTP API" 的执行底座)。
 *
 * 三层闸门(对齐 run_command,详见 docs/adr/0004-cli-skill-exec.md):
 *   1. 白名单 —— url 的 host 必须 ∈ skillRegistry.allowedHosts()。空 map → 工具不挂载。
 *   2. 审批 —— 每个新 host 首次访问经 ctx.requestNetworkApproval(REPL only;非交互
 *      路径无通道 → 拒绝)。a 按 host 粒度入 approvedHosts。
 *   3. 安全 —— 仅 https;鉴权由工具按 host rule 从环境变量注入,模型看不到也传不了
 *      密钥;跨域重定向拒绝(防 key 跟着 302 跑到别的 host);超时;响应 truncate。
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const params = z.object({
  url: z.string().describe('Full https URL; its host must be declared in a skill\'s http_allow.'),
  method: z.enum(METHODS).default('GET'),
  body: z.string().optional().describe('Raw request body (e.g. JSON text). Omit for GET.'),
  content_type: z
    .string()
    .optional()
    .describe('Content-Type header for the body (default application/json).'),
  timeout_ms: z.number().optional().describe('Override the default HTTP timeout (ms).'),
});

export interface HttpRequestResult {
  ok: boolean;
  status?: number;
  /** 响应体文本,truncate 过。 */
  body?: string;
  error?: string;
  timedOut?: boolean;
}

export const httpRequestTool: ToolDef<typeof params> = {
  name: 'http_request',
  description:
    'Make an HTTP request to a host declared in an installed skill\'s http_allow. ' +
    'Only allowlisted hosts work; each host needs user approval once per session. ' +
    'Authentication is injected automatically from configured env vars — never put API keys in the url or body. ' +
    'HTTPS only. Returns the response status and body (truncated if large).',
  parameters: params,
  handler: async ({ url, method, body, content_type, timeout_ms }, ctx): Promise<HttpRequestResult> => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { ok: false, error: `Invalid URL: ${url}` };
    }

    // 安全:仅 https。明文 http 会让注入的鉴权头裸奔。
    if (parsedUrl.protocol !== 'https:') {
      return { ok: false, error: 'Only https:// URLs are allowed.' };
    }

    // 闸门 1:host 白名单
    const allowed = ctx.skillRegistry.allowedHosts();
    const rule = allowed.get(parsedUrl.host);
    if (!rule) {
      const list = [...allowed.keys()].sort().join(', ') || '(none)';
      return {
        ok: false,
        error: `Host "${parsedUrl.host}" is not declared by any installed skill. Allowed: ${list}`,
      };
    }

    // 鉴权:按 rule 从 env 取密钥注入。声明了 auth_env 但未设置 → 拒绝并提示(不发裸请求)。
    const headers: Record<string, string> = {};
    if (rule.auth_env) {
      const secret = process.env[rule.auth_env];
      if (!secret) {
        return {
          ok: false,
          error: `${rule.auth_env} is not set. Set it (e.g. in .env) to authenticate with ${rule.host}.`,
        };
      }
      headers[rule.auth_header] = rule.auth_scheme ? `${rule.auth_scheme} ${secret}` : secret;
    }
    if (body !== undefined) headers['Content-Type'] = content_type ?? 'application/json';

    // 闸门 2:审批(每个新 host 一次)
    if (!ctx.approvedHosts.has(parsedUrl.host)) {
      if (!ctx.requestNetworkApproval) {
        return {
          ok: false,
          error: 'Network access requires interactive approval and is only available in the REPL.',
        };
      }
      const preview = `${method} ${url}`;
      const answer = await ctx.requestNetworkApproval(parsedUrl.host, preview);
      if (answer === 'no') return { ok: false, error: 'User declined the network request.' };
      if (answer === 'always') ctx.approvedHosts.add(parsedUrl.host);
    }

    const timeoutMs = timeout_ms ?? ctx.config.httpTimeoutMs;
    const maxBytes = ctx.config.maxToolPayloadBytes;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'follow',
        signal: controller.signal,
      });

      // 安全:跟随重定向后若落到白名单外的 host,拒绝(鉴权头可能已随 302 发出风险)。
      let finalHost: string;
      try {
        finalHost = new URL(res.url).host;
      } catch {
        finalHost = parsedUrl.host;
      }
      if (finalHost !== parsedUrl.host && !allowed.has(finalHost)) {
        return { ok: false, error: `Request redirected to disallowed host "${finalHost}".` };
      }

      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: truncatePayload(text, maxBytes),
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') {
        return { ok: false, timedOut: true, error: `Timed out after ${timeoutMs}ms` };
      }
      return { ok: false, error: `Request failed: ${e.message ?? String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
