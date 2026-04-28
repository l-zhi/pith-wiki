# llm-wiki

一个仿 Claude Code 风格的命令行工具，用于搭建 **Karpathy 风格** 的 LLM 知识库。
默认模型：**DeepSeek**（`deepseek-chat`）。默认存储：一个装 Markdown 文件的文件夹。

> 设计哲学：**数据工程 > 检索算法。** 不要把原始文档塞进库里、再指望 embedding
> 把它捞回来。用 LLM 把原文 _脱水（hydrate）_ 成高密度的 Markdown 词条，
> 检索时靠关键词 + 链接遍历，简单直接，肉眼可读。

## 安装

```bash
npm install            # 或 pnpm i / yarn
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
npm run build
```

## 使用

交互式 REPL（基于 Ink 的富终端 UI）：

```bash
npm run dev            # 等价于 tsx bin/llm-wiki.ts
# 构建后也可以直接：
llm-wiki
```

REPL 内可用的斜杠命令：`/help`、`/clear`、`/reset`、`/exit`。
按一次 `Ctrl+C` 取消正在飞的 LLM 请求；连按两次退出。

子命令（脚本化或人工操作均可）：

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

# 查看一个词条
llm-wiki get llm-agent-design

# 装配上下文（无 LLM 调用，纯本地检索）
llm-wiki query "agent 的重试逻辑应该怎么设计"

# 列出全部 / 某个 collection 的词条
llm-wiki list --collection tech
```

全局开关：`--read-only`（禁用一切写入）、`--model <name>`、`--root <dir>`。

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

REPL 把上述三个服务通过 OpenAI 风格的 function calling 暴露给模型，工具名为
`wiki_ingest` / `wiki_get` / `wiki_query`，再加上通用的 `read_file` / `write_file` /
`list_dir`。所有写操作沙箱在 workspace 根目录之内，且每次新路径都会触发审批
（`y` 单次 / `a` 整个会话允许 / `n` 拒绝）。

子命令与 LLM 工具调用共用同一份 `src/wiki/*` 实现，**只有一条代码路径**。

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
| `wikiRoot` | `LLM_WIKI_ROOT` | `<cwd>/wiki-data` |
| `workspaceRoot` | `LLM_WIKI_WORKSPACE` | `<cwd>` |
| `readOnly` | `LLM_WIKI_READ_ONLY` | `false` |

## 测试

```bash
npm test             # vitest 一次性跑完
npm run test:watch   # 监听模式
npm run typecheck    # 仅类型检查
```

## v0 范围与后置

**v0 已交付**：Ink REPL、DeepSeek 工具调用循环（含 abort、错误分类、token 计量）、
路径沙箱 + 审批、Hydration / Library / ContextAssembler、`ingest` / `get` / `list` /
`query` 子命令、对话历史持久化（`~/.llm-wiki/history`）。

**明确放到 v1+**：embedding 与向量库、BM25、HTTP REST 接口、并发 tool_calls、
`/save` `/load` 会话、写入前 diff 预览、多轮消息压缩、持久化链接索引、
`[[concept-id]]` 自动建链补全。
