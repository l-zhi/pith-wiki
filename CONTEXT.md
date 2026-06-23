# pith

本地优先的 LLM 第二大脑：把原始文档"水合"成稠密 Markdown 条目，用加权关键词 + 链接图检索（无 embeddings），通过带沙箱工具的 agent 对话访问。单一上下文仓库——CLI 与桌面端共享同一套领域语言。

## Language

### 命名

**pith**:
产品与品牌名。桌面应用对外只叫 pith。
_Avoid_: pith-wiki（作为产品名时）、pith-brain

**pith-wiki**:
已发布的 npm CLI 包名，历史名称保留不改。仅指 CLI 发行物。
_Avoid_: 用它指代整个产品

**pith-brain**:
仓库/目录名，无产品含义。文档里不要用它指代产品或包。

**@pith/\***:
monorepo 包作用域：@pith/core（领域核心）、@pith/cli（pith-wiki 的源）、@pith/desktop（桌面应用）。

## Example dialogue

> **Dev**：用户在 Inbox 里点开一篇笔记问 AI——
> **Domain expert**：停。Inbox 里没有"笔记"，Inbox 列的是队列任务（pending/running/dead）。水合成功后产物是 Entry，住在某个 Collection 里，在条目列表/Reader 里看。
> **Dev**：好，那用户在 Reader 里读一个 Entry，想就它提问。聊天会自动知道他在读什么吗？
> **Domain expert**：不会。Scope 永远显式——"在聊天中打开"动作往输入框预填 @条目ID，用户能看见、能删。聊天绝不静默跟随 UI 状态。
> **Dev**：这个提问发生在哪？
> **Domain expert**：一个 Session 里。Session 是持久化、可恢复的，桌面端多个 Session 可以并行跑；它们都活在 Engine 进程里，共享同一份条目索引。Engine 里还跑着 Queue Worker——别把这两个混叫 "worker"。

### 核心领域

**Entry（条目）**:
水合后的稠密 Markdown 文档，wiki 的原子单位。落盘于 `<wikiRoot>/<collection>/<id>.md`，frontmatter 携带正向链接；反向链接是派生数据。
_Avoid_: note、document、笔记（指条目时）

**Collection（集合）**:
条目的一级归属目录，也是浏览与检索的分组单位。
_Avoid_: folder、分类

**Hydration（水合）**:
把原始来源压缩成 Entry 的 LLM 加工过程。产物是 Entry，不是摘要。
_Avoid_: 摘要、总结、索引（指该过程时）

**Digest**:
把当前对话水合成 Entry 的动作（`/digest`）。是 Hydration 的对话特例。

**Session（会话）**:
用户与 agent 的一段可恢复对话，桌面端的持久化与并行执行单位。一个 Session 隶属一个全局工作区。
_Avoid_: conversation、chat（指持久化对象时）

**Inbox（收件箱）**:
桌面端 ingest 队列的视图：pending / running / dead 任务的家，dead 在此重试或清除。徽标计数 = pending + dead。它展示的是队列任务，不是 Entry。
_Avoid_: 待审阅条目箱（那是另一个尚不存在的概念）

**Approval（审批）**:
对单次敏感工具动作（写路径 / 执行二进制）的用户授权。会话内记忆，跨重启不保留。

**Scope（检索范围）**:
一次提问显式圈定的集合/条目集（@-mention 产生），旁路给 agent 的检索边界。永远显式，绝不静默跟随 UI 状态。
_Avoid_: context（指该机制时）

**Workspace（工作区）**:
读写沙箱与项目级配置（SOUL / skills / security 叠加层）的根。CLI 下 = cwd；桌面端全局唯一、固定配置。
_Avoid_: project、根目录（泛称）

**Wiki Root**:
条目库的根目录（默认 `~/.pith-wiki/wiki-data`），Collection 的家。与 Workspace 是两个正交的根。

### 进程

**Engine**:
桌面端唯一的核心宿主进程（Electron utilityProcess）。托管 LibraryService、SkillRegistry、全部 Agent 实例和 Queue Worker；renderer 只通过它访问领域核心。
_Avoid_: worker（指本进程时）、core host

**Queue Worker**:
ingest 队列的消化进程/循环（`/queue` 的 self/external mode）。桌面端运行在 Engine 内部；CLI 下独立运行。
_Avoid_: ingester、后台任务（泛称）
