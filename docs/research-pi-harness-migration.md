# 技术分析报告：把 pith 的基础 harness 换成 pi

> 调研分支：`research/pi-harness-migration`
> 日期：2026-07-27
> 对象版本：`@earendil-works/pi-*` **0.82.1**（`@mariozechner/pi-*` 0.73.1 已 deprecated，官方提示迁到 earendil 命名空间）
> 结论性质：**调研 + 方案对比**，未改一行产品代码

---

## 0. TL;DR

| 问题 | 答案 |
| --- | --- |
| 成本高么？ | **全量替换很贵（2–4 周 + 持续跟版）；只换 LLM 传输层不贵（3–5 天）；把 pi 当第三个委托 provider 最便宜（1–2 天）**。 |
| 贵在哪？ | 不在 agent loop（584 行，扔掉不心疼），贵在三样 pith 自有资产要在 pi 上重建：**安全过滤（block/mask，613 行）**、**沙箱+审批**、**桌面端会话历史格式与回放（JSONL + deriveDisplay）**。外加 20 个工具定义从 zod 迁到 TypeBox。 |
| 能换到什么？ | 多 provider + **OAuth 订阅登录（Claude Pro/Max、Copilot、xAI）**、**自动 compaction**、流式输出、steering/follow-up、树形会话（fork/branch）、token/成本核算、并行工具执行、自动重试、图片输入、扩展生态。 |
| 会失去什么？ | pi **明确不做**沙箱、权限审批、MCP、subagent；**没有 `response_format: json_object`**（hydration 核心链路依赖它）。 |
| 建议 | **C → B → 视上游稳定性再评估 A**（见 §5）。先把 pi 作为 delegate provider 接进来（与 `a2df33c` 接 codex 的路径完全一致），零风险拿到订阅额度和模型面；再考虑用 `pi-ai` 换掉 `openai` SDK；`pi-agent-core` 全量替换暂不做。 |

---

## 1. pi 是什么（事实核对）

- 起源：Mario Zechner（libGDX 作者）2025 年底开源的极简 coding agent harness（`badlogic/pi-mono`）。核心主张：**前沿模型不需要厚 scaffolding，厚 system prompt 是给弱模型的补丁**——所以 pi 走 token 效率 + 操作者控制路线。
- 现状：2026 年 4 月被创业公司 **Earendil 收购**并推出商业云平台 Lefos。仓库现为 `earendil-works/pi`，npm 迁到 `@earendil-works/*`，旧 `@mariozechner/*` 打了 deprecated。README 明写「新贡献者的 issue/PR 默认自动关闭」——**社区治理是封闭的**。
- 分包（0.82.1）：

| 包 | 作用 | unpacked | 关键依赖 |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | 统一多 provider LLM API（流式、tool calling、thinking、成本、跨 provider 交接） | 5.4 MB | `openai`、`@anthropic-ai/sdk`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`、`typebox` |
| `@earendil-works/pi-agent-core` | 有状态 agent + 工具执行 + 事件流（UI-free） | 1.7 MB | `typebox`、`diff`、`yaml`、`ignore` |
| `@earendil-works/pi-coding-agent` | 完整 coding agent：session/settings/skills/extensions/compaction/RPC/SDK | 14 MB | 上面全部 + `pi-tui` |
| `@earendil-works/pi-tui` | 终端 UI（差分渲染） | 2.0 MB | `marked` |

- 明确**不提供**（README/usage.md 原文）：内置 MCP、subagent、权限弹窗、plan mode、todo、后台 bash。security.md 原文：**「Pi does not include a built-in sandbox」**，隔离要靠容器/VM。

对 pith 的含义：pi 是**替换 agent loop + LLM 传输层**的候选，**不是**替换 pith 安全模型的候选——安全那部分只能自己带过去。

---

## 2. 现有 harness 盘点（要被替换的到底是什么）

pith 的「基础 harness」不是一个模块，是六层：

| 层 | 文件 | 行数 | 现状 |
| --- | --- | --- | --- |
| L1 传输 | `src/llm/client.ts` | 45 | 唯一 client 工厂，`new OpenAI` + 超时 + 安全包裹 |
| L1' 安全 | `src/security/{wrap,rules,sanitizer,types}.ts` | 613 | monkey-patch `chat.completions.create`：出站 block/mask，入站按 `content` / `tool_calls.arguments` / `reasoning_content` 逐字段还原 |
| L2 agent loop | `src/llm/agent.ts` | 584 | 12 步上限、`LOW_BUDGET_RESERVE` 预算告警、`forceFinalAnswer` 兜底、`splitThinking`、`@`-mention scope preamble、`p-queue(1)` 串行工具、`SecurityBlockError` 历史回滚 |
| L3 工具 | `src/tools/*.ts`（20 个 `parameters:` 定义）+ 手写 `zodToJsonSchema` | 232 + 各文件 | zod schema、`handler(args, ctx)` 注入 `ToolContext`、返回任意 JSON |
| L4 沙箱/审批 | `src/tools/safety.ts` + `ToolContext.requestApproval/requestCommandApproval` | 101 + 分散 | `realpathSync` 沙箱、写路径/命令二进制逐个审批 |
| L5 会话 | `desktop/src/engine/{sessionManager,sessionStore}.ts` | 660 + 172 | `AgentLike` 接口 + OpenAI 形状 `ChatCompletionMessageParam` JSONL + `deriveDisplay` 把消息序列派生成 UI 回放 |
| L6 UI | `src/cli/App.tsx` 等 | 1124+ | Ink REPL 消费 `AgentEvents`（`onThinking/onAssistantText/onToolRound/onUsage`） |

耦合面比想象的小——`grep 'new OpenAI\|chat.completions'` 只命中 **7 个源文件**：`client.ts`、`agent.ts`、`hydration.ts`、`security/wrap.ts`、`bin/pith-mcp.ts`（占位 client）、`config.ts`（注释/校验）、`tools/index.ts`（仅类型）。

**已有的好消息**：`desktop/src/engine/sessionManager.ts:27` 的 `AgentLike` 已经是一个抽象接口（`send/exportHistory/restoreHistory/reset/snapshot`，历史是 `unknown[]`），并且已有 4 个实现：内置 `Agent`、`ClaudeCodeAgent`、`CodexAgent`、`ReviewingAgent`。**pi 天然可以成为第 5 个实现**——这是最便宜路径存在的结构性原因。

---

## 3. 替换清单（逐层，含工作量）

### L1/L1' 传输层与安全过滤 —— 最关键的一处，也是最大的隐性成本

现在：`createClient` 是**唯一出站口**，monkey-patch 一个方法就覆盖了 Agent / hydration / queue worker / review。

换 pi 后：pi-ai 自己持有 provider adapter（Anthropic SDK、Google GenAI、OpenAI…），**没有「一个 `chat.completions.create` 可以打补丁」**。替代挂点：

- `before_provider_request` / `after_provider_response` / `before_provider_headers`（pi-coding-agent 的 extension 事件，见 `docs/extensions.md:660-711`）
- 或者自己实现 `streamFn`（`Agent` 构造参数），完全接管请求

⚠️ 风险点：还原逻辑必须覆盖**流式增量**。pith 现在是 `stream: false`，拿到完整 JSON 再还原；pi 是流式优先，`[LABEL_N]` 占位符可能被切在两个 delta 之间——**还原逻辑要从「整体替换」改成「跨 chunk 状态机」**。这是本次迁移里最容易低估的一块。

工作量：**3–5 天**（含跨 chunk 还原的测试）。

### L2 agent loop —— 可以整块扔掉，这是收益最大的地方

`pi-agent-core` 的 `Agent` 直接覆盖 pith 手写的这些：

| pith 现有机制 | pi 对应物 | 评价 |
| --- | --- | --- |
| `maxSteps=12` 硬上限 | `shouldStopAfterTurn` + 自动 compaction | pi 更好 |
| `LOW_BUDGET_RESERVE=3` 预算告警（土办法） | 阈值/溢出触发的 compaction | pi 更好，可删 |
| `forceFinalAnswer()` 兜底 | `terminate` / `shouldStopAfterTurn` | 语义更干净 |
| `splitThinking()` + `reasoning_content`/`thinking` 手工回传 | `thinkingLevel` + `thinking_delta` 事件 + 跨 provider 归一 | pi 明显更好，`split-thinking.test.ts` 可退役 |
| `p-queue(1)` 串行工具 | `toolExecution: 'parallel' \| 'sequential'`（含 per-tool 覆盖） | pi 更好且可退回串行 |
| `AgentEvents` 四回调 | `subscribe()` 的 11 种事件 | 更细，UI 改造量在此 |
| `@`-mention scope preamble（send 入口注入） | `transformContext` hook | 直接对应 |
| `SecurityBlockError` 历史回滚 | 无对应，需自己在 hook 里做 | 要重建 |

工作量：**2–3 天**写适配层（把 pi Agent 包成 `AgentLike`）。

### L3 工具层 —— 机械但量大

- 20 个 `parameters:` 定义：`zod` → `typebox`（`AgentTool.parameters: TSchema`）。
- `ToolContext` 注入方式变了：pi 的 `execute(toolCallId, params, signal, onUpdate)` **没有 ctx 参数** → 全部改成工厂函数闭包捕获 ctx（`makeSkillTool` 已是这个写法，可作范式）。
- 返回值 shape 变了：`unknown` → `{ content: [{type:'text', text}], details }`；错误从 `{ok:false,error}` 改成 **throw**。
- 好消息：**手写的 `zodToJsonSchema`（只认 8 种 zod 构造，union/record 静默退化成 `{}`）可以删掉**，CLAUDE.md 里那条长期 gotcha 消失。
- 替代方案（省事版）：保留 zod，用 `zod-to-json-schema` 产出 JSON Schema 直接塞给 `parameters`（TypeBox 运行期校验吃普通 JSON Schema 的可行性**需 spike 验证**，见 §6.2）。

工作量：**3–4 天**（全量 TypeBox 重写）或 **1 天**（zod→JSON Schema 适配器，若 spike 通过）。

### L4 沙箱与审批 —— pi 完全不管，原样保留

`safety.ts` 的 realpath 沙箱留着不动；审批从 `ToolContext.requestApproval` 改挂 **`beforeToolCall` hook**（`{ block: true, reason }` 正好是拒绝语义）。这层是**平移，不是升级**——pi 在这里只提供挂点。

工作量：**1–2 天**。

### L5 会话持久化 —— 桌面端的真实成本中心

- `sessionStore.ts` 的 JSONL 存的是 **OpenAI 形状消息**；`deriveDisplay()`（`sessionManager.ts:527`）逐字段读 `role/content/tool_calls/tool_call_id` 派生 UI 回放。
- pi 的 `AgentMessage` 是**内容块数组**结构，且 pi 自带 `SessionManager`（树形、`id/parentId`、fork/branch/label）。
- 二选一：
  - **保留 pith 的 SessionStore**：写 `AgentMessage ↔ 存储格式` 双向转换 + 改 `deriveDisplay`（历史数据兼容，改动可控）；
  - **换成 pi SessionManager**：拿到树形会话/fork 能力，但要迁移既有 `~/.pith-wiki/sessions/` 数据，并且 UI 侧要新增分支概念。
- ⚠️ 存量用户数据必须可读——不能出现「升级后历史会话打不开」。

工作量：**3 天**（转换层路线）/ **1–2 周**（换 pi SessionManager 并加分支 UI）。

### L6 UI 层

- **不要引 pi-tui**。pith 的 Ink 组件（`Dashboard` 398、`MarkdownView` 334、`InputBox` 304、`StatusBar` 269）是自有投入，且 `pi-agent-core` 是 UI-free 的，Ink 可原样保留。
- 改造点：`App.tsx:498` 的 `agent.send(...)` + 4 个回调 → `session.subscribe(event)`；顺带可以**第一次拿到真流式输出**（现在 `stream:false`，用户等整轮）。

工作量：**2–3 天**（CLI）+ **2–3 天**（桌面 renderer 的流式增量渲染）。

### L7 hydration —— 一个硬约束

`HydrationService` 依赖 `response_format: { type: 'json_object' }`（`config.supportsJsonMode`）。**pi-ai 没有对等的 JSON 输出模式**——它只有 tool 级 constrained sampling（`constrainedSampling: { type:'json_schema', strict:'prefer' }`），且 strict 支持列表是 OpenAI/Anthropic/Bedrock/Mistral/Gemini，**DeepSeek 不在其中**。

选项：
1. hydration 继续用 `openai` SDK（双栈并存，最省事，但安全过滤要覆盖两条出站路径）；
2. 改成「单工具 forced call」拿结构化输出（在 DeepSeek 上的可靠性需实测）；
3. 保持 JSON 模式但走 pi 的 custom provider 直调 API 实现层。

这是**必须先定的架构决策**，不是实现细节。

### L8 委托型 provider —— 不受影响

`claudeCodeAgent`/`codexAgent` 是 spawn 外部 CLI 走 MCP，与 pi 无关；pi 无内置 MCP client 也不影响 pith 的 `bin/pith-mcp.ts`（pith 是 **MCP server 端**）。

### L9 配置体系冲突

pith：`config.json` + `secrets` map 单一来源（`.env` 已被移除，这是刻意决策）。
pi：`~/.pi/agent/{settings,models,auth}.json` + 环境变量 + `trust.json`。

用 `pi-coding-agent` 会引入**第二套配置真源**；用 `pi-agent-core`（更薄）则可以完全由 pith 的 config 驱动。这是**倾向选 agent-core 而不是 coding-agent** 的主要理由（次要理由：coding-agent 14 MB + 自带 read/bash/edit/write 工具与 pith 的沙箱工具重复）。

### L10 测试

45 个测试文件里直接相关的约 12 个：`agent-loop-limit`、`agent-scope`、`agent-snapshot`、`split-thinking`、`history`、`security`、`security-integration`、`hydration-behavior`、`hydration-prompt`、`wiki-tools`、`run-command`、`http-request`、`schedule`。其中 `agent-loop-limit` / `split-thinking` 大概率**退役**（对应机制被 pi 取代），其余需重写 mock 层（从 mock `chat.completions.create` 改成 mock `streamFn`）。

工作量：**3–4 天**。

---

## 4. 成本汇总

| 方案 | 范围 | 估算 | 风险 |
| --- | --- | --- | --- |
| **A. 全量替换**（`pi-agent-core` 取代 `src/llm/agent.ts` + `pi-ai` 取代 `openai`） | L1–L7、L9、L10 | **15–22 人日**，含桌面端；若同时换 pi SessionManager 再 +5–8 | 高：安全过滤要在流式下重建；hydration 无 JSON 模式；0.x 上游 + 封闭治理 |
| **B. 只换 LLM 传输层**（`pi-ai` 替 `openai` SDK，自留现有 agent loop） | L1、L1'、L7、部分 L10 | **4–6 人日** | 中：安全 wrap 挂点从 monkey-patch 改 `streamFn` 包装；可保留 `stream:false` 规避流式还原问题 |
| **C. pi 作为第 4 个 delegate provider**（spawn `pi --mode json/rpc`，实现 `AgentLike`） | 新增 1 个文件 + config provider 枚举 + 桌面设置项 | **1.5–2 人日** | 低：与 `a2df33c` 接 codex 的路径逐字一致；零侵入现有 harness |

依赖体量注意：`pi-ai` 会拉进 Anthropic + Google GenAI + Mistral + **AWS Bedrock** SDK。Electron 打包体积和 utilityProcess 启动时间会上升，需实测（`desktop/src/engine/index.ts` 的 polyfill→动态 import 分界不能破）。

---

## 5. 能力增强清单（换 pi 到底能拿到什么）

按对 pith 的实际价值排序：

1. **OAuth 订阅登录**（Claude Pro/Max、GitHub Copilot、xAI、OpenRouter）。pith 现在只能用 API key 计费；接 pi 后用户可以直接用订阅额度。这比「多一个模型」价值大得多，也是 delegate 路线（方案 C）就能拿到的收益。
2. **自动 compaction + 分支摘要**。直接替掉 `maxSteps=12` + `LOW_BUDGET_RESERVE` 这套土办法，长会话不再被硬截断——对「定时日报生成了却没落盘」这类失败模式是根治。
3. **真流式输出**。现在 `stream: false`，用户盯着 spinner 等整轮；pi 是流式优先 + `text_delta`/`thinking_delta` 事件。
4. **steering / follow-up 队列**。工具跑到一半插话、跑完追加任务——REPL 与桌面端体验的质变。
5. **多 provider 归一 + 中途换模型**（保留 thinking 块/tool 调用上下文的跨 provider handoff）。pith 现在 `/provider` 切换要重置会话历史。
6. **thinking 归一**：`thinkingLevel: off…max`，替掉手写 `splitThinking` + `reasoning_content`/`thinking` 字段的 best-effort 回传。
7. **token / 成本核算 + 自动重试**（`auto_retry_*` 事件）。
8. **树形会话**：fork / clone / branch / label / `navigateTree`，比 pith 的线性 JSONL 强一档。
9. **并行工具执行**（现在是 `p-queue(1)` 全串行）。
10. **可观测挂点**：`before_provider_request` / `after_provider_response` / provider payload 调试——正好是安全过滤的新挂点。
11. **扩展生态**：extensions（TS 模块，50+ 官方示例）、`.agents/skills` 目录约定（**pith 的 skill 体系可映射过去，甚至共享同一批 skill**）、prompt templates、themes、包分发。
12. **图片输入 / 图片生成**；**RPC / JSON 事件流模式**（跨语言集成，也是方案 C 的接口）。

反向清单（pi 没有、pith 现在有的）：沙箱、写路径/命令审批、安全 block/mask、MCP server、JSON 模式、subagent。**这些是 pith 的差异化，换 harness 时一个都不能丢。**

---

## 6. 建议路径与验证 spike

### 推荐：C → B →（A 观望）

**第一步（现在就能做，1.5–2 天）**：把 pi 接成第 4 个委托型 provider。`pi --mode rpc` / `--mode json` 有稳定的 JSON 协议（`docs/rpc.md` 1576 行），`AgentLike` 接口已就位，`codexAgent.ts`（401 行）是现成模板。收益：立刻拿到 pi 的模型面 + 订阅额度 + 它自己的 compaction，**而 pith 的安全/沙箱/wiki 工具经 `mcp__pith__*` 继续生效**（与 claude-code 路线同构）。

**第二步（看第一步的实际手感，4–6 天）**：若确认 pi 的模型层收益大，用 `pi-ai` 替掉 `openai` SDK，保留 pith 自己的 agent loop 与安全 wrap（继续 `stream:false` 以规避跨 chunk 还原）。

**第三步（不建议现在做）**：`pi-agent-core` 全量替换。先看上游三件事：0.x → 1.0 的稳定性、Earendil 商业化后开源包的维护承诺、以及是否补上结构化输出。

### 必须先验掉的 6 个未知（每项 ≤半天）

1. **DeepSeek / GLM 在 pi 的 custom provider 下跑通 tool calling + thinking**（`api: 'openai-completions'` + `thinkingFormat: 'deepseek' | 'zai'`，`docs/custom-provider.md:747`）。
2. **zod → JSON Schema 直喂 `AgentTool.parameters` 是否被 TypeBox 校验接受**（决定 L3 是 1 天还是 4 天）。
3. **安全过滤在流式下的还原**：用 `before_provider_request` / `after_provider_response` 重建 mask/block，验证 `tool_calls.arguments` 与跨 chunk 占位符还原。
4. **hydration 的结构化输出替代**：DeepSeek 上 forced tool call 的 JSON 可靠性 vs 保留 `openai` SDK 双栈。
5. **Electron 打包影响**：在 utilityProcess 里 import `pi-agent-core`（ESM + 现有 polyfill 顺序约束），量化体积与冷启动增量。
6. **会话数据兼容**：写 `ChatCompletionMessageParam → AgentMessage` 转换器，验证 `deriveDisplay` 能否复用、存量 JSONL 能否读。

---

## 6.5 实施进度（本分支，C → B → A 已按序执行）

| 步骤 | 状态 | 产物 |
| --- | --- | --- |
| **C** pi 作为第 4 个委托型 provider | **已实现 + 本机端到端实测** | `docs/PRD-pi-integration.md` §0–§6；`desktop/src/engine/{piAgent,piBridgeSource}.ts` |
| **B** pi-ai 作为可选传输层 | **已实现 + faux/真机双验** | `docs/PRD-pi-integration.md` §7；`src/llm/{transport,piAiTransport,piMessageMap}.ts` |
| **A** pi-agent-core 换 agent loop | **tracer bullet 已跑通，未切默认** | `docs/PRD-pi-core-agent.md`；`desktop/src/engine/piCoreAgent.ts`、`src/security/streamRestore.ts` |

六个 spike 的结论（全部实测，不是推演）：

1. **DeepSeek/GLM 自定义 provider** — 走 openai-completions 自定义 provider 跑通（B 的真机验证）。
2. **zod→JSON Schema 直喂 pi** — ✅ 可行。TypeBox 接受普通 JSON Schema，工具层**不需要**全量重写
   → L3 估算 3–4 人日降到约 1 人日。
3. **流式下的 mask 还原** — ✅ 已实现（`createStreamRestorer`，hold-back 状态机 + 8 例测试，
   含穷举切点等价性）。原报告点名的「最容易低估的一块」变成 130 行的完成件。
4. **hydration 结构化输出替代** — ❌ 不行。抓真实 payload：pi-ai 从不发 `response_format`；
   给工具加 constrainedSampling 后 body 里确实带 `"strict": true`，但**不强制 `tool_choice`**，
   模型可以不调 → 水合双栈（openai SDK）保留。
5. **Electron 打包 / 启动** — +70 MB node_modules（pi-ai 18M + agent-core 1.7M + 厂商 SDK ≈52M）；
   `import pi-ai` 130 ms、加 agent-core 160 ms；electron-vite 把 pi 包 external 化，engine bundle
   只多 8 KB chunk。**顺手修掉一处回归**：client.ts 原先静态 import 让默认（openai）用户也付
   这 160 ms，已改惰性 import。
6. **会话历史兼容** — ✅ `fromPiMessages` 让 A 的历史仍是 OpenAI 形状，既有 JSONL 持久化 /
   `deriveDisplay` UI 回放 / transcript **一行不改**。

实测新发现（都已在实现里规避）：pi CLI 的 print/json 模式读管道 stdin（不关 stdin 会挂死）；
不能用 `node:readline` 切 pi 的 JSONL（它在 U+2028/U+2029 也断行，知识库正文常有）；
pi-ai 会往 body 塞 `store`/`prompt_cache_key`/`prompt_cache_retention`（后两个 compat 关不掉，
挑剔端点会 400）→ 自定义端点路径用 `onPayload` 剥掉。

**A 的剩余成本修订**：15–22 人日 → **8–12 人日**，缺口清单见 `docs/PRD-pi-core-agent.md` §4。
建议仍是先不切默认，gate 见该文档 §5。

## 7. 参考

- [earendil-works/pi（仓库）](https://github.com/earendil-works/pi)
- [@earendil-works/pi-ai（npm）](https://www.npmjs.com/package/@earendil-works/pi-ai) ／ [@mariozechner/pi-ai（已 deprecated）](https://www.npmjs.com/package/@mariozechner/pi-ai)
- [@earendil-works/pi-coding-agent（npm，含 docs/ 与 examples/）](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- [Pi Agent Harness 综述](https://explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026) ／ [pi-mono 项目介绍](https://dev.to/wonderlab/one-open-source-project-a-day-no-53-pi-mono-minimalist-high-performance-ai-coding-agent-4d73)
- 本地已解包的 pi 0.82.1 文档（含 `sdk.md` / `extensions.md` / `custom-provider.md` / `compaction.md` / `rpc.md`）：`npm pack @earendil-works/pi-coding-agent@0.82.1` 后 `package/docs/`
- pith 侧相关文档：`CLAUDE.md`（harness 现状）、`docs/adr/0006-desktop-engine-process.md`、`docs/PRD-codex-integration.md`（委托型 provider 的现成范式）
