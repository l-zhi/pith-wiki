# 技术方案：接入 pi 作为第三个 CLI 委托 provider（迁移路线的第一步 C）

状态：已实现（本机端到端实测通过）· 分支：`research/pi-harness-migration` · 日期：2026-07-27
上游依据：`docs/research-pi-harness-migration.md` §6 推荐路径 **C → B →（A 观望）**

## 0. 目标

桌面端聊天里再加一个委托型 provider `pi`（委托本机 `pi` CLI，`pi --mode json`），让用户复用
pi 的 OAuth 订阅额度（Claude Pro/Max、GitHub Copilot、xAI、OpenRouter…）并通过 pith 的
知识库作答。CLI（REPL/子命令）继续不支持委托型 provider。

非目标：不动 openai provider 路径；不做 pi 的批量水合（水合仍走 openai provider）；不引入
`pi-ai` / `pi-agent-core` 依赖（那是路线里的 B / A 步骤）。

## 1. pi 与 claude-code / codex 的关键差异

| 维度 | claude CLI | codex CLI | **pi CLI** |
|---|---|---|---|
| headless 入口 | `claude -p` + `--output-format stream-json` | `codex exec --json` | `pi --mode json "<prompt>"` |
| 事件流 | Anthropic 事件形态 | codex 自有 JSONL | pi 的 `AgentSessionEvent`（message_update/tool_execution_*/turn_*/agent_*） |
| 多轮 | `--resume <id>` | `exec resume <thread_id>` | `--session <id>`（id 来自首行 session header） |
| 人设注入 | `--append-system-prompt` | 无标志 → 拼进 prompt | `--append-system-prompt`（同 claude） |
| **知识库接入** | `--mcp-config <file>` | `-c mcp_servers.pith.*` | **pi 完全没有 MCP** → 需要桥接扩展（本方案的核心） |
| 鉴权/订阅 | 注入 `CLAUDE_CODE_OAUTH_TOKEN` | `codex login` → `~/.codex/auth.json` | `pi` 里 `/login` → `~/.pi/agent/auth.json`（多家订阅） |
| 权限/沙箱 | `--allowedTools` + `acceptEdits` | sandbox 模式 + 审批策略 | **无沙箱、无权限系统**（官方明示），只能靠 cwd + prompt 软约束 |

## 2. 核心设计：用桥接扩展补上 MCP

pi 的设计原则里明确不做 MCP（`docs/usage.md` "Design Principles"）。但 pi 的**扩展**是一等公民：
`pi -e <file>` 加载 TS/JS 模块，可 `pi.registerTool()`、订阅事件、用 `node:` 内建与 npm 依赖。

于是：`desktop/src/engine/piBridgeSource.ts` 内嵌一段**零依赖**扩展源码，手写 MCP JSON-RPC
over stdio（换行分隔），启动时 `initialize → tools/list`，把 pith-mcp 的每个只读检索工具
`pi.registerTool` 成 pi 原生工具，`session_shutdown` 时收尾。

一份 `~/.pith-wiki/pith-mcp.json` 现在被三个 CLI 共用（claude-code 直接传文件、codex 翻成
`-c` 覆盖、pi 经环境变量交给桥接扩展），没有新增配置真源。

**为什么源码内嵌 + 运行时写盘**（而不是仓库里放 `.mjs` 再打包）：桌面产物由 electron-vite
打进 `out/`，额外资源要走 electron-builder 的 extraResources 加三套路径回退（dev / npm CLI /
packaged）。写盘方案零打包改动，且与「首次使用写 `security.json` 模板」是同一个既有套路。
落点 `<home>/pi/pith-mcp-bridge.mjs`，按内容比对决定是否覆盖（升级 pith 自动换新）。

**与 pi 官方指引的一处偏离**：文档建议不要在 extension factory 里起后台资源。我们必须在
factory 里握手（工具名/schema 来自 `tools/list`，而 registerTool 要在 session 起来前完成）。
pith 只用单轮 `--mode json`（必然开 session）+ 注册了 `session_shutdown`，可接受，已在代码注释里标注。

## 3. 实测契约（pi 0.82.1，本机真实抓取，非文档推测）

验证方式：本地起一个假的 openai-compatible 端点（`models.json` 注册成自定义 provider），
因此**不需要任何真实凭据**就能跑完整轮 tool-call 循环。抓取已固化为
`desktop/tests/fixtures/pi-json-mode.jsonl`（31 条事件），单测直接回放。

- **首行是 session header**：`{"type":"session","version":3,"id":"<uuid>","timestamp":…,"cwd":…}`；
  `id` 就是 `--session` 复用的会话 id（实测第二轮传 `--session <id>` → 同一 id，请求携带
  完整历史：第一轮 2 条消息 → 第二轮 6 条）。
- **正文**：`message_update` + `assistantMessageEvent.type='text_delta'` 的 `delta` 流式增量；
  `message_end` 的 assistant 消息里 `content` 的 `text` 块是权威正文（parser 以此为准）。
- **thinking**：`content` 的 `thinking` 块（也有 `thinking_delta` 增量事件，v1 只取块）。
- **usage**：assistant `message_end` 的 `usage.input/.output`，**按轮累加**（实测 120+300 / 20+15）。
- **工具**：`tool_execution_start{toolCallId,toolName,args}` → `tool_execution_end{toolCallId,result,isError}`，
  按 toolCallId 配对成一条 UI 工具行。
- **失败**：assistant 消息 `stopReason: 'error' | 'aborted'` + `errorMessage`（不是独立 error 事件）。
- **`--no-extensions` 与 `-e` 可共存**：`pi --help` 原文「Disable extension discovery (explicit -e paths still work)」，
  正是「只加载 pith 桥接扩展、忽略用户全局扩展」需要的语义。
- **TypeBox 接受普通 JSON Schema**：桥接把 MCP 的 `inputSchema`（MCP SDK 由 zod 生成的
  draft-07）原样当 `parameters` 传给 `registerTool`，pi 正常校验并放行参数。**这条同时回答了
  调研报告 §6.2 的 spike**——迁移工具层时 zod→JSON Schema 适配器路线可行，不必全量重写 TypeBox。
- **stdin 必须关掉**：print/json 模式会读管道 stdin 并并入 prompt，父进程不关 stdin 会挂住
  （PiAgent 用 `stdio: ['ignore', …]`）。
- **不能用 `node:readline` 切行**：pi 的 `docs/rpc.md` 明确 readline 还会在 U+2028/U+2029 断行，
  而这两个字符在 JSON 字符串里合法（知识库正文里很常见）。PiAgent 自带只按 `\n` 切的
  `splitJsonLines`（有专门单测）。

## 4. 改动清单（file-by-file）

| 文件 | 改动 |
|---|---|
| `desktop/src/engine/piBridgeSource.ts` | 新增：桥接扩展源码 + `ensurePiBridge(home)`（原子写、按内容幂等） |
| `desktop/src/engine/piAgent.ts` | 新增：`splitJsonLines` / `parsePiStream`（纯函数，可单测）/ `PiAgent implements AgentLike`（含 `buildArgs`） |
| `src/config.ts` | `ProviderSchema.kind` 与 `providerKind` 加 `'pi'`；`resolveProviderEntry` 给 pi 兜占位 baseURL `https://pi.invalid`；注释同步（`pickHydrationProvider` / `requireApiKey` 天然把 pi 排除在水合与 CLI 之外） |
| `desktop/src/engine/bootstrap.ts` | 抽出 `DelegateKind` / `isDelegateKind` / `DELEGATE_LABELS` / `DELEGATE_BINARIES` / `DELEGATE_DEFAULT_MODELS`，把三处硬编码的 `kind === 'claude-code' \|\| kind === 'codex'` 收敛掉；`makeDelegatedAgent` 加 pi 分支；`detectClis` / `synthCliEntry` / `settingsGet` / `saveSettings` / 缺 pith-mcp 提示全部泛化到三种 kind |
| `desktop/src/shared/protocol.ts` | 新增 `DelegateKindDTO` / `ProviderKindDTO`，替掉三处字面量联合 |
| `desktop/src/renderer/src/views/Settings.tsx` | `ProviderDraft.kind` 用共享类型（CLI 选项渲染本来就是数据驱动的，无需改逻辑） |
| `desktop/tests/piAgent.test.ts` | 新增 10 例：手写序列、真机抓取回放、错误路径、工具兜底、chunk 边界、U+2028、`buildArgs` flag 组合 |
| `desktop/tests/piBridge.test.ts` | 新增 5 例：写盘/幂等/覆盖/`node --check` 语法校验/未配 MCP 时 no-op |
| `desktop/tests/fixtures/pi-json-mode.jsonl` | 新增：真机抓取的 31 条事件（cwd 已脱敏） |
| `tests/config.test.ts` | 新增 3 例：pi 的占位 baseURL、水合排除、CLI fail-fast |

## 5. 已知取舍（v1）

1. **无沙箱**：pi 不提供权限系统，内建 `write/edit/bash` 是全权的。写入落点只受 spawn cwd
   （pith home）+ system prompt 的软约束——与 codex 分支的 `danger-full-access` 同一级别取舍
   （本机运行 + 用户主动选择 + 只读 MCP）。pith 自己的沙箱/审批只覆盖内置 Agent 路径。
2. **确定性优先**：`--no-extensions`（只留 pith 桥接）、`-na`（忽略工作目录里的 `.pi` 资源，
   防知识库目录劫持 pi 配置）、`-nc`（不吃 AGENTS.md/CLAUDE.md）。代价是用户自己的 pi 扩展
   在 pith 会话里不生效——需要时再加配置开关。
3. **重启丢 pi 侧上下文**：pith 重启后 `exportHistory/restoreHistory` 保留对话本体供 UI 回放，
   但 pi 的 session id 不随 pith 历史持久化（与 claude-code/codex 完全一致的 v1 限制）。
4. **模型默认值**：`ProviderSchema.model` 不允许空串，故「用 pi 自己的默认模型」用 `'default'`
   表达，PiAgent 见到它就不传 `--model`。
5. **每轮 spawn 一个 pi 进程**（首轮还要多 spawn 一个 pith-mcp）：延迟高于内置 Agent，与另两个
   委托 provider 同构。

## 6. 用户使用步骤

```bash
npm i -g @earendil-works/pi-coding-agent   # 装 pi
pi                                          # 交互模式里 /login 选订阅（写 ~/.pi/agent/auth.json）
```

然后在 pith 桌面端「设置 → 对话模型」里选 **pi CLI**（本机检测到才会出现），确保
`~/.pith-wiki/pith-mcp.json` 存在（三个委托 CLI 共用）。不填 key = 走订阅；填了 key = 按量计费。

## 7. 路线 B（已实现）：`pi-ai` 作为可选传输层

### 7.1 做法：一个与 OpenAI SDK 同形的传输接口

`src/llm/transport.ts` 的 `ChatClient` 是**故意**与 `chat.completions.create` 同形的结构化接口。
换来三件事：`OpenAI` 实例天然满足它、安全过滤层逻辑一行不改、Agent/Hydration/buildContext
只改类型标注。于是「换传输」= 换一个实现了 `ChatClient` 的对象。

`src/llm/piAiTransport.ts` 是 pi-ai 实现：
`toPiContext()` 把 pith 的 OpenAI 形状历史翻成 pi-ai `Context`（system→systemPrompt、
`reasoning_content`→thinking 块、`tool_calls`→toolCall 块、tool→toolResult 并按 id 反查 toolName），
`models.completeSimple()` 出站，`toChatCompletion()` 翻回 OpenAI 形状（thinking→`reasoning_content`，
usage→`prompt_tokens/completion_tokens`，stopReason→`finish_reason`）。

两种 provider 装配：不设 `piProvider` → 用 `baseURL/apiKey/model` 现造 openai-completions
自定义 provider（等价于现状）；设了（如 `anthropic`）→ 动态 import pi-ai 内建 provider 全集，
鉴权走它的解析链。**动态** import 是刻意的：内建全集会牵进 Anthropic/Google/Mistral/Bedrock
四个 SDK，不用就不该付启动与体积成本。

### 7.2 关键约束：水合必须留在 openai SDK

pi-ai 没有 `response_format: json_object` 的对等物，而水合/digest/`wiki_ingest` 依赖它。
`createClient(config, { purpose: 'hydration' })` 强制回落 openai SDK；带 `response_format`
的请求进了 pi-ai 传输会**显式抛错**（不静默降级）。因此 App.tsx / bootstrap / 子命令 /
队列 worker 各自持一份水合 client，`buildContext` 收的也是水合 client（它的 client 参数只用来造 hydrator）。

### 7.3 实测

- **单测**（`tests/pi-transport.test.ts`，12 例）：用 pi-ai 的 `fauxProvider()`，`FauxResponseFactory`
  能拿到 pith 真正喂进去的 `Context` —— 映射是被断言的，不是纸上推演。含 JSON 模式报错、
  `stopReason=error/aborted` 的抛错语义、以及**安全过滤层覆盖 pi-ai 传输**（出站只见 `[PHONE_1]`，
  入站还原成真号码）。
- **真机**（本地假 openai 端点）：`pith 真 Agent + 真 wiki_list 工具 + 安全层 + pi-ai 传输`
  跑完两轮 —— 工具在真实库上命中 1 条，最终答案正确，usage 两轮分别 120/20 与 300/15。

### 7.4 已知取舍

1. **thinking 签名不保真**：pith 历史是 OpenAI 形状，thinking 只有文本、没有 provider 签名。
   对 DeepSeek/GLM 的 `reasoning_content` 语义无损；Anthropic 原生 extended thinking 不是这条路
   的目标（要用就走 §0–§6 的委托 provider，或等路线 A）。
2. **仍是非流式**：pith 的 agent loop 是 `stream: false`，这里用 `completeSimple` 对齐。流式、
   compaction、steering 属于路线 A 的收益。
3. **没有 UI 开关**：transport 目前只在 config.json / env / provider entry 上配（`transport`、
   `piProvider`、`PITH_WIKI_TRANSPORT`、`PITH_WIKI_PI_PROVIDER`）。要不要进设置页，等实际用过再定。

## 8. 下一步（路线 A，暂不做）

用 `pi-agent-core` 替掉 `src/llm/agent.ts` 才能拿到流式/自动 compaction/steering/树形会话。
前置未答的 spike：流式下的 mask 跨 chunk 还原、hydration 的结构化输出替代、Electron 打包体积。
另外先看上游：0.x → 1.0 的稳定性、Earendil 商业化后开源包的维护承诺。
