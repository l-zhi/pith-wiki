# 架构设计

> 配套文档：[PRD](./PRD.md) · [API 设计](./api.md) · [Roadmap](./roadmap.md)

## 1. 整体分层

```
┌──────────────────────────────────────────────────────────┐
│                       入口（bin/）                          │
│  pith-wiki.ts: commander 分流 → REPL or 子命令              │
└──────────────────────────────────────────────────────────┘
                │                              │
                ▼                              ▼
   ┌────────────────────────┐    ┌────────────────────────┐
   │   src/cli/（Ink UI）   │    │ src/cli/subcommands.ts │
   │  App.tsx               │    │  ingest / get / list   │
   │  ChatView / InputBox   │    │  / query               │
   │  ToolApproval          │    └────────────────────────┘
   └────────────────────────┘                 │
                │                              │
                ▼                              │
   ┌────────────────────────┐                 │
   │     src/llm/agent.ts    │                 │
   │ 对话循环 + tool 分发      │                 │
   └────────────────────────┘                 │
                │                              │
                ▼                              │
   ┌────────────────────────┐                 │
   │      src/tools/*       │                 │
   │ read/write/list_dir    │                 │
   │ wiki_ingest/get/query  │                 │
   └────────────────────────┘                 │
                │                              │
                └──────────────┬───────────────┘
                               ▼
   ┌────────────────────────────────────────────────────┐
   │             src/wiki/（核心服务）                   │
   │  hydration.ts  ─►  调 LLM JSON 模式                │
   │  library.ts    ─►  文件 CRUD + 链接索引             │
   │  assembler.ts  ─►  tokenize + score + BFS + 预算    │
   └────────────────────────────────────────────────────┘
                               │
                               ▼
   ┌────────────────────────────────────────────────────┐
   │   wiki-data/<collection>/<id>.md                    │
   │   (frontmatter YAML + Markdown body)                │
   └────────────────────────────────────────────────────┘
```

## 2. 核心数据流

### 2.1 入库流（Ingest）

```
原文 (raw text)
   │
   ▼
HydrationService.hydrate()
   │  ├─ 注入候选 links（autoLink=true 时）
   │  ├─ DeepSeek JSON mode 调用
   │  └─ HydrationOutputSchema.parse()
   ▼
Entry 对象（含 metadata）
   │
   ▼
LibraryService.put()
   │  ├─ 原子写：.tmp → rename
   │  └─ invalidate() 链接索引
   ▼
wiki-data/<collection>/<id>.md
```

### 2.2 检索流（Query）

```
用户查询字符串
   │
   ▼
ContextAssembler.query()
   │  ├─ tokenize 查询
   │  ├─ 全量遍历 entry 评分（无外部索引）
   │  ├─ 取 top 5 种子
   │  ├─ linkIndex() → BFS depth=1
   │  └─ 按 token 预算拼接
   ▼
{ context: Markdown, referencedEntries: id[] }
```

### 2.3 REPL 工具调用循环

```
用户输入
   │
   ▼
Agent.send()
   │
   ├─► OpenAI.chat.completions.create({ tools, tool_choice: 'auto' })
   │
   ├─► response.tool_calls.length > 0?
   │      ├─ 是：串行执行 tools[].handler()，回填 messages，loop
   │      └─ 否：append assistant text，break
   │
   └─► onAssistantText / onToolCall / onToolResult / onUsage 事件
```

## 3. 关键模块

### 3.1 LibraryService（[src/wiki/library.ts](../src/wiki/library.ts)）

- **存储约定**：`<wikiRoot>/<collection>/<id>.md`，YAML frontmatter + Markdown body。
- **链接索引**：模块级 `Map<id, { forward, backward }>`，懒加载、写时失效。
- **原子写**：`fs.writeFileSync(tmp) → fs.renameSync(tmp, target)`，避免半写文件被读到。
- **macOS 兼容**：`/var` → `/private/var` 符号链接通过 `realpath` 归一化。

### 3.2 HydrationService（[src/wiki/hydration.ts](../src/wiki/hydration.ts)）

- **提示词**：内联在源文件，强制 Markdown 列表 + 剔除修饰 + `[[concept-id]]` 标注。
- **JSON 模式**：`response_format: { type: 'json_object' }`，**不**与 tools 共存。
- **AutoLink**：把已有 entry 的 `{id, title, summary}` 注入提示词作为可选链接候选。
- **不直接落盘**：返回 Entry 给调用方决定。

### 3.3 ContextAssembler（[src/wiki/assembler.ts](../src/wiki/assembler.ts)）

- **评分公式**：`2*titleHits + 2*tagHits + summaryHits + 0.5*contentHits`
- **BFS 深度 = 1**：保证种子内容必入选；扩展节点按种子分排序。
- **Token 预算**：`maxTokens × 4 chars/token × 0.7`，留 30% 余量给后续对话。
- **截断策略**：单条超预算时不收录；至少保留种子第一条。

### 3.4 Agent（[src/llm/agent.ts](../src/llm/agent.ts)）

- **循环条件**：`tool_calls.length > 0`，**不信任** `finish_reason`。
- **串行执行**：p-queue concurrency=1，简化错误传播。
- **AbortController**：注入到 OpenAI 客户端，Ctrl+C 触发 `abort()`。
- **错误分类**：auth / rate_limit / network / model_error / tool_error。

### 3.5 SafetyLayer（[src/tools/safety.ts](../src/tools/safety.ts)）

- **沙箱根**：`workspaceRoot ∪ wikiRoot`。
- **Realpath 归一化**：写文件时父目录可能不存在，沿目录树向上找已存在的根再 realpath。
- **Symlink 拒绝**：realpath 后再次校验。
- **Payload 截断**：`truncatePayload` 给读工具用，限制返回给 LLM 的字节数。

## 4. 配置层

```
flag (--read-only/--model/--root)
   ▼
env (DEEPSEEK_API_KEY, PITH_WIKI_*)
   ▼
~/.pith-wiki/config.json
   ▼
代码内 DEFAULTS
   ▼
zod.parse → Config 对象（启动失败立即 fail-fast）
```

## 5. 可扩展点

| 扩展点 | 接口 | v1+ 候选实现 |
| --- | --- | --- |
| 存储后端 | `LibraryService` 类 | SQLite / Git 远程仓库 |
| 检索算法 | `ContextAssembler` 类 | BM25 / embedding 混合 |
| LLM provider | `createClient(config)` | Anthropic / OpenAI / Ollama |
| 工具集 | `ALL_TOOLS` 数组 | shell exec / web fetch / git |
| 入口形态 | `src/cli/*` | HTTP REST / SDK 包 |

## 6. 已知限制（v0）

- 单进程读写；多进程并发可能踩到索引缓存。
- 没有锁机制：用户在 Obsidian 编辑同时 CLI 写入会产生 last-write-wins。
- 链接索引扫描是 O(n)，n > 5000 时启动会慢。
- Tokenization 是简单 `\W+` 切分，对中文不友好（中文按整段当作一个 token）。
