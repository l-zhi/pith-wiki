# 技术方案：接入 Codex 作为第二个 CLI 委托 provider

状态：草案（待拍板）· 分支：`feat/codex-integration` · 日期：2026-07-24

## 0. 目标

在桌面端聊天里，除了现有的 `claude-code`（委托本机 `claude` CLI）之外，再支持
`codex`（委托本机 `codex` CLI），让用户可复用 ChatGPT / Codex 订阅额度、并通过
pith-mcp 检索知识库作答。CLI（REPL/子命令）继续不支持委托型 provider。

非目标：不改动 openai provider 路径；不做 Codex 的批量水合（水合仍走 openai provider）。

## 1. 现状：claude-code 是怎么接的（作为蓝本）

一次问答委托本机 `claude` CLI（headless）跑一轮，走 pith-mcp 检索后作答。关键组件：

- **`desktop/src/engine/claudeCodeAgent.ts`** — 一个实现 `AgentLike` 的自包含类。
  `send()` 里 `spawn('claude', […])`，用 `--output-format stream-json
  --include-partial-messages` 逐行解析事件流。核心是纯函数 `parseClaudeStream(lines,
  events)`（输入是行的 async 迭代器），可脱离真实进程做单测。多轮靠 `--resume
  <session_id>`（首轮从 result 事件取 session_id 存起来）。
- **MCP**：`--mcp-config <json 文件>`，指向 `~/.pith-wiki/pith-mcp.json`；该 JSON 声明
  如何启动 `bin/pith-mcp.ts`（stdio MCP server，只读检索工具 + weread_gateway）。
- **工具放行**：`--allowedTools 'mcp__pith__*,Bash(lark-cli:*),Bash(curl:*)'` +
  `--permission-mode acceptEdits`（自动批准写文件，写入沙箱=进程 cwd=pith home）。
- **鉴权/复用订阅**：spawn 时注入 `CLAUDE_CODE_OAUTH_TOKEN`，并删掉 `ANTHROPIC_API_KEY`
  → headless 调用走 Pro/Max 订阅、不计 API 费。token 由 `claude setup-token` 生成、设置页填。
- **人设注入**：`--append-system-prompt <pith 检索人设>`（reviewer 模式换另一段）。
- **装配**：`desktop/src/engine/bootstrap.ts` 的 `agentFactory`。
  `if (config.providerKind === 'claude-code')` 分支造 `ClaudeCodeAgent`，否则造 pith 内置
  `Agent`。同一个 `AgentLike` 接口对 `SessionManager` 透明（含 reviewer / ReviewingAgent）。
- **配置**：`src/config.ts` 的 `ProviderSchema.kind: z.enum(['openai','claude-code'])`
  + 顶层 `providerKind`；claude-code 专属字段 `binary/oauthToken/oauthTokenEnv/mcpConfigPath`。
- **水合分流**：`providerKind === 'claude-code'` 时用 `pickHydrationProvider` 选一个 openai
  provider 做后台水合/digest（claude-code 不能做批量 JSON 水合）。
- **CLI guard**：`requireApiKey` 对 claude-code fail-fast（CLI 不实现委托）。
- **设置页**：`detectClis` 探测 `claude` 可执行；`CliDTO.id: 'claude-code'`；protocol 的
  `kind: 'openai' | 'claude-code'`；`setActiveProvider` 对 'claude-code' 合成最小 entry；
  i18n 标签。

## 2. claude 与 codex 的关键差异（方案的核心）

| 维度 | claude CLI | codex CLI | 影响 |
|---|---|---|---|
| headless 入口 | `claude -p "<prompt>"` | `codex exec "<prompt>"` | 参数完全不同 |
| 事件流 | `--output-format stream-json`（Anthropic 事件形态） | `codex exec --json`（codex 自有 JSONL：thread.started / item.completed(agent_message,reasoning,command_execution,mcp_tool_call) / turn.completed+usage） | **需重写 parser** |
| 最终文本 | result 事件的 `result` | turn 的 agent_message，或 `--output-last-message <file>` | 取值方式不同 |
| 多轮 | `--resume <session_id>` | `codex exec resume <SESSION_ID>`（或 `--last`） | 子命令形态不同 |
| MCP 配置 | `--mcp-config <json 文件>` | 读 `~/.codex/config.toml` 的 `[mcp_servers.<name>]`，或 `-c` 覆盖 | **没有 --mcp-config 文件标志** |
| 工具放行 | `--allowedTools` 白名单 | sandbox + 审批策略（`--sandbox workspace-write --ask-for-approval never` / `--full-auto`） | 概念不同，映射到 sandbox 模式 |
| 人设注入 | `--append-system-prompt` | 无 append 标志 → 拼进 prompt，或用 cwd 的 `AGENTS.md` | 需换注入方式 |
| 鉴权/订阅 | 注入 `CLAUDE_CODE_OAUTH_TOKEN` env（可无头生成 token） | `codex login` 写 `~/.codex/auth.json`（交互式 OAuth）；API key 模式用 `OPENAI_API_KEY`/`CODEX_API_KEY` | **无法无头生成 token**，登录是前置人工步骤 |

## 2.5 P0 实测结果（codex-cli 0.145.0，已在本机验证）

> 本机安装已修复（重装 `@openai/codex@latest` → 0.145.0，之前是 vendored binary 被清空）。
> 以下均为真实 `codex exec --json` 抓取所得，非文档推测。

**事件 schema（JSONL，已锁定）**——每行一个对象：
- `{"type":"thread.started","thread_id":"<UUID>"}` — thread_id 就是 resume 用的 session id。
- `{"type":"turn.started"}`
- `{"type":"item.started","item":{...}}` / `{"type":"item.completed","item":{...}}` —
  `item.type` 取值：`agent_message`（`text` = 助手文本）、`reasoning`、
  `command_execution`（`command/cwd/exit_code/aggregated_output/status`）、
  `mcp_tool_call`（`server/tool/arguments/result/error/status`；result =
  `{content:[{type:"text",text}],structured_content}`；status = `in_progress|completed|failed`）。
- `{"type":"turn.completed","usage":{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}`
- `-o/--output-last-message <file>` 也能稳拿最终文本（parser 的兜底）。

**flag 已确认**：`codex exec --json`、`-o <file>`、`-m <model>`、`-C <dir>`、
`-s/--sandbox {read-only|workspace-write|danger-full-access}`、`-c key=value`（值按 **TOML** 解析，
支持 array/inline-table）、`codex exec resume <SESSION_ID|--last> [prompt]`。
exec **没有** `-a/--ask-for-approval`、**没有** `--full-auto`；审批只能 `-c approval_policy=...`。

**claude 没有、codex 必须加的**：`--skip-git-repo-check`（pith home 不是 git 仓库，否则 exec 拒跑）。

**resume 的 flag 差异（P2 实测踩坑）**：`codex exec resume <id>` 的 flag 集**比 `codex exec` 小**——
**不接受 `-s/--sandbox` 与 `-C/--cd`**（会报 `unexpected argument`）。因此 CodexAgent 统一：
沙箱用 `-c sandbox_mode="danger-full-access"`（首轮/resume 都认 `-c`），工作目录靠 spawn 的 `cwd`
（resume 用显式 SESSION_ID 定位会话，不依赖 `-C`）。resume 多轮已实测跑通：第二轮不重新检索、
仅凭 thread 上下文正确回答依赖首轮的问题。

**`-c` 挂 MCP 成功（已验证）**：
`-c 'mcp_servers.pith.command="node"' -c 'mcp_servers.pith.args=["<pith-mcp.js>"]'
-c 'mcp_servers.pith.env={ PITH_WIKI_HOME = "<home>" }'`
→ codex 加载 server、模型发现并正确调用 `wiki_list`、拿回真实知识库数据。**不需要动用户 config.toml。**
MCP server 配置字段仅：`command/args/env/enabled_tools/startup_timeout_sec/tool_timeout_sec`
（无 per-server「受信/免审批」开关）。

**🔴 关键安全取舍（务必周知）**：headless exec 下，**只有 `-s danger-full-access` 能让 MCP 工具
真正执行**。`-s read-only` 与 `-s workspace-write` 下（无论 `approval_policy` 设成 never 与否，
无论 cwd 是否等于数据目录）MCP 调用都会被判为需审批、exec 无审批通道 → 报
`error: "user cancelled MCP tool call"`、`status:"failed"`。这是 codex 0.145.0 的行为：
MCP 工具跑在 host 进程、沙箱兜不住，受限沙箱下即需逐次审批。
- 后果：codex 分支拿不到 claude-code `acceptEdits`那种「写入限定在 cwd」的约束——
  danger-full-access 下 codex 自带的 shell/apply_patch 能以引擎权限读写任意路径。
- v1 缓解：① 只经 pith-mcp 暴露**只读**检索工具（server 本身无写能力）；② spawn 时
  `-C <pith home>` 设工作根 + system prompt 限定只写 output dir（软约束，非硬边界）；
  ③ 这是用户主动选择 codex provider 的 standing consent，跑在本机。**记进 ADR 作为已知取舍。**
- 待探索（非阻塞）：用 macOS `sandbox-exec` 在外层自建沙箱包住 codex 进程，找回硬边界。

## 3. 架构方案

沿用 claude-code 的模式：新增一个自包含的 `CodexAgent implements AgentLike`，与
`ClaudeCodeAgent` 平级（sibling）。`SessionManager` 无感知。

**为何用 sibling 类而非抽公共基类**（v1 取舍）：两者真正相同的只有「spawn+abort+exit
+history」这层薄胶水，而 args 构造、事件解析、MCP 装配、鉴权四处全不同。硬抽基类会为省
~40 行胶水引入一个漏水抽象。保留独立类 + 独立纯函数 `parseCodexStream`（对齐
`parseClaudeStream` 的可测形态），是最低风险、最可测、最贴现有约定的做法。共享基类留作后续
（两个 CLI agent 都稳定后再看是否值得抽 `CliDelegateAgent`）。

### 3.1 MCP 装配（推荐方案）

不改用户的 `~/.codex/config.toml`（避免污染用户环境）。spawn 时用 `-c` 覆盖内联注册
pith stdio MCP server。**已实测可用**的确切形态（引擎将据此拼参数）：

```
codex exec --json --skip-git-repo-check \
  -s danger-full-access \                          # ← 见 §2.5，MCP 工具在受限沙箱下会被取消
  -C <pith home> \
  -m <model> \
  -o <临时文件：拿最终文本兜底> \
  -c 'mcp_servers.pith.command="node"' \
  -c 'mcp_servers.pith.args=["<pith-mcp.js 绝对路径>"]' \
  -c 'mcp_servers.pith.env={ PITH_WIKI_HOME = "<home>" }' \
  "<人设前置 + prompt>"
# 多轮：codex exec resume <thread_id> [同上 flag] "<下一轮 prompt>"
```

复用现有 `~/pith-mcp.json`：读它拿到 command/args/env，翻译成 `-c` 覆盖（一处真源，两个 CLI 共用）。
`-c` 值按 TOML 解析、array/inline-table 都实测支持，**无需**改用户 config.toml、无需回退方案。

### 3.2 鉴权/订阅复用

Codex 无法像 claude 那样无头生成 token。两种模式：

- **订阅模式（推荐默认）**：用户先跑一次 `codex login`（写 `~/.codex/auth.json`），engine
  spawn codex 时**不设** `OPENAI_API_KEY`，codex 自动读 auth.json 走订阅。设置页把 provider
  卡片从「填 token」改成「检测登录状态 + 一键跑 `codex login`（或提示手动跑）」。
- **API key 模式**：设置页填 key → 存 `secrets`/env，spawn 时注入 `OPENAI_API_KEY`。

### 3.3 人设注入

Codex 无 `--append-system-prompt`。方案：把 pith 检索人设**前置拼进 input**（首轮或每轮，
resume 下人设已在 thread 历史里可仅首轮）。reviewer 模式同理换段前置。（可选增强：往 cwd=pith
home 写一份 `AGENTS.md` 承载静态 QA 人设——但 reviewer 是动态段，仍需前置拼接，故 v1 只做前置拼接。）

## 4. 具体改动（file-by-file）

**core（`src/`）**
- `config.ts`
  - `ProviderSchema.kind` 与顶层 `providerKind`：enum 加 `'codex'`。
  - 加 codex 专属字段：`binary`（默认 `codex`）、`codexApiKeyEnv?`（API key 模式，可复用
    `apiKeyEnv`）、MCP 复用 `mcpConfigPath`。codex 不需要 oauthToken。
  - `applyActiveProvider` / baseURL 兜底：codex 与 claude-code 一样不需要真实 baseURL。
  - `pickHydrationProvider`：把「排除条件」从 `kind==='claude-code'` 改成
    `kind!=='openai'`（引入 helper `isOpenaiProvider`），codex 同样不入选水合。
  - `requireApiKey` 的 desktop-only guard：`providerKind !== 'openai'` 时 fail-fast（覆盖 codex）。

**engine（`desktop/src/engine/`）**
- 新增 `codexAgent.ts`：`CodexAgent implements AgentLike` + 纯函数 `parseCodexStream`。
- `bootstrap.ts`
  - `agentFactory`：把 `if (providerKind === 'claude-code')` 重构成按 kind 分派
    （`claude-code` → ClaudeCodeAgent；`codex` → CodexAgent；`openai` → Agent）。
    reviewer/ReviewingAgent 装配逻辑复用。
  - 新增 `CODEX_SYSTEM_PROMPT`（或复用 `CLAUDE_CODE_SYSTEM_PROMPT`，措辞里的
    `mcp__pith__` 工具名一致）。
  - hydration/review 分流：`if (providerKind === 'claude-code')` 处一并放行 codex。
  - `resolveBinaryPath('codex')`；`detectClis` 追加 codex 项。
  - `setActiveProvider` 合成最小 entry 的分支加 `'codex'`。
  - 切换后「找不到 mcp 配置」的非阻塞提示对 codex 也适用。

**protocol / renderer**
- `shared/protocol.ts`：`ProviderDTO.kind`、`SettingsSaveDTO` 的 kind、`CliDTO.id`
  union 加 `'codex'`。
- `views/Settings.tsx`：CLI 选项渲染、provider 卡片类型判断（openai vs 委托型）；codex
  卡片走「登录检测」而非「填 token」（见 3.2）。
- `i18n/zh.ts` `en.ts`：codex 相关文案。

**测试**
- `parseCodexStream` 的单测（喂真实抓取的 JSONL fixture，覆盖：agent_message 流式、
  mcp_tool_call、command_execution、reasoning、turn.completed usage、多轮 resume 的
  session_id 提取、错误/中断收尾）。
- config schema：codex provider 解析 + 水合分流 + CLI guard。

## 5. 实施阶段

- **P0 前置**：✅ **已完成**（见 §2.5）。安装已修（0.145.0），事件 schema / flag / `-c` 挂 MCP /
  沙箱行为全部实测锁定。真实抓取样本存于会话 scratchpad（`codex-exec.jsonl` /
  `codex-mcp*.jsonl`），可作 `parseCodexStream` 单测 fixture 的起点。剩一项待 P2 顺手验：
  `codex exec resume <thread_id>` 的多轮续接（子命令已确认存在，行为待跑通）。
- **P1**：config schema + `CodexAgent` + `parseCodexStream` + 单测（engine 内可跑，不碰 UI）。
- **P2**：✅ **已完成**。bootstrap `agentFactory` 三路分派（claude-code/codex/openai）+ 委托型
  writer prompt 提取共用 + hydration/review provider guard 放行/拦截 codex + `readPithMcpSpec`
  把 pith-mcp.json 翻成 `-c` 覆盖。本机实测：一轮 wiki_list 检索问答 + 多轮 resume（凭上下文作答）
  全通，订阅模式（无 OPENAI_API_KEY）跑通。写文件落盘留待接 UI 后随手测。
- **P3**：✅ **已完成**。protocol union（ProviderDTO/CliDTO/SettingsSaveDTO）加 `'codex'`；
  bootstrap `detectClis` 探测 codex、`setActiveProvider` 合成 codex 最小 entry（默认 gpt-5.6-sol）、
  `settingsGet` kind 映射、`saveSettings`（baseURL 校验/merge/binary 回填按 openai vs 委托型分流）、
  `needsOnboarding`/mcp-not-found 提示覆盖 codex；Settings.tsx `cliOptions` 泛化按 `cli.id` 匹配 entry
  （codex 与 claude-code 一样只作聊天模型选择项，非 API 卡片）；i18n soulDesc 提及 Codex。
  codex 鉴权沿用 claude-code 模式（依赖用户已 `codex login`，无独立登录 UI）。加 5 个 codex config 单测。
  两侧 typecheck 干净、851 测试全绿。
- **P3.1（追加，用户要求）**：✅ **审稿选择器允许委托型 CLI 当 reviewer**。原「审稿 provider 必须是
  API provider」的约束推翻——审稿选择器现同时列出 claude-code/codex。落地：抽 `makeDelegatedAgent`
  （writer 与 CLI-reviewer 共用同一套 env/mcp 装配）；agentFactory reviewer 三选一（CLI 覆盖 /
  openai client / 同 writer）；`setReviewProvider` 去掉 openai-only 拦截、对未建 entry 的 CLI 走
  `synthCliEntry` 合成（与 setActiveProvider 共用，支持「chat 用 API、review 用 codex」的混搭）；
  initServices 审稿 client 装配只对 openai 建、CLI 保持 null 交给 agentFactory。**取舍**：CLI reviewer
  审稿模式下**每轮 spawn**，比 API reviewer 慢、烧订阅额度——用户已知并接受（记进 ADR）。
- **P4**：文档（README/config.md/新 ADR 记录「第二个委托 CLI」的设计取舍）。

## 6. 决策（已定 / 待定）

1. ✅ **鉴权模式 = 订阅优先**：默认 `codex login`（写 `~/.codex/auth.json`）复用订阅，
   spawn 时不设 `OPENAI_API_KEY`；API key 作为备选通道。设置页 codex 卡片走「登录状态检测」
   而非「填 token」。
2. ✅ **MCP 装配 = `-c` 内联覆盖**（P0 已实测通过）：spawn 时 `-c mcp_servers.pith.*` 内联注册，
   不碰用户的 `~/.codex/config.toml`。`-c` 的 TOML array/inline-table 解析已验证支持，回退方案不需要了。
3. ✅ **沙箱取舍 = 接受 + 记 ADR**（已定）：v1 接受「codex 写入只受软约束」——`-s danger-full-access`
   + 只读 pith-mcp + `-C <pith home>` + system prompt 限定只写 output dir。理由：本机运行、
   用户主动选择 codex provider（standing consent）、检索工具只读。实现时**新增一条 ADR** 记录此
   已知取舍；macOS `sandbox-exec` 外层硬边界列为后续增强，不阻塞 v1。
4. ⏳ **范围（待定，建议）**：本轮只做 codex 聊天 provider 打通（问答 + 多轮 + 写文件落盘），
   外部数据源（weread_gateway / lark）在 codex 下的验证单独一轮。
