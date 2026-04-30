# llm-wiki

一个仿 Claude Code 风格的命令行工具，用于搭建 **Karpathy 风格** 的 LLM 知识库。
默认模型：**DeepSeek**（`deepseek-chat`）。默认存储：一个装 Markdown 文件的文件夹。

> 设计哲学：**数据工程 > 检索算法。** 不要把原始文档塞进库里、再指望 embedding
> 把它捞回来。用 LLM 把原文 _脱水（hydrate）_ 成高密度的 Markdown 词条，
> 检索时靠关键词 + 链接遍历，简单直接，肉眼可读。

## 安装

```bash
npm install            # 或 pnpm i / yarn
mkdir -p ~/.llm-wiki && cp .env.example ~/.llm-wiki/.env && chmod 600 ~/.llm-wiki/.env
# 编辑 ~/.llm-wiki/.env，填入 DEEPSEEK_API_KEY
npm run build
```

`.env` 默认从 `~/.llm-wiki/.env` 读取（跨 workspace 共用一份密钥）。
若 workspace 根目录里也存在 `.env`，会被先加载作为 fallback，但
home 里的同名变量优先级更高（`override: true`）。

## 使用

交互式 REPL（基于 Ink 的富终端 UI）：

```bash
npm run dev            # 等价于 tsx bin/llm-wiki.ts
# 构建后也可以直接：
llm-wiki
```

进 REPL 后**一个进程同时干三件事**：

1. 你跟 LLM 聊天（agent 调工具）；
2. 持久化队列 worker 在后台拾取 `pending` job 自动入库；
3. 每个回合自动把对话和工具调用细节写到 `output/<sessionTs>.md`。

底部一行实时显示队列状态：

```
queue: worker · 3 pending · 1 running · 12 done
```

REPL 内的斜杠命令：

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 仅清屏（agent 状态保留） |
| `/reset` | 清空 agent 对话上下文（下次 `/digest` 只能拿到 reset 之后的内容） |
| `/transcript` | 显示本 session 的 markdown transcript 路径 |
| `/digest [collection]` | 把当前对话（自上次 `/reset` 起）整理成一条 wiki entry，落到 `<wikiRoot>/<collection>/`。collection 不传则用 `digestCollection`（默认 `output`） |
| `/exit` | 退出 REPL |

按一次 `Ctrl+C` 取消正在飞的 LLM 请求；连按两次退出。

REPL 启动 flag：

| Flag | 作用 |
|---|---|
| `--no-auto-queue` | 不在本 session 里起后台 worker（仅展示状态，不抢锁） |
| `--no-transcript` | 不写本次 session 的 markdown transcript |

子命令（脚本化或人工操作均可）：

### 同步 ingest

```bash
# 单文件脱水入库
llm-wiki ingest --collection tech --file ./paper.md
# 或从 stdin：cat paper.md | llm-wiki ingest --collection tech

# 批量入库：glob 模式（fast-glob 语法）
llm-wiki ingest --collection tech --batch 'papers/**/*.md'

# 批量入库：递归整个目录的 .md 文件
llm-wiki ingest --collection tech --dir ./papers/
# 默认并发 3、自动 429 退避、源路径已入库会跳过；--force 强制重脱水覆盖
llm-wiki ingest --collection tech --dir ./papers/ --force --concurrency 5
```

### 持久化队列（异步，可中断、可查进度、异常重试）

```bash
# 入队（不立即处理；deriveJobId 基于路径+collection，重复 add 自动去重）
llm-wiki queue add --collection reading --file ./paper.md
llm-wiki queue add --collection reading --batch 'inbox/**/*.md'
llm-wiki queue add --collection reading --dir ~/notes/inbox      # 配 --read-path
llm-wiki queue add --collection reading --dir ~/notes/inbox --force  # 重新入库

# 起前台 worker（占锁；Ctrl+C 安全退出，下次自动续跑）
llm-wiki queue run
llm-wiki queue run --concurrency 4   # 临时覆盖 queueConcurrency 配置

# 任意时刻查进度（无锁；与 worker 并存）
llm-wiki queue status                # 人类可读：counts + running + 最近 10 条事件
llm-wiki queue status --json | jq '.counts'

# 失败 job 处理：每个异常都重试 maxAttempts 次（默认 3，含 5s/30s/2min 退避），
# 用尽后归档为 dead，等手动复位
llm-wiki queue retry <jobId> ...     # 复位指定 jobId
llm-wiki queue retry --all-dead      # 复位所有 dead

# 清理（不删 log 文件）
llm-wiki queue clear                 # 默认清 completed
llm-wiki queue clear --dead
llm-wiki queue clear --all           # 含 pending！谨慎
```

REPL 里也有同名工具：`wiki_queue_add`、`wiki_queue_status`，用自然语言指挥 LLM
调用即可：

```
> 把 ~/notes/inbox/ 里的所有 .md 加到 reading collection 的队列
> 队列还剩多少？哪些挂了？
```

worker 的并存模型见下文 [多终端协作](#多终端协作)。

### 目录监听 watcher（自动入队）

不想每次手动 `queue add`？配 `watchDirs` 让 chokidar 监听一棵笔记目录，
add/change 自动入队，worker 自动消化。在 `~/.llm-wiki/config.json` 里：

```jsonc
{
  "watchDirs": [
    {
      "path": "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/荔枝知识库/荔枝知识库",
      "collectionFromSubdir": true,
      "fallbackCollection": "lizhi",
      "initialScan": true
    }
  ]
}
```

启动 `llm-wiki`，REPL 底部会显示 `watch N`；从此往 vault 加 `工作/笔记.md`
就自动落进 `<wikiRoot>/工作/<id>.md`。

要点：

- **collection 解析**：`collectionFromSubdir: true` 时一级子目录名 = collection，
  中文/英文目录名直接用（`工作/`、`tech/` 都行），深层子目录始终归到一级；
  直接挂在 watch root 下的孤儿文件 → `fallbackCollection`。
- **改名**：想把中文目录映射成英文 collection（URL 友好）就用 `subdirAlias`：
  ```jsonc
  { "subdirAlias": { "工作": "work", "读书": "reading" } }
  ```
- **沙箱**：watch 路径必须落在 `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`
  之内，且**不能与 wikiRoot 重叠**（否则 wiki 写入会触发 watcher 自我循环；启动
  期 fail-fast）。如果 vault 在 home 之外，把它加进 `LLM_WIKI_READ_PATHS`。
- **自动 ignored**：`.obsidian/`、`.git/`、`.DS_Store`、`.icloud`、任意层级的
  `wiki/` / `outputs/` / `node_modules/`。Obsidian vault 的 plugin 数据不会污染队列。
- **change 事件**：检测到已 ingest 文件变动 → 自动 reset 队列里的对应 job 为
  `force=true`，worker 重跑覆盖原 entry（同 id，无 `-2` 后缀）。
- **`--no-auto-watch`** 临时关掉，或写到 `~/.llm-wiki/config.json` 里 `"watchAutoStart": false`。

CLI 独立运行：

```bash
# 临时配一条 watcher（不进 config）
llm-wiki watch --dir ~/notes/inbox --collection reading --initial-scan

# 用 collectionFromSubdir
llm-wiki watch --dir ~/.../vault --collection-from-subdir --fallback-collection misc

# 读 config.watchDirs（前台运行；Ctrl-C 关闭）
llm-wiki watch
```

watcher 自身**不取队列锁**——可以和 REPL（自动起的 worker）/ `queue run` 并行；
它只 `enqueue`，不跑 hydrate。

### 检索（不需要 API key）

```bash
# 查看一个词条
llm-wiki get llm-agent-design

# 装配上下文（无 LLM 调用，纯本地检索）
llm-wiki query "agent 的重试逻辑应该怎么设计"

# 列出全部 / 某个 collection 的词条
llm-wiki list --collection tech
```

### 全局开关

`--read-only`（禁用一切写入）、`--model <name>`、`--root <dir>`、`--read-path <dir>`（可重复）。

## 多终端协作

队列状态 (`~/.llm-wiki/queue/state.json`) 是**单一真相**；worker 通过
`state.json.lock` 文件保证**同一时刻只有一个进程在消费**。可以这么协作：

```bash
# 终端 A：REPL（自动起 worker，持锁）
llm-wiki

# 终端 B：随时往队列里塞，不抢 worker
llm-wiki queue add --collection ... --dir ...
llm-wiki queue status        # 任何时候看进度都行

# 终端 C：千万别再起 worker
llm-wiki queue run           # ❌ 会报 "queue is already running (pid=...)"
```

如果想把 worker 留在另一个独立终端：

```bash
# 终端 A：REPL，关掉自动 worker（QueueIndicator 仍展示状态）
llm-wiki chat --no-auto-queue

# 终端 B：worker 在这边
llm-wiki queue run
```

**崩溃恢复**：worker 异常退出（kill -9 / 断电）时，`state.json` 上残留的
`running` job 会在下次 `queue run` 启动时被自动重置为 `pending`，attempts 不变；
锁文件中的 pid 已不存在时也会被自动接管。

## 自动 transcript + 对话回灌 wiki

### 原始 transcript

REPL 默认把每次 session 写到 `<wikiRoot>/output/transcripts/<sessionTs>.md`。
路径选在 `<wikiRoot>` 下是有意为之——和数字化的 wiki 条目共享同一棵树根，
但用 `transcripts/` 子目录屏蔽 `LibraryService` 的 collection 扫描（它只读
`<wikiRoot>/<collection>/*.md` 一层，子目录被忽略）。

内容是规整的 markdown，按时间顺序：

```md
# Chat Session 2026-04-30T08:15:32.100Z

- model: `deepseek-chat`
- workspaceRoot: `/Users/.../llm-wiki`
- wikiRoot: `/Users/.../llm-wiki/wiki-data`

---

## 🧑 User · 2026-04-30T08:15:42.500Z

把 inbox 里的 md 加到 reading 队列

### → tool: wiki_queue_add · 2026-04-30T08:15:43.500Z
```json
{ "collection": "reading", "files": ["..."] }
```

### ✓ tool result: wiki_queue_add
```
{"ok": true, "added": 12}
```

## 🤖 Assistant · 2026-04-30T08:15:45.800Z

已经把 12 个文件加到 reading 队列了…

---
```

每次回合的**所有工具调用与结果**都会保留，方便复盘 LLM 的决策路径。
用 `appendFileSync` 同步落盘——REPL 异常退出也不会丢内容。
关掉：CLI 加 `--no-transcript`，或在 `~/.llm-wiki/config.json` 里
`"transcriptEnabled": false`。

### `/digest` —— 把对话整理成 wiki 条目

raw transcript 是逐字对话记录，没有压缩、没有结构化。`/digest` 在 REPL 里把
**自上次 `/reset` 起的全部对话**喂给 `HydrationService`（用专门的
`CONVERSATION_SYSTEM_PROMPT`，不是文档脱水那套），产出一条规整的高密度
wiki entry，落到 `<wikiRoot>/<digestCollection>/`（默认 collection 名 `output`）。
从此这条对话的精华就成了可被 `query` / `wiki_query` 检索的正式条目，下次
聊天 LLM 都能用 `wiki_query` 把它捞回来——一个 *write-around-read* 的反馈环。

**Conversation 模式 vs 文档模式**：[hydration.ts](src/wiki/hydration.ts) 暴露两套
prompt。文档模式（`ingest` / `wiki_ingest` / 队列 worker）把输入当源材料压缩，
丢第一人称、丢转场词。**对话模式（`/digest` 专用）强制保留用户提问的视角**，
title / summary 必须反映用户问的角度而不是仅总结答案：

> 反例：用户问"成长**和低谷期**"，digest 不能笼统压成"成长经历"——
> 必须保留"低谷期"这个用户主动选择的对比维度。

`content` 用 `## Q: ...` 段按对话顺序排列，多个独立话题不被合并；tags 同时覆盖
"用户问的角度"和"答案的领域"。

```
> /digest                       # 默认落到 output collection
digesting current conversation into collection "output"…
digest saved: agent-retry-policy (collection=output)
  title: Agent 重试逻辑设计
  tags: agent, retry, reliability
  links: error-handling
  path: /Users/.../wiki-data/output/agent-retry-policy.md

> /digest research-notes        # 落到指定 collection
> llm-wiki get agent-retry-policy   # 验证保存的内容
```

注意：

- 只压缩 user / assistant 文本和 `tool_calls`（名字 + 参数），原始 tool 返回的
  长 byte-blob 不进 digest，免得稀释。
- digest 不会 reset agent，摘要后还能继续聊。
- 如果对生成结果不满意，直接 `rm <wikiRoot>/<collection>/<id>.md` 即可
  （或重新 `/digest` 让 LLM 再压一遍，可能产出不同 id）。

## 架构

```
                 ┌──────────────────┐
  raw text ───▶ │ HydrationService │ ──▶ Entry（压缩后的 Markdown）
                 └──────────────────┘
                                              │
                 ┌──────────────────┐         ▼
                 │ LibraryService   │ ◀── 每个词条 = 一个 .md 文件
                 └──────────────────┘     （frontmatter + 正文）
                                              │
  query ──────▶ ┌──────────────────┐         ▼
                 │ ContextAssembler │ ──▶ 拼好的 Markdown 上下文
                 └──────────────────┘
```

三个核心服务对应到代码：

- **HydrationService**（[src/wiki/hydration.ts](src/wiki/hydration.ts)）—— 用 LLM 的 JSON
  模式把杂乱原文压缩成结构化 `Entry`。提示词强制：Markdown 列表、剔除修饰、
  概念用 `[[concept-id]]` 标注。
- **LibraryService**（[src/wiki/library.ts](src/wiki/library.ts)）—— 文件系统 CRUD；
  正向链接持久化在 frontmatter，**反向链接不落盘**，通过懒加载的内存索引按需计算，
  写入时整体失效。这样避免了双写一致性问题。
- **ContextAssembler**（[src/wiki/assembler.ts](src/wiki/assembler.ts)）—— 不依赖 embedding：
  tokenize → 加权评分（title × 2、tags × 2、summary × 1、content × 0.5）→ 取 top 5
  种子 → 沿正向链接 BFS 1 层 → 按 token 预算拼接 Markdown。

REPL 把上述服务通过 OpenAI 风格的 function calling 暴露给模型，共 8 个工具：

- 通用：`read_file`、`write_file`（沙箱 + 审批）、`list_dir`；
- Wiki 读写：`wiki_ingest`（同步脱水入库）、`wiki_get`、`wiki_query`；
- 持久化队列：`wiki_queue_add`（仅入队，由 worker 异步消费）、`wiki_queue_status`。

所有写操作沙箱在 workspace 根目录之内，新路径会触发审批（`y` / `a` / `n`）。

子命令与 LLM 工具调用共用同一份 `src/wiki/*` 实现，**只有一条代码路径**。
持久化队列模块在 [src/wiki/queue/](src/wiki/queue/)：

- `processJob.ts` —— 单文件处理（去重 / hydrate+429 退避 / id 冲突 / 落盘），
  被 batch 一次性模式与队列 worker 共用；
- `state.ts` —— schema、`deriveJobId`、原子 IO（`.tmp + rename`）、事件环形缓冲；
- `store.ts` —— `QueueStore`：load / mutate / 进程锁（pid 探活、陈旧锁接管）；
- `runner.ts` —— p-queue 主循环、退避状态机、`idleBehavior=exit|wait`、
  AbortSignal 排干、collection 级 snapshot 刷新；
- `jobLogger.ts` —— 每 job 一份 append-only log（`<queueLogDir>/<jobId>.log`）。

## 词条文件格式

每个词条是一个带 YAML frontmatter 的 `.md` 文件，路径为 `<wikiRoot>/<collection>/<id>.md`：

```markdown
---
id: agent-retry
collection: tech
title: Agent 重试逻辑
summary: 在失败下重试 agent 工具调用的常见模式。
tags:
  - agent
  - retry
  - reliability
links:
  - error-handling
source:
  type: url
  value: https://...
updated: '2026-04-28T00:00:00.000Z'
compressionRatio: 0.12
---

# Agent 重试逻辑

- 指数退避 + jitter，最多 3-5 次。
- 区分瞬时错误（网络、429、5xx）和终态错误（4xx schema）。
- 只对幂等操作重试。
```

格式是标准 Markdown + YAML，可以直接用 Obsidian / VS Code 编辑或通过 Git 版本管理。

## 配置

优先级：命令行 flag > 环境变量 > `~/.llm-wiki/config.json` > 默认值。

| 字段 | 环境变量 | 默认 |
| --- | --- | --- |
| `apiKey` | `DEEPSEEK_API_KEY` | _必填_（仅 ingest 与 REPL 需要） |
| `baseURL` | `LLM_WIKI_BASE_URL` | `https://api.deepseek.com` |
| `model` | `LLM_WIKI_MODEL` | `deepseek-chat` |
| `wikiRoot` | `LLM_WIKI_ROOT` | `~/.llm-wiki/wiki-data` |
| `workspaceRoot` | `LLM_WIKI_WORKSPACE` | `<cwd>` |
| `readOnly` | `LLM_WIKI_READ_ONLY` | `false` |
| `additionalReadPaths` | `LLM_WIKI_READ_PATHS`（用 `:` / `;` 分隔多条） | `[]` |
| `queueStatePath` | _（无 env）_ | `~/.llm-wiki/queue/state.json` |
| `queueLogDir` | _（无 env）_ | `~/.llm-wiki/queue/logs` |
| `queueConcurrency` | _（无 env）_ | `2` |
| `queueMaxAttempts` | _（无 env）_ | `3` |
| `queueAutoStart` | _（无 env）_ | `true`（CLI `--no-auto-queue` 关） |
| `watchDirs` | _（无 env）_ | `[]`（详见 [目录监听 watcher](#目录监听-watcher自动入队)） |
| `watchAutoStart` | _（无 env）_ | `true`（CLI `--no-auto-watch` 关） |
| `outputDir` | _（无 env）_ | `<wikiRoot>/output/transcripts` |
| `transcriptEnabled` | _（无 env）_ | `true`（CLI `--no-transcript` 关） |
| `digestCollection` | _（无 env）_ | `output`（`/digest` 默认落地的 collection） |

### 额外可读目录

默认情况下，`read_file` / `list_dir` 工具只能访问当前工作目录与 `wikiRoot` 之下。
如果你希望让 LLM 也能查阅项目外的资料目录（笔记库、参考论文等），但**不让它修改**这些目录，可用：

```bash
# CLI flag（可重复）
llm-wiki --read-path ~/notes --read-path ~/research/papers

# 环境变量 / .env —— 推荐 JSON 数组写法，~ 自动展开
LLM_WIKI_READ_PATHS=["~/notes", "~/research/papers"]

# 环境变量也支持分隔符串（POSIX `:` / Windows `;`）
LLM_WIKI_READ_PATHS=/Users/me/notes:/Users/me/research/papers

# ~/.llm-wiki/config.json
{ "additionalReadPaths": ["/Users/me/notes", "/Users/me/research/papers"] }
```

**两层效果**：

1. **读扩展**：`read_file` / `list_dir` 工具能读到这些目录；`write_file` 仍只锁在 `workspaceRoot ∪ wikiRoot`。
2. **入库门槛**：`llm-wiki ingest --file <p>` 与 `--batch` / `--dir` 模式都强制要求源文件落在
   `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths` 之内。从沙箱外的路径 ingest 会立即报错并拒绝。
   这避免了"`llm-wiki ingest --file /etc/passwd`"这种意外把任意系统文件 wiki 化的可能。

所有路径都经 `realpath` 归一化，符号链接逃逸到沙箱外仍会被拒绝。

## 文件落在哪

所有 llm-wiki 的本地数据都在 `~/.llm-wiki/` 下，**不沾染任何 workspace**：

```
~/.llm-wiki/
├── .env                                 # 默认 .env 加载位置（mode 600）
├── config.json                          # 可选用户配置
├── history                              # REPL 上下键的命令历史（最近 N 条）
├── wiki-data/                           # 默认 wikiRoot —— 你的整套 wiki
│   ├── tech/                            # collection（被 LibraryService 索引）
│   │   └── agent-loop.md                # entry：YAML frontmatter + Markdown body
│   ├── reading/                         # collection
│   └── output/                          # collection（默认 digestCollection）
│       ├── agent-retry-policy.md        # /digest 产出的 wiki entry（被索引）
│       └── transcripts/                 # raw transcripts 子目录（不被索引）
│           └── 2026-04-30T08-15-32-100Z.md   # 每次 REPL session 一份
└── queue/
    ├── state.json                       # 持久化队列状态（jobs + 事件环形缓冲）
    ├── state.json.lock                  # worker 持锁时存在；含 pid/ts
    └── logs/
        └── <jobId>.log                  # 每个 job 的独立 append-only 日志
```

> **从早期版本升级**：
>
> v0.1～v0.2 把 wiki 默认放在 `<workspaceRoot>/wiki-data/`、`.env` 放在
> 项目根，两者都容易被误提交进项目仓库。当前默认全部挪到 `~/.llm-wiki/`：
>
> ```bash
> # 1. wiki 数据
> mv ./wiki-data ~/.llm-wiki/wiki-data
>
> # 2. .env 密钥（如果原来在项目根）
> mv ./.env ~/.llm-wiki/.env && chmod 600 ~/.llm-wiki/.env
>
> # 想保留 wiki 在原位置：在 ~/.llm-wiki/config.json 里写
> #   { "wikiRoot": "/Users/me/code/llm-wiki/wiki-data" }
> # 或 export LLM_WIKI_ROOT=$PWD/wiki-data
> ```
>
> 项目根的 `.env` 仍会作为 fallback 加载（首次 setup 仍可 cp .env.example .env），
> 但 `~/.llm-wiki/.env` 里的同名变量优先级更高。

## 典型 day-to-day 工作流

```bash
# 1. 早上：把昨天攒的笔记入队
llm-wiki queue add --collection reading --dir ~/Dropbox/notes/inbox

# 2. 进 REPL：一边跟 LLM 聊，一边后台 ingest
llm-wiki
> 队列还剩多少？                  # → wiki_queue_status
> 帮我看下 wiki 里关于 RLHF 的条目，对比 PPO 和 DPO   # → wiki_query
> 把这段日志加进 tech：<贴日志>   # → wiki_ingest
                                  # 同时底部 worker 数字一直在跳

# 3. 退出 REPL（worker 跟着停；在飞 hydrate 下次启动崩溃恢复路径捡回来）
> /exit

# 4. 复盘：output/ 里就是今天对话的完整 markdown，包括所有工具调用细节
ls output/
```

## 测试

```bash
npm test             # vitest 一次性跑完
npm run test:watch   # 监听模式
npm run typecheck    # 仅类型检查
```

## v0 范围与后置

**v0 已交付**：

- Ink REPL（含 Ctrl-C 单击取消 / 双击退出、命令历史、自动 transcript）；
- DeepSeek 工具调用循环（abort、错误分类、token 计量、429 退避）；
- 路径沙箱（`workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`）+ 写入审批；
- Hydration / Library / ContextAssembler 三件套；
- 子命令：`ingest`（含 `--batch` / `--dir`）、`get` / `list` / `query`；
- **持久化队列**：`queue add` / `status` / `run` / `clear` / `retry`，REPL 自动起
  worker（`idleBehavior=wait`）+ 进程锁、崩溃恢复、对任意异常重试 `maxAttempts`
  次（带退避）、每 job 独立 log；
- **REPL transcript**：每 session 一份 `output/<sessionTs>.md`，含全部工具调用细节。

**明确放到 v1+**：embedding 与向量库、BM25、HTTP REST 接口、并发 tool_calls、
`/save` `/load` 会话、写入前 diff 预览、多轮消息压缩、持久化链接索引、
`[[concept-id]]` 自动建链补全、队列后台 daemon 模式。
