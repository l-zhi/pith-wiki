import { z } from 'zod';
import type { ToolDef } from './index.js';
import { truncatePayload } from './safety.js';

/**
 * 微信读书（WeChat Reading）网关工具 —— 供 pith MCP server 暴露给外部 agent 宿主
 * （尤其是 claude-code provider）作为 `mcp__pith__weread_gateway` 调用。
 *
 * 为什么单独做一个 MCP 工具，而不是让 claude-code 走 Bash+curl：
 *   - claude-code headless 沙箱对含 `$VAR` 展开的命令（weread 那条
 *     `curl -H "Authorization: Bearer $WEREAD_API_KEY"`）硬拦（simple_expansion），
 *     且外部命令要审批——无人值守的定时任务里根本过不去。
 *   - 走 MCP 工具：名字命中 `mcp__pith__*` 白名单，无 Bash、无变量展开、无审批。
 *
 * 与 pith 内置 http_request 的区别：MCP server 的 ToolContext 带的是**空**
 * SkillRegistry，http_request 的 host 白名单闸门会拒绝一切。所以这里**直接读
 * `process.env.WEREAD_API_KEY`**、直连固定网关，不经 skillRegistry.allowedHosts()。
 * 密钥来源：config.json 的 secrets 在 loadConfigFromEnv() 时灌进 process.env
 * （MCP server 启动即调用），所以只要在 pith 设置里配了 WEREAD_API_KEY 就能拿到。
 */

const WEREAD_GATEWAY_URL = 'https://i.weread.qq.com/api/agent/gateway';
/** 网关要求每次调用都带；值取自 bundled-skills/weread/SKILL.md，网关升级时同步。 */
const WEREAD_SKILL_VERSION = '1.0.3';

const paramsSchema = z.object({
  api_name: z
    .string()
    .describe(
      'Gateway endpoint, e.g. "/store/search" or "/user/reading_stats". Call with api_name "/_list" to discover all endpoints and their params.',
    ),
  params: z
    .record(z.unknown())
    .optional()
    .describe('Flat business params for the endpoint, e.g. {"keyword":"三体","count":10}.'),
});

export interface WereadGatewayResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  timedOut?: boolean;
}

export const wereadGatewayTool: ToolDef<typeof paramsSchema> = {
  name: 'weread_gateway',
  description:
    '微信读书（WeChat Reading）gateway. POST an api_name (+ flat params) to query books, bookshelf, notes/highlights, reviews, and reading stats. First call api_name "/_list" to discover available endpoints. Requires WEREAD_API_KEY configured in pith settings.',
  parameters: paramsSchema,
  handler: async ({ api_name, params }, ctx): Promise<WereadGatewayResult> => {
    const key = process.env.WEREAD_API_KEY;
    if (!key) {
      return {
        ok: false,
        error:
          'WEREAD_API_KEY is not set — configure it in pith settings (skill env) or config.json secrets.',
      };
    }
    // skill_version 默认在前、params 在后：调用方可按需覆盖 skill_version。
    const body = JSON.stringify({ api_name, skill_version: WEREAD_SKILL_VERSION, ...(params ?? {}) });
    const timeoutMs = ctx.config.httpTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(WEREAD_GATEWAY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        // 固定单一网关，绝不跟随重定向——否则 Bearer 可能随 302 泄漏到别处。
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, status: res.status, error: 'unexpected redirect from weread gateway' };
      }
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: truncatePayload(text, ctx.config.maxToolPayloadBytes),
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === 'AbortError';
      return {
        ok: false,
        timedOut,
        error: timedOut ? `weread gateway timed out after ${timeoutMs}ms` : e.message,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
