# 技术方案：路线 A —— 用 pi-agent-core 替换 agent loop（tracer bullet + 落地计划）

状态：**已接线到桌面端对话路径，开关默认关**（`agentImpl: 'pi-core'` 才启用；默认仍是 pith 内置 loop）
分支：`research/pi-harness-migration` · 日期：2026-07-27
上游依据：`docs/research-pi-harness-migration.md`（成本/能力分析）、`docs/PRD-pi-integration.md`（C 与 B）

## 0. 这一步做了什么、没做什么

**做了**：`desktop/src/engine/piCoreAgent.ts` —— 一个用 `@earendil-works/pi-agent-core` 的
agent loop 跑 pith 工具的 `AgentLike` 实现，加 6 例测试（用 pi-ai 的 `fauxProvider` 驱动
**真实的** pi-agent-core Agent，不是把 loop mock 掉）。同时把 A 的三个前置 spike 用真实实验
答完，并顺手修掉两个只有实测才会发现的坑。

**后续已补**（本节之后写的）：`bootstrap.ts` 的 `agentFactory` 已按 `config.agentImpl`
分流，工具/ToolContext/@-mention/安全钩子全部接上，并做了真机端到端验证（§3.5）。
**仍然没做**：没有替换内置 `src/llm/agent.ts`、没有把开关放进设置页 UI、CLI（REPL）侧不变、
桌面端仍是整轮渲染（没吃到流式）。默认值仍是 `pith`。

## 1. tracer bullet 的设计

三条约束让这个文件能脱离 Electron 与真实 provider 被测试：

| 约束 | 做法 | 为什么 |
|---|---|---|
| 依赖注入 | `models` / `model` / `tools` / `security` 全由宿主传入 | 测试用 faux provider；生产由 bootstrap 装配 |
| 对外仍是 `AgentLike` | `send/exportHistory/restoreHistory/reset/snapshot` | SessionManager 眼里与内置 Agent、三个委托 CLI agent 可互换 |
| 历史仍是 OpenAI 形状 | `fromPiMessages()` 翻回来 | 既有 JSONL 持久化、`deriveDisplay` UI 回放、transcript **一行不用改**——这是 A 能增量落地的关键 |

工具适配：pith 的工具语义是「返回任意 JSON，失败也返回 `{ok:false,error}`」，pi 的语义是
「返回 content 块、失败要 throw」。`PiCoreToolSpec` 保留 pith 语义，由 piCoreAgent 负责翻译。
参数用 JSON Schema（pith 侧 `toolsForOpenAI` 从 zod 产出）——**C 阶段已实测 pi 接受普通
JSON Schema**，所以工具层不需要全量 TypeBox 重写。

maxSteps 语义：用 `beforeToolCall` 在轮数触顶后 `{block:true, reason}` 阻断新工具调用，
把「别再调工具、基于已有信息作答」作为工具错误回给模型 —— 对齐 pith 的 `forceFinalAnswer`。

消息映射抽到核心层 `src/llm/piMessageMap.ts`（`toPiMessages` / `fromPiMessages` /
`toPiContext`），B 的传输层与 A 的 agent 共用一份，双向都有往返测试。

## 2. spike 结果（全部为本机实测，非文档推测）

### spike 3：流式下的占位符还原 —— **可行，已实现**

`src/security/streamRestore.ts` 的 `createStreamRestorer()`：hold-back 状态机，把「可能是半个
占位符」的尾巴扣住，等下个 chunk 拼上再判；`flush()` 收尾。

不变量被测试钉死（`tests/stream-restore.test.ts`，8 例）：**任意切片方式下，逐 chunk push +
flush 的结果 == 整段 restore 的结果**（穷举所有单切点 + 双切点组合 + 逐字符喂）。
另外验了：未闭合方括号正文不会被永久扣住、超长尾巴不再扣留（避免正文卡在缓冲区）、
查不到映射的占位符计入 leftover。

在 A 的链路上也验了：`piCoreAgent.test.ts` 里流式增量出现真实号码（证明还原发生在**流式过程中**，
不是等 `message_end` 才补），且中间态不含 `[PHO` 这种残片。

原报告把这条列为「最容易低估的一块」—— 现在它是已完成件，代价 ≈ 130 行 + 8 例测试。

### spike 4：hydration 的结构化输出替代 —— **不行，水合留在 openai SDK**

用 pi-ai 的 `onPayload` 抓真实 body：

- `response_format` **从不下发**（pi-ai 没有 JSON 模式）；
- 给工具加 `constrainedSampling: {type:'json_schema', strict:'prefer'}` 后，body 里的
  `tools[0].function` **确实带上了 `"strict": true`**，但 **`tool_choice` 仍为空** ——
  模型可以选择不调这个工具。水合要的是「必然产出符合 schema 的 JSON」，这条不够。

结论：B 阶段的双栈决策（水合强制 openai SDK）是对的，A 也不改这一点。

### spike 5：体积与启动成本 —— **有实数，且发现一处需要修的回归**

| 项 | 实测 |
|---|---|
| `@earendil-works/pi-ai` 安装体积 | **18 MB** |
| `@earendil-works/pi-agent-core` | **1.7 MB** |
| pi-ai 牵进的厂商 SDK | `@mistralai` 24M + `@google` 14M + `@aws-sdk` 7.2M + `@anthropic-ai` 6.4M ≈ **52 MB** |
| 合计 node_modules 增量 | **≈ 70 MB**（会进 dmg，electron-builder 不裁 production 依赖） |
| `import '@earendil-works/pi-ai'` | **130 ms** |
| `+ pi-agent-core` | +30 ms（小计 160 ms） |
| `+ providers/all`（仅 `piProvider` 路径） | +31 ms |
| electron-vite 产物 | pi 包被 **external 化**（不进 bundle），engine 只多一个 8 KB 的 `piAiTransport` chunk；动态 `import()` 在构建后仍是独立 chunk（延迟加载在生产环境生效） |

**修掉的回归**：`client.ts` 原先静态 import piAiTransport → 连带 pi-ai，于是**所有**用户
（包括默认的 `transport='openai'`）启动时都要付 ~160 ms。已改成惰性包装：首次真正发 pi-ai
请求时才 `import()`，默认路径回到零成本（`tests/pi-transport.test.ts` 有守护用例）。

### 新发现（只有实测才会碰到，已在实现里规避）

1. **pi-ai 往 body 塞 OpenAI 专有字段**：`store`、`prompt_cache_key`、`prompt_cache_retention`。
   `compat.supportsStore=false` 能去掉 `store`，但后两个对非 `api.openai.com` 也**无条件下发**
   （`cacheRetention:'none'` 关不掉）。pith 现有实现只发最小必要字段，而用户端点五花八门
   （火山 Ark / 自建 vLLM / 各家兼容层），有的对未知字段直接 400。
   → 自定义端点路径上用 `onPayload` 剥掉这三个字段（`stripNonStandardFields`，有测试）。
   实测最终 body：`messages, model, stream, stream_options`。内建 provider 路径不动。
2. **pi CLI 的 print/json 模式会读管道 stdin 并并入 prompt** → 父进程不关 stdin 会挂住（C 阶段踩到）。
3. **不能用 `node:readline` 切 pi 的 JSONL** → 它在 U+2028/U+2029 也断行，而这两个字符在 JSON
   字符串里合法、知识库正文常见（C 阶段踩到，已有专门测试）。

## 3. tracer bullet 覆盖了什么（测试清单）

`desktop/tests/piCoreAgent.test.ts`（6 例，全部走真实 pi-agent-core loop）：

1. 工具轮 → 最终答复：工具真的被执行（参数经 pi 校验后到 pith 语义的 execute）、
   `onToolRound/onThinking/onUsage/onAssistantText` 都对、导出的历史是 OpenAI 形状且
   `tool_call_id` 归位（`deriveDisplay` 能直接吃）。
2. `maxToolTurns` 触顶：第一轮放行、第二轮被阻断（真实执行只发生一次）、模型随后作答。
3. 安全层：出站 pi 只看到 `[PHONE_1]`、UI 与最终答复是原文、落盘历史也是原文。
4. 流式还原：占位符被切开也能还原，且还原发生在流式过程中。
5. `restoreHistory` 往返等价（会话恢复）。
6. `reset` 清历史保留 system prompt。

## 3.5 真机端到端（接线后）

跑法：本地假 openai 端点 + 临时 pith home（一条真实条目），用**与 bootstrap 完全相同的
函数**（`resolvePiModels` / `toToolSpecs` / `createSecurityHooks` / `PiCoreAgent`）装配。

结果：模型请求 `wiki_list` → 适配层调 pith 原 handler（真实 LibraryService，命中
`total_matched:1`）→ 第二轮据此作答；usage 两轮 120/20 与 300/15；`exportHistory()` 得到
`user → assistant → tool → assistant` 的 OpenAI 形状历史。

**这一步抓到一个只有真机才会暴露的 bug**：自定义 provider 原本用 `envApiKeyAuth`，key 靠
调用方逐请求传 —— B 的传输层这么做没问题，但 pi-agent-core 的 loop 由 pi 自己驱动
`streamSimple`，宿主没有统一注入点，于是报 `Provider is not configured`。已改成
**provider 的 auth 直接闭包 config**（config.apiKey → 回退 env），两条路统一。

## 4. 全面落地还缺什么（这才是剩余成本）

| # | 缺口 | 说明 | 估算 |
|---|---|---|---|
| 1 | ~~**审批通道**~~ | **已解决，且比预想便宜**：`write_file` 现在不弹审批（写在 output 沙箱内），唯一的审批在 `run_command` 内部经 `ctx.requestCommandApproval` 触发 —— 只要工具适配后**用的还是原 handler + 原 ctx**，审批/沙箱就自动跟过来，不需要在 pi 侧重建 | ✅ 0 |
| 2 | ~~**@-mention scope**~~ | 已实现：`PiCoreAgentOptions.buildScopePreamble` + bootstrap 提供（复刻内置 Agent 的同名私有方法） | ✅ 完成 |
| 3 | ~~**宿主装配**~~ | 已实现：`desktop/src/engine/piCoreWiring.ts` 的 `toToolSpecs`（zod→JSON Schema + 原 handler/ctx）与 `buildScopePreamble`；bootstrap 按 `config.agentImpl` 分流，pi 的 models/model 在 initServices 里一次性解析 | ✅ 完成 |
| 4 | **桌面端流式 UI** | 拿到流式才有意义：renderer 要支持增量渲染（现在是整轮到达才显示） | 2–3 人日 |
| 5 | **脱敏语义差异** | pi 内部 `AgentMessage[]` 存的是脱敏值（pith 现有实现是原地还原成原文）。`exportHistory` 已还原，但「pi 的会话对象」与「pith 落盘历史」在脱敏场景下不再逐字相同 —— 要么接受，要么在 message_end 钩子里回写 | 0.5–1 人日 |
| 6 | **预算告警** | pith 有「还剩 N 轮，赶紧把关键写入做完」的提醒；A 目前只有硬阻断 | 0.5 人日 |
| 7 | **CLI 侧** | REPL（Ink）要不要也换？换则 App.tsx 的事件消费改造 | 2 人日 |
| 8 | **compaction / 树形会话** | 属于 `pi-coding-agent` 那一层（会引入第二套配置真源与 14 MB 包），本方案未触碰 | 未估 |

**修订后的总估算**：原报告 15–22 人日 → tracer bullet 后 8–12 人日 → **接线完成后剩 4–6 人日**
（主要是 #4 流式 UI 与 #7 CLI 侧；#5 #6 各半天）。降低的部分来自：spike 全部已答、消息映射与
流式还原已实现且共用、审批发现根本不用重建、工具层确认不需要 TypeBox 重写。

## 5. 建议：先不切默认

三个 gate（与原报告一致，加一条实测得来的）：

1. **上游**：pi 仍是 0.x，2026-04 被 Earendil 收购商业化，README 明写「新贡献者 issue/PR 默认自动关闭」。
2. **结构化输出**：spike 4 确认 pi-ai 给不了「必然产出 schema JSON」，水合双栈短期内去不掉。
3. **体积**：+70 MB node_modules 进 dmg。对一个本地知识库桌面应用，这个代价要用户可感知的收益
   （流式 + 长会话不被截断）来换 —— 也就是说 A 必须连带做 #4（流式 UI），否则用户只感受到包变大。

落地顺序（#1 #2 #3 已完成，开关 `agentImpl: 'pi-core'` 已可用）：自己灰度用一段时间 →
#4 流式 UI（这是用户能感知的收益）→ #5 #6 收尾 → 再考虑是否切默认。

开关怎么用：`~/.pith-wiki/config.json` 里加 `"agentImpl": "pi-core"`，或
`PITH_WIKI_AGENT_IMPL=pi-core`。仅桌面端生效；CLI/REPL 与水合链路不受影响。
