import fs from 'node:fs';
import path from 'node:path';

/**
 * pi 扩展源码 —— 把 pith 已有的 stdio MCP server（`bin/pith-mcp.ts`）桥接成 pi 的原生工具。
 *
 * 为什么需要它：pi **没有内置 MCP**（`docs/usage.md` "Design Principles" 明写不做 MCP/subagent/
 * 权限弹窗）。claude-code 用 `--mcp-config`、codex 用 `-c mcp_servers.pith.*` 就能挂上 pith-mcp，
 * pi 只能靠扩展。扩展是 pi 的一等公民（`pi -e <file>`，jiti 加载，可用 node: 内建 + npm 依赖），
 * 所以这里用**零依赖**手写 MCP JSON-RPC over stdio（约 100 行），把 `tools/list` 拿到的
 * 只读检索工具逐个 `pi.registerTool`。一份 `pith-mcp.json` 三个 CLI 共用，不新增真源。
 *
 * 为什么把源码嵌成字符串、运行时写盘（而不是仓库里放一个 .mjs 再打包进 app）：
 * 桌面端产物由 electron-vite 打进 `out/`，额外资源要走 electron-builder 的 extraResources +
 * 三套路径回退（dev / npm CLI / packaged）。写盘方案零打包改动，且与 `security.json`
 * 首次使用写模板是同一个既有套路。内容变了就覆盖（按内容比对，不是时间戳）。
 *
 * 与 pi 官方指引的一处偏离：文档说「不要在 factory 里起后台资源」（factory 可能跑在
 * 不开 session 的调用里）。我们必须在 factory 里握手，因为工具名/schema 来自 `tools/list`，
 * 而 registerTool 得在 session 起来前完成。pith 只用单轮 `--mode json`（必然开 session），
 * 且注册了 `session_shutdown` 收尾，可接受。
 *
 * 环境变量契约（由 PiAgent 注入）：
 *   - PITH_MCP_COMMAND：pith-mcp 的可执行命令（如 `node`）
 *   - PITH_MCP_ARGS   ：JSON 数组（如 `["/abs/dist/bin/pith-mcp.js"]`）
 *   - PITH_MCP_ENV    ：JSON 对象，合并进子进程 env（如 `{"PITH_WIKI_HOME":"..."}`）
 * PITH_MCP_COMMAND 缺省 → 扩展直接 no-op（pi 照常能聊天，只是读不到知识库）。
 */
export const PI_BRIDGE_SOURCE = `// pith-mcp-bridge.mjs —— 由 pith 自动生成，请勿手改（内容变化时会被覆盖）。
// 把 pith 的只读 MCP 检索工具桥接成 pi 原生工具。零依赖，只用 node: 内建。
import { spawn } from 'node:child_process';

const COMMAND = process.env.PITH_MCP_COMMAND || '';
const ARGS = safeJson(process.env.PITH_MCP_ARGS, []);
const CHILD_ENV = safeJson(process.env.PITH_MCP_ENV, {});
const REQUEST_TIMEOUT_MS = Number(process.env.PITH_MCP_TIMEOUT_MS || 60000);

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 最小 MCP stdio 客户端：换行分隔的 JSON-RPC 2.0，只实现 initialize / tools/list / tools/call。 */
class McpStdioClient {
  constructor() {
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.exitReason = null;
  }

  async start() {
    this.child = spawn(COMMAND, ARGS, {
      env: { ...process.env, ...CHILD_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    // stderr 是 pith-mcp 的日志通道（stdout 必须保持纯 JSON-RPC）——收着但不打断。
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
    this.child.on('error', (err) => this.failAll(err.message));
    this.child.on('exit', (code) => this.failAll('pith-mcp exited with code ' + code));
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pith-pi-bridge', version: '1' },
    });
    this.notify('notifications/initialized');
  }

  failAll(reason) {
    this.exitReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  onData(chunk) {
    this.buf += chunk;
    // 只按 \\n 切（JSON 字符串里可能含 U+2028/2029，通用 line reader 会切错）。
    let idx;
    while ((idx = this.buf.indexOf('\\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 噪声行忽略
      }
      if (msg.id == null) continue; // 服务端通知，本桥不消费
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
      else p.resolve(msg.result);
    }
  }

  request(method, params) {
    if (this.exitReason) return Promise.reject(new Error(this.exitReason));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
  }

  stop() {
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* best effort */
    }
    this.child = null;
  }
}

export default async function (pi) {
  if (!COMMAND) return; // 未配 pith-mcp：不注册任何工具，pi 仍可对话
  const client = new McpStdioClient();
  await client.start();
  const listed = await client.request('tools/list', {});
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  for (const tool of tools) {
    if (!tool?.name) continue;
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || '',
      // MCP 的 inputSchema 已是 JSON Schema（MCP SDK 由 zod 生成），TypeBox schema 本身
      // 就是 JSON Schema，直接透传即可。
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      async execute(_toolCallId, params) {
        const res = await client.request('tools/call', {
          name: tool.name,
          arguments: params || {},
        });
        const text = (Array.isArray(res?.content) ? res.content : [])
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text || '')
          .join('\\n');
        // pi 约定：工具失败要 throw（不要把错误当正常内容返回）。
        if (res?.isError) throw new Error(text || tool.name + ' failed');
        return { content: [{ type: 'text', text }], details: {} };
      },
    });
  }
  pi.on('session_shutdown', () => {
    client.stop();
  });
}
`;

/** 生成的扩展文件在 pith home 下的相对位置。 */
export const PI_BRIDGE_RELATIVE_PATH = path.join('pi', 'pith-mcp-bridge.mjs');

/**
 * 确保 `<home>/pi/pith-mcp-bridge.mjs` 存在且内容与当前版本一致，返回其绝对路径。
 * 已存在且内容相同 → 不写盘（避免每轮 spawn 都动文件）。写失败抛错，由调用方决定降级。
 */
export function ensurePiBridge(home: string): string {
  const target = path.join(home, PI_BRIDGE_RELATIVE_PATH);
  let current: string | null = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === PI_BRIDGE_SOURCE) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 原子写：先 .tmp 再 rename（与 LibraryService 的写入约定一致）。
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, PI_BRIDGE_SOURCE, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}
