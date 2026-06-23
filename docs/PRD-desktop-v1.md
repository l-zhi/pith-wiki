# PRD: pith 桌面应用 v1 —— 三栏 macOS 壳 + 只读浏览 + 完整聊天

> 状态：ready-for-agent（2026-06-12）· 本地维护，不上 GitHub issue tracker

## Problem Statement

pith 的全部能力（水合、检索、agent 对话、自动 ingest）目前只能通过终端 REPL 使用。作为日常"第二大脑"，终端形态有硬伤：无法浏览和阅读自己的知识库（Entry 只能靠 wiki_get 一条条捞）、会话不可恢复（关掉终端即丢上下文）、队列里的 dead 任务要靠子命令排查、从 Finder/Dock 启动的桌面习惯完全无法满足。用户已经在 `design/pith-design-system` 里完成了桌面端设计系统（macOS 三栏、红黑品牌、亮暗双主题），需要把它变成真实应用。

## Solution

构建 pith 桌面应用（Electron + TS + React）v1：经典 macOS 三栏布局——玻璃侧边栏（Chat / Inbox / Dashboard 导航 + Collection 列表）· 条目列表 · 内容栏（Reader / 聊天 / 队列视图切换）。知识库浏览只读；聊天承接 REPL 的全部能力（多会话并行可恢复、工具卡片、写入/执行审批、slash 命令、@-mention Scope）；Inbox 是 ingest 队列的 GUI 家；Queue Worker 内置在 Engine 进程后台消化。CLI（pith-wiki 包）继续共存，Ink REPL 在桌面端可日常使用后退役。

## User Stories

1. As a pith 用户, I want 从 Dock 启动一个 macOS 应用, so that 不需要打开终端就能使用我的第二大脑
2. As a 首次启动的用户, I want 一个最小引导（选 provider + 粘贴 API key）写入全局配置, so that 不需要手工编辑 config.json 或设置环境变量
3. As a 用户, I want 侧边栏列出我的全部 Collection（含 watch 状态点和条目计数）, so that 一眼看到知识库的结构
4. As a 用户, I want 点击 Collection 后在中栏看到条目列表（标题/摘要/标签/来源类型/更新时间）, so that 快速扫视一个集合的内容
5. As a 用户, I want 点击条目后在内容栏阅读渲染好的 Markdown, so that 不需要打开 Obsidian 或编辑器
6. As a 用户, I want 在 Reader 里看到条目的正向链接和反向链接并可点击跳转, so that 沿链接图漫游知识库
7. As a 用户, I want Reader 提供"在聊天中打开"动作并预填 @条目 Scope, so that 就当前条目向 agent 提问时检索范围明确且可编辑
8. As a 用户, I want 新建会话并与 agent 对话, so that 用自然语言查询和整理我的 wiki
9. As a 用户, I want 会话列表展示历史会话并可点开恢复继续聊, so that 关掉应用不丢失工作上下文
10. As a 用户, I want 多个会话同时跑 agent 循环, so that 一个长任务进行时还能开新会话问别的
11. As a 用户, I want 聊天流里的工具调用渲染成卡片（名称/参数/结果/成败）, so that 看清 agent 每一步做了什么
12. As a 用户, I want 写入文件和执行命令前在聊天流里弹出内联审批卡片（允许一次/本会话总是/拒绝）, so that 敏感操作始终在我的控制之下
13. As a 用户, I want 审批只在会话内记忆、重启后清空, so that 授权面不会随时间静默膨胀
14. As a 用户, I want 有未处理审批的会话在会话列表上显示角标, so that 并行会话阻塞在审批时我能立刻发现
15. As a 用户, I want 取消正在进行的 agent 轮次, so that 跑偏的长任务不浪费时间和 token
16. As a 用户, I want 输入框支持 slash 命令（/digest /skill /soul /queue /converters /reset + 动态 skill 命令）和自动补全, so that 键盘流操作和 REPL 一样高效
17. As a 用户, I want 输入框支持 @-mention picker 圈定 Collection/Entry 作为 Scope, so that 显式控制每次提问的检索边界
18. As a 用户, I want 用 /digest 把当前会话水合成 Entry, so that 有价值的对话沉淀进知识库
19. As a 用户, I want 新建会话时选择 provider/model, so that 不同任务用不同模型且互不干扰
20. As a 用户, I want Inbox 展示 ingest 队列的 pending/running/dead 任务且徽标计数 = pending + dead, so that 自动 ingest 的进展和故障一目了然
21. As a 用户, I want 在 Inbox 里重试或清除 dead 任务, so that 处理失败的水合不用回终端跑 /queue
22. As a 用户, I want Queue Worker 在桌面应用运行期间自动后台消化队列, so that 在桌面端入队的东西不需要终端帮忙就能完成
23. As a 用户, I want Dashboard 展示按 Collection 聚合的状态表（files/pending/running/done/dead/watch）, so that 整库健康状况一屏可见
24. As a 用户, I want watcher 监控的目录变化自动入队水合并反映到 Inbox/Dashboard, so that Obsidian 库的新笔记自动进入第二大脑
25. As a 用户, I want 安装/移除 skill 后新会话立即可用而进行中的会话不受影响, so that 扩展能力不会炸掉正在进行的工作
26. As a 用户, I want 安全过滤器的 mask/block 提示出现在会话流里, so that 知道哪些敏感数据被出站拦截了
27. As a 用户, I want 应用跟随系统亮暗模式并符合设计系统的红黑品牌, so that 它看起来是台原生 Mac 应用
28. As a 用户, I want 会话同时落 markdown transcript 审计日志, so that 与 CLI 一致的可追溯性保持不变
29. As a CLI 用户, I want pith-wiki 的全部子命令在拆包后行为不变, so that 现有脚本和管道零迁移成本
30. As a 开发者, I want 领域核心拆成无 UI 依赖的 @pith/core, so that CLI 和桌面端消费同一套经过测试的核心

## Implementation Decisions

依据：CONTEXT.md 词汇表、ADR-0005（monorepo 拆包，supersede ADR-0001）、ADR-0006（Engine 架构）。设计依据 `design/pith-design-system`（实现前先读其 README，按指引读 project/ 主设计文件及 imports；像素级还原视觉但不照搬原型代码结构）。

**包结构（ADR-0005）**：pnpm monorepo 三包——@pith/core（wiki/llm/tools/skills/security，无 CLI/Electron 依赖）、@pith/cli（npm 包名保留 pith-wiki）、@pith/desktop（产品名 pith，不发 npm）。第一步是纯重构：拆包后 CLI 行为不变、现有测试全绿，桌面端再压上来。

**进程架构（ADR-0006）**：领域核心跑在单一 Engine 进程（Electron utilityProcess）：共享 LibraryService/SkillRegistry/ConverterRegistry 各一份，每 Session 一个 Agent 实例（独立历史/工具队列/AbortController），Queue Worker 内置。main 只做窗口管理与消息转发；renderer 纯 UI（React + Vite + Tailwind，不引重组件库）。

**模块切分**（三个深模块 + 薄壳）：
- SessionStore（深）：会话 JSONL 持久化——append/load/list/delete，完整消息历史（含工具调用与结果）+ 会话元数据。纯文件系统，无 Electron 依赖。会话文件存原始值（安全过滤器的脱敏只发生在出站链路，恢复重放时由 Sanitizer 重新确定性掩码）。
- SessionManager（深）：会话生命周期——创建/恢复（重建 Agent 历史）/并行执行/审批与取消按 correlation id 路由/会话级审批记忆。Agent 以接口注入，可用 fake 驱动。
- EngineBridge（深）：三进程共享的类型化消息协议——sessionId 标记的事件流（thinking/assistantText/toolRound/usage/securityNotice）+ correlation id 请求-响应（审批、abort、库读取、队列操作）。纯数据结构与分发逻辑，不碰 Electron API。
- Engine 入口（薄）：utilityProcess bootstrap，装配共享服务 + SessionManager + Queue Worker + IPC handler。
- Main 壳（薄）：窗口、spawn Engine、转发、首启检测。
- Renderer 三栏应用：Sidebar（Chat/Inbox/Dashboard + Collections）、EntryList + Reader（只读）、Chat、Inbox、Dashboard、首启引导。

**关键语义**：
- v1 不做逐 token 流式：沿用现有整段 AgentEvents 粒度，安全层零改动；进展感由 thinking 状态 + 工具卡片逐步出现承担。
- 工作区：全局单 Workspace（桌面端是"那个 wiki 的应用"），不做项目切换。
- 审批：聊天流内联卡片，y/a/n 语义照搬，会话级记忆，重启/恢复后清空。
- Inbox = 队列任务视图（不是 Entry 待审阅箱）；复用现有队列状态与 dead 重试/清除语义。
- Reader→Chat 桥：显式"在聊天中打开"动作预填 @scope；Scope 永远显式，绝不静默跟随 UI 状态。
- Skill 安装/移除：重建 Engine 内共享 SkillRegistry，只对新会话生效；provider 选择同语义（新建会话时选定）。
- 首启引导把 key 字面写入全局配置的 providers map（与 CLI 同一事实源）；Engine 启动仍读 env 作为覆盖。
- 打包：macOS 本地构建，不签名不公证不自动更新。
- Ink REPL 退役条件：桌面端可日常使用之后；在那之前 CLI/REPL 不动。

## Testing Decisions

好测试只断言外部行为（接口的输入输出与落盘产物），不窥探实现内部。仓库测试风格先例：vitest + 临时目录 fs 往返（transcript.test.ts、queue.state.test.ts）、以 fake/snapshot 驱动 agent 行为（agent-snapshot.test.ts、agent-loop-limit.test.ts）。

- SessionStore：写入/加载/列表/删除的 fs 往返；恢复后消息历史与写入时逐字节等价；损坏文件的容错。
- SessionManager：fake Agent 驱动——创建/恢复重建历史/两会话并行互不阻塞/审批请求路由到正确会话并按 correlation id 回执/abort 只杀目标会话/会话级审批记忆在恢复后清空。
- EngineBridge：协议编解码与分发——事件按 sessionId 投递、请求-响应配对、未知消息的拒绝路径。
- @pith/core 抽取的验收闸门：现有全部测试（707 个）在拆包后不改动地全绿（ADR-0005 后果条款）。
- Renderer 组件不在 v1 测试范围。

## Out of Scope

- Entry 编辑、拖拽整理、图谱视图（浏览只读是 v1 边界；编辑需先解决与 watcher/queue 的写冲突合并语义）
- "新条目待审阅"语义的 Inbox（当前 Inbox 是队列任务视图；条目审阅是未来可能的演进）
- 逐 token 流式输出（需连同安全层增量还原一起设计，v2）
- 首启引导之外的设置界面；多 Workspace / 项目切换
- 签名、公证、自动更新、Windows/Linux（ADR-0003 维持 best-effort）
- 持久化审批记忆（"设备级总是允许"）
- Ink REPL 的功能新增或继续 restyle（已冻结，仅保留已落地部分）

## Further Notes

- 术语以 CONTEXT.md 为准：产品=pith、CLI 包=pith-wiki、Engine vs Queue Worker、Inbox、Scope、Session、Hydration。
- 设计系统 README 写"8 sandboxed tools"已过时（现为 11 个工具），实现工具相关 UI 时以代码为准。
- 设计系统覆盖的是桌面端，不是终端 UI；TUI 的旧设计稿（design/pith-wiki TUI _ standalone.html）不再作为依据。
- 实施顺序受依赖约束：① 纯重构拆包 → ② Engine 协议 + 三深模块 → ③ renderer 三栏骨架 → ④ 首启/队列内置/打包 → ⑤ REPL 退役评估。
