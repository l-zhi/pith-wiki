# llm-wiki —— 产品需求文档（PRD）

| 字段 | 内容 |
| --- | --- |
| 产品名 | llm-wiki |
| 版本 | v0.1（脚手架版） |
| 文档状态 | Draft |
| 最近更新 | 2026-04-28 |
| 关联文档 | [README.md](../README.md) · [架构](./architecture.md) · [API 设计](./api.md) · [Roadmap](./roadmap.md) |

---

## 1. 背景与问题

### 1.1 问题陈述

个人知识工作者（开发者、研究员、内容创作者）面对的现状：

- 信息源极度碎片化：网页、PDF、会议纪要、Slack 对话、视频字幕、自己的草稿散落在十几个工具里。
- 主流方案（RAG + 向量库）把"垃圾"原样塞进库里，期望检索时找得准；实际上**召回噪声大、回答质量被原文质量上限锁死**。
- 工程上 RAG 链路（chunk → embedding → vector store → rerank）复杂、调参难、可解释性差，对个人项目而言重得不成比例。

### 1.2 思想原点（Karpathy 风格）

> **数据工程优于检索算法。**

- 不存原文 + embedding，而是用 LLM 把原文 **脱水（Hydrate）** 成高密度的 Markdown 词条。
- 每条 entry 都是 LLM 直接可消化的纯净内容，**写入时即处理**，而不是检索时再筛。
- 检索靠关键词 + 标签 + 链接 BFS 即可，丢掉 embedding 依赖。
- 存储格式是标准 Markdown，**人类可读、Git 可版本化、Obsidian / VS Code 可编辑**。

### 1.3 不做什么

llm-wiki **不是**：

- 一个企业级知识库 / 团队协作 wiki（v0 单用户、单机）。
- 一个搜索引擎或全文检索系统（不与 Algolia / ElasticSearch 竞争）。
- 一个文档管理系统（不做版本对比、审批流、权限）。
- 一个通用 RAG 框架（不暴露通用 chunk / embed API）。

---

## 2. 目标与非目标

### 2.1 v0 目标

| # | 目标 | 衡量标准 |
| --- | --- | --- |
| G1 | 用户可以通过自然语言对话方式操作本地知识库 | REPL 能稳定调用 6 个工具，5 分钟可上手 |
| G2 | 用户可以把任意原文一行命令脱水入库 | 入库后 entry 文件人类可读、压缩比中位数 ≤ 0.3 |
| G3 | 检索/装配过程**不依赖 embedding 或外部向量库** | 全部流程在本地完成，仅调用 LLM 用于脱水 |
| G4 | 写入操作必须安全 | 沙箱到工作目录之内 + 每次写入需审批 |
| G5 | 与 Claude Code 用户体验一致 | Ink 富 UI、Ctrl+C 取消、流式感知、token 计量 |

### 2.2 非目标（v0）

- 多用户、权限、共享。
- HTTP REST API（v0 仅 CLI + SDK）。
- 向量检索、BM25、reranker。
- Web UI、移动端。
- 自动抓取网页 / RSS（脱水的输入由用户主动提供）。
- 多模型 router、cost optimization。

---

## 3. 用户与场景

### 3.1 主要用户

**P1：技术写作者 / 研究员**
> "我每天读 5-10 篇 paper / blog，想把核心观点沉淀下来，但 Notion 里堆了 200 篇都没看第二遍。"

**P2：开发者**
> "我想给某个 LLM 项目维护一份高密度的设计笔记，方便下次开新项目时让 AI 快速理解我的偏好。"

**P3：高频对外输出者**
> "写公众号 / Twitter，需要一个'素材池'：可以用自然语言查到我以前总结过的观点和论据。"

### 3.2 核心使用场景

| # | 场景 | 触发动作 | 期望结果 |
| --- | --- | --- | --- |
| S1 | 沉淀一篇文章 | `llm-wiki ingest --collection paper --file foo.md` | 生成一条 < 400 字的 Markdown 词条 |
| S2 | 边读边问 | 在 REPL 里粘贴一段文字，"帮我入库到 reading collection" | 模型调 `wiki_ingest`，确认后落盘 |
| S3 | 检索回顾 | `llm-wiki query "agent 的容错设计"` | 输出拼好的 Markdown 上下文 + 引用 entry id |
| S4 | 写作辅助 | 在 REPL 里："基于我 wiki 里的笔记，帮我写一段关于 agent 重试的文字" | 模型先 `wiki_query`，再用上下文生成内容 |
| S5 | 手工编辑 | 用 Obsidian 打开 `wiki-data/` 改某条 | 下次 `query` 自动反映改动，无需重建索引 |

---

## 4. 功能需求（FR）

### 4.1 核心服务

#### FR-1 HydrationService（脱水服务）

| 字段 | 描述 |
| --- | --- |
| **输入** | `{ rawContent, sourceType, collectionId, autoLink }` |
| **输出** | 一个完整 `Entry` 对象（不写盘） |
| **行为** | 调 LLM（DeepSeek JSON 模式，`response_format: json_object`），系统提示要求 Markdown 列表、剔除修饰词、概念用 `[[concept-id]]` 标注。`autoLink=true` 时把已有 entry 的 `{id, title, summary}` 注入提示词作为可选链接。 |
| **校验** | 输出经 `HydrationOutputSchema` 校验，失败抛错。压缩比 = `content.length / rawContent.length`。 |
| **关键约束** | **不**与 tool calling 共存（DeepSeek 已知 bug）。 |

#### FR-2 LibraryService（库管理服务）

| 操作 | 行为 |
| --- | --- |
| `put(entry)` | 原子写：先写 `.tmp` 再 rename，避免半写。失效内存索引。 |
| `get(id, collection?)` | 优先用索引；指定 collection 时直接读文件。 |
| `delete(id, collection)` | 删除文件并失效索引。 |
| `list(collection?)` | 列出全部或单 collection 的 entry。 |
| `linkIndex()` | 返回 `Map<id, { forward, backward }>`，**懒加载**：首次访问时全量扫描 wiki-data，缓存到模块级；任何写入触发 `invalidate()`。 |

**核心决策**：反向链接**不持久化**到 frontmatter，永远从索引计算。避免双写一致性。

#### FR-3 ContextAssembler（上下文组装器）

```
query(text, maxTokens=4000) → { context, referencedEntries }
```

算法：

1. tokenize 查询 → 与每个 entry 的 `title / tags / summary / content` 的 token set 求交。
2. 评分：`2*titleHits + 2*tagHits + summaryHits + 0.5*contentHits`。
3. 取 top 5 作为种子。
4. 沿 forward links BFS 1 层展开。
5. 按 token 预算（`maxTokens × 4 chars/token × 0.7`）拼接 Markdown，超额截断。

**v0 不做**：embedding、BM25、stopword、stemming、深度 BFS、跨语言归一化。

### 4.2 CLI 入口

#### FR-4 交互式 REPL（`llm-wiki` 默认）

| 能力 | 说明 |
| --- | --- |
| Ink 富终端 UI | ChatView / InputBox / ToolApproval / TokenMeter |
| 工具调用循环 | OpenAI 风格 function calling，串行执行（p-queue concurrency=1） |
| Ctrl+C 处理 | 第一次取消在飞调用，第二次（1.5s 内）退出 |
| Slash 命令 | `/help` `/clear` `/reset` `/exit` |
| 历史持久化 | `~/.llm-wiki/history`（行级） |
| Token 计量 | 每轮显示累计 in/out tokens |
| 错误分类 | auth / rate_limit / network / model_error / tool_error，前两类自动重试 |

#### FR-5 子命令

| 命令 | 功能 | 是否需要 API key |
| --- | --- | --- |
| `ingest --collection <c> [--file <p> | --url <u> | -]` | 脱水入库 | ✅ |
| `get <id> [--collection <c>]` | 打印词条 frontmatter + 正文 | ❌ |
| `list [--collection <c>]` | 列词条 | ❌ |
| `query <text> [--max-tokens <n>]` | 装配上下文 | ❌ |
| `chat`（默认） | 进入 REPL | ✅ |

全局 flag：`--read-only`、`--model <name>`、`--root <dir>`。

### 4.3 工具层（暴露给 LLM）

| 工具 | 描述 |
| --- | --- |
| `read_file(path)` | 读 UTF-8 文件，超 100KB 截断 |
| `write_file(path, content)` | 写文件，沙箱 + 审批 |
| `list_dir(path)` | 列目录，跳过 `node_modules` / `.git` / `dist` |
| `wiki_ingest(collection, raw_content, source_type, source_value, auto_link)` | 调用 Hydration + Library |
| `wiki_get(id, collection?)` | 调用 Library |
| `wiki_query(query, max_tokens)` | 调用 ContextAssembler |

### 4.4 安全机制

| 机制 | 实现 |
| --- | --- |
| 路径沙箱 | `realpath` + `path.relative` 校验在 `workspaceRoot` 或 `wikiRoot` 之内 |
| 写入审批 | 首次写入路径弹 `[y/N/a]`，`a` 加入 session allowlist |
| `--read-only` | 全局拒绝写工具 |
| Payload 截断 | tool 返回超 100KB 截断，避免上下文炸掉 |
| Symlink 校验 | realpath 后再校验，拒绝符号链接逃逸 |

---

## 5. 非功能需求（NFR）

| 维度 | 要求 |
| --- | --- |
| **性能** | 100 条 entry 范围内，`query` 端到端 < 200ms（不含 LLM）；REPL 首屏渲染 < 500ms |
| **存储** | 单 entry 文件 < 10KB（脱水后正文 < 400 词） |
| **可移植** | 数据格式 = Markdown + YAML，可被 Obsidian / VS Code / Git 直接消费 |
| **可观测** | 每次工具调用打印 `→ tool(args)` 与 `✓/✗ tool: result preview` |
| **错误恢复** | 单条 entry 解析失败不影响其它；网络错误指数退避重试最多 2 次 |
| **配置** | `flag > env > ~/.llm-wiki/config.json > defaults`，启动时 zod 校验 |
| **依赖** | 不引入向量库 / 数据库 / HTTP 框架 |

---

## 6. 数据模型

### 6.1 Entry Schema

```yaml
id: agent-retry              # kebab-case 唯一标识，用作文件名
collection: tech             # 逻辑分组（= 子目录名）
title: Agent 重试逻辑         # 人类可读标题
summary: 在失败下重试 agent 工具调用的常见模式。   # 一句话摘要
tags: [agent, retry, reliability]    # 1-6 个标签
links: [error-handling]      # 正向链接的 entry id 列表
source:                      # 原始出处
  type: url | file | inline | unknown
  value: 'https://...' | './path' | 可省略
updated: '2026-04-28T00:00:00.000Z'   # ISO 时间
compressionRatio: 0.12       # 可选，content.length / rawContent.length
```

### 6.2 存储布局

```
wiki-data/
├── tech/
│   ├── agent-retry.md
│   └── error-handling.md
├── reading/
│   └── attention-paper.md
└── docs/
    └── llm-wiki-prd.md
```

每个 `.md` 文件都是 frontmatter + body 的标准 Markdown，**可独立移动 / 拷贝 / 编辑**。

---

## 7. 关键设计决策

| ID | 决策 | 理由 |
| --- | --- | --- |
| D-1 | 不用 embedding | 词条已经压缩，关键词 + tag + 链接已足够；省掉一整套依赖 |
| D-2 | 反向链接不落盘 | 写时计算 → 双写一致性问题；改为读时从内存索引算 |
| D-3 | Hydration 与 tool calling 不共存 | DeepSeek 已知 bug：JSON mode + tools 会丢 tool_calls |
| D-4 | tool_calls 串行 | 正确性优先，并发的工具回填顺序复杂 |
| D-5 | 流式仅用于"无 tool_calls 的最终回答" | 流式 + tool_calls deltas 拼接复杂，v0 简化 |
| D-6 | 沙箱根 = workspace ∪ wiki | 既允许在项目目录里改代码，也允许写 wiki 数据 |
| D-7 | 审批粒度 = 路径级（session 内） | 平衡安全与体验；按文件级更细但太烦 |

---

## 8. 风险与开放问题

| 风险 / 问题 | 影响 | 缓解 |
| --- | --- | --- |
| LLM 脱水质量参差 | 库里有低质 entry | 提示词要求 + zod 校验；后续支持手工编辑后保存 |
| Slug 冲突（同 collection 下 id 重名） | 后写覆盖前写 | v0 已知；v1 加 `--no-overwrite` flag |
| 大量 entry 时 `linkIndex()` 全量扫描慢 | 启动延迟 | v0 假设 < 1k entry；v1 持久化 `.index.json` |
| DeepSeek 限流 | 请求失败 | 已实现 429 指数退避（≤2 次） |
| 用户改 frontmatter 时格式错 | 词条加载失败、被静默跳过 | v0 只跳过；v1 加诊断子命令 `llm-wiki doctor` |
| 关键词检索精度差 | 回答相关性低 | v1 加 BM25 / 同义词字典 |
| 多语言查询（中英混合） | tokenize 简单切词不理想 | v0 接受，v1 接 jieba / segmenter |

---

## 9. 演进路线（Roadmap）

详见 [roadmap.md](./roadmap.md)。

**v0.1（已交付）**：核心三服务、Ink REPL、6 个工具、4 个子命令、沙箱 + 审批、16 个单元测试。

**v0.2（短期，~2 周）**：
- `llm-wiki doctor`：诊断格式错误的 entry。
- 写入前 diff 预览。
- `[[concept-id]]` 自动建链补全。
- `/save` `/load` 会话。

**v1（中期，~2 个月）**：
- HTTP REST 接口（FastAPI / Fastify 二选一）。
- 持久化 link index（`.index.json`）。
- BM25 评分模式（保留关键词模式作为默认）。
- 多模型支持（OpenAI、Anthropic、本地 Ollama）。

**v2（远期）**：
- 可选的 embedding 模式（混合检索）。
- Web UI（不取代 CLI，作为查看器）。
- 团队多用户与权限模型。

---

## 10. 验收标准

v0 视为达成 G1-G5 当且仅当：

- [x] `npm run build && npm test` 全部通过（≥ 16 测试用例）
- [x] `node dist/bin/llm-wiki.js --help` 正确打印 6 个子命令
- [x] 无 API key 时 `list` / `query` / `get` 仍可用
- [x] REPL 内 Ctrl+C 单击取消、双击退出
- [x] `write_file` 触发审批弹窗，`--read-only` 全局禁写
- [x] 路径沙箱拒绝 `/etc/passwd` 等越界写
- [x] 词条文件可被 `cat` / VS Code / Obsidian 直接打开
- [ ] *（待真实 LLM 测试）* `ingest` 脱水后压缩比中位数 ≤ 0.3
- [ ] *（待真实 LLM 测试）* REPL 自动调用 `wiki_query` 回答与 wiki 相关的问题
