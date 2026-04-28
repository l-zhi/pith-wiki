# API 与 CLI 设计

> 配套文档：[PRD](./PRD.md) · [架构](./architecture.md) · [Roadmap](./roadmap.md)

v0 不暴露 HTTP REST 接口；本文档同时描述：

- **CLI 子命令** —— 用户直接调用。
- **LLM 工具调用** —— REPL 中模型通过 function calling 调用。
- **SDK 函数** —— 其他 Node 程序 import 后调用。

三者共享同一份 `src/wiki/*` 实现，只有一条代码路径。

---

## 1. CLI 子命令

### 1.1 `llm-wiki`（默认 = `chat`）

进入交互式 Ink REPL。

```bash
llm-wiki              # 默认入 REPL
llm-wiki chat          # 等价
```

REPL 内可用：
- 普通对话 → 模型自由调用 6 个工具。
- Slash 命令：`/help` `/clear` `/reset` `/exit`。
- `Ctrl+C` 一次取消在飞 LLM 调用；连按两次（1.5s 内）退出。

### 1.2 `llm-wiki ingest`

把原文脱水入库。

```bash
# 单文件 / stdin（v0.1）
llm-wiki ingest --collection <name> [--file <path> | --url <url> | -]
                [--no-auto-link]

# 批量（v0.2）—— glob 或目录递归二选一
llm-wiki ingest --collection <name> --batch <glob>
                [--concurrency <n>] [--force] [--no-auto-link]
llm-wiki ingest --collection <name> --dir <folder>
                [--concurrency <n>] [--force] [--no-auto-link]
```

**参数**：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--collection <name>` | ✅ | 目标 collection（= 子目录） |
| `--file <path>` | ❌ | 从单个文件读 raw 内容 |
| `--batch <glob>` | ❌ | fast-glob 模式串，例如 `'papers/**/*.md'` |
| `--dir <folder>` | ❌ | 递归扫该目录下所有 `.md` |
| `--url <url>` | ❌ | 仅作为 source 标记，不抓网页（仅单文件模式） |
| `-`（stdin） | ❌ | 从标准输入读（仅单文件模式） |
| `--concurrency <n>` | ❌ | 批量模式并发数，默认 3 |
| `--force` | ❌ | 批量模式跳过去重，强制重新脱水覆盖 |
| `--no-auto-link` | ❌ | 关闭 auto-link 候选注入 |

`--file` / `--batch` / `--dir` 三者互斥。

**单文件输出**：

```
✓ ingested agent-retry
title: Agent 重试逻辑
summary: 在失败下重试 agent 工具调用的常见模式。
tags: agent, retry, reliability
links: error-handling
compression: 0.124
```

**批量输出**：

```
Found 12 file(s).
[1/12] /abs/papers/foo.md ✓ ingested as foo
[2/12] /abs/papers/bar.md ⊘ skipped (already ingested as bar)
[3/12] /abs/papers/baz.md ✗ failed: hydration JSON invalid
[4/12] /abs/papers/qux.md ✓ ingested as agent-design, 1 retry
...
────────────────────────────────────────
Summary: 9 ingested · 2 skipped · 1 failed
Failed:
  - /abs/papers/baz.md: hydration JSON invalid
```

退出码：≥1 个成功 → 0；全失败或 0 匹配 → 1。

**批量行为细节**：

- **去重**：`source.value` 的绝对路径已存在则跳过。`--force` 跳过该检查。兼容 v0.1 时代相对路径写入的旧条目（双向归一化比较）。
- **id 冲突**：批内多个文件被 LLM 分配同一个 id 时，第二个起自动追加 `-2`、`-3` 后缀（与 collection 中已有 id 一并避让）。
- **链接候选 snapshot**：批次开始时 `library.list(collection)` 一次，所有 hydration 共用此 snapshot 作为 `linkCandidates`，避免每文件 invalidate 反链索引。代价是同批新条目互相不可见为链接候选——v0.2 接受该 trade-off。
- **429 退避**：单文件遇 429 自动指数退避（1s/2s/4s）重试 ≤ 3 次。其他错误（schema/网络/auth）立即归 failed。
- **并发输出**：worker 完成时按完成顺序串行打印 `[N/Total]`，不交错。

**示例**：

```bash
# 从文件
llm-wiki ingest --collection tech --file ./paper.md

# 从 stdin
cat paper.md | llm-wiki ingest --collection tech

# 抓网页后入库
curl -s https://example.com/article | \
  llm-wiki ingest --collection reading --url https://example.com/article

# 批量入库整个目录
llm-wiki ingest --collection notes --dir ./obsidian-vault/

# 用 glob 精确控制（含排除）
llm-wiki ingest --collection papers --batch 'papers/2024/*.md'

# 强制重新脱水（提示词改进后想重跑）
llm-wiki ingest --collection tech --dir ./tech-notes/ --force
```

### 1.3 `llm-wiki get <id>`

打印一条词条的完整内容（frontmatter + 正文 + backlinks）。**不需要 API key。**

```bash
llm-wiki get agent-retry
llm-wiki get agent-retry --collection tech    # 显式指定 collection
```

**输出**：

```
---
id: agent-retry
collection: tech
title: Agent 重试逻辑
...
---

# Agent 重试逻辑
- 指数退避 + jitter，最多 3-5 次。
...

backlinks: error-handling, system-design
```

### 1.4 `llm-wiki list`

列出全部或某 collection 的词条。**不需要 API key。**

```bash
llm-wiki list
llm-wiki list --collection tech
```

**输出**：

```
agent-retry      [tech]      Agent 重试逻辑     #agent #retry #reliability
error-handling   [tech]      Error Handling    #reliability #errors
```

### 1.5 `llm-wiki query <text>`

不调 LLM，仅做本地检索 + 上下文装配。**不需要 API key。**

```bash
llm-wiki query "agent 的重试逻辑"
llm-wiki query "agent retry" --max-tokens 2000
```

**输出**：

```
referenced: agent-retry, error-handling

## Agent 重试逻辑 (agent-retry)
tags: agent, retry, reliability · links: error-handling
在失败下重试 agent 工具调用的常见模式。
# Agent 重试逻辑
...

---

## Error Handling (error-handling)
...
```

### 1.6 全局 flag

| Flag | 说明 |
| --- | --- |
| `--read-only` | 全局禁用 `write_file` 工具与所有写盘行为 |
| `--model <name>` | 覆盖 LLM 模型（默认 `deepseek-chat`） |
| `--root <dir>` | 覆盖 wiki 存储根目录（默认 `./wiki-data`） |
| `--read-path <dir>` | 额外可读目录，可重复传。仅扩展读权限，写仍只在 workspace ∪ wiki 内 |
| `--version` / `-V` | 版本号 |
| `--help` / `-h` | 帮助 |

**`--read-path` 示例**：

```bash
# CLI 单次扩展
llm-wiki --read-path ~/notes --read-path ~/research/papers

# 环境变量（多条用 path.delimiter 分隔——POSIX `:`、Windows `;`）
LLM_WIKI_READ_PATHS=/Users/me/notes:/Users/me/research llm-wiki

# ~/.llm-wiki/config.json
{ "additionalReadPaths": ["/Users/me/notes", "/Users/me/research"] }
```

来源优先级：CLI flag > 环境变量 > 配置文件 > 默认 `[]`。

约束：
- 仅作用于 `read_file` / `list_dir`；`write_file` 始终被锁在 workspace ∪ wiki。
- 所有路径经 `realpath` 归一化，符号链接逃逸仍被拒绝。
- `--read-only` 模式下额外目录依然可读（毕竟它们本来就不允许写）。

---

## 2. LLM 工具调用（REPL 内）

REPL 启动后，模型可以通过 OpenAI 风格的 function calling 调用以下工具。
所有工具的参数由 zod 校验后再传入 handler。

### 2.1 `read_file`

```jsonc
{
  "name": "read_file",
  "description": "读 UTF-8 文件，超大文件自动截断",
  "parameters": {
    "path": "string"   // 工作区内的路径
  }
}
```

**返回**：`{ ok: true, path, bytes, content }` 或 `{ ok: false, error }`。

### 2.2 `write_file`

```jsonc
{
  "name": "write_file",
  "parameters": {
    "path": "string",
    "content": "string"
  }
}
```

**返回**：`{ ok: true, path, bytesWritten }` 或 `{ ok: false, error }`。

**安全行为**：
1. 路径必须落在 `workspaceRoot` 或 `wikiRoot` 之内（realpath 校验）。
2. 首次写入触发 `[y/N/a]` 审批弹窗。
3. `--read-only` 模式下直接拒绝。

### 2.3 `list_dir`

```jsonc
{
  "name": "list_dir",
  "parameters": {
    "path": "string"   // 默认 "."
  }
}
```

**返回**：`{ ok: true, path, entries: [{ name, type }] }`。
自动跳过 `node_modules` / `.git` / `dist` / `.DS_Store`。

### 2.4 `wiki_ingest`

```jsonc
{
  "name": "wiki_ingest",
  "parameters": {
    "collection": "string",
    "raw_content": "string",
    "source_type": "url | file | inline | unknown",
    "source_value": "string?",
    "auto_link": "boolean"  // 默认 true
  }
}
```

**返回**：`{ ok: true, id, collection, title, summary, tags, links, compressionRatio }`。

### 2.5 `wiki_get`

```jsonc
{
  "name": "wiki_get",
  "parameters": {
    "id": "string",
    "collection": "string?"
  }
}
```

**返回**：`{ ok: true, entry, backlinks }` 或 `{ ok: false, error }`。

### 2.6 `wiki_query`

```jsonc
{
  "name": "wiki_query",
  "parameters": {
    "query": "string",
    "max_tokens": "number"   // 默认 4000
  }
}
```

**返回**：`{ ok: true, context, referenced_entries }`。

---

## 3. SDK（Node 内嵌）

直接 import `src/wiki/*` 就可以在自己的 Node 项目里复用。

### 3.1 LibraryService

```ts
import { LibraryService } from 'llm-wiki/dist/src/wiki/library.js';

const lib = new LibraryService('./wiki-data');
const entry = lib.get('agent-retry');
const allTech = lib.list('tech');
const idx = lib.linkIndex();
console.log(idx.get('error-handling')?.backward);   // ['agent-retry']
```

### 3.2 HydrationService

```ts
import OpenAI from 'openai';
import { HydrationService } from 'llm-wiki/dist/src/wiki/hydration.js';

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
const hydrator = new HydrationService(client, 'deepseek-chat', lib);
const entry = await hydrator.hydrate({
  rawContent: '...long article...',
  collectionId: 'tech',
  autoLink: true,
  source: { type: 'url', value: 'https://...' },
});
lib.put(entry);
```

### 3.3 ContextAssembler

```ts
import { ContextAssembler } from 'llm-wiki/dist/src/wiki/assembler.js';

const assembler = new ContextAssembler(lib);
const { context, referencedEntries } = assembler.query('agent retry policy', 4000);
// 把 context 喂给任意 LLM
```

---

## 4. 数据合约（Schema）

详见 [src/wiki/types.ts](../src/wiki/types.ts)，使用 zod 定义。

### 4.1 Entry

```ts
{
  id: string,                  // kebab-case
  collection: string,
  title: string,
  summary: string,
  tags: string[],
  links: string[],             // 正向链接，反向不持久化
  content: string,             // 纯 Markdown
  source: {
    type: 'url' | 'file' | 'inline' | 'unknown',
    value?: string
  },
  updated: string,             // ISO 时间
  compressionRatio?: number    // 0.0 - 1.0
}
```

### 4.2 HydrationOutput（LLM 必须返回这个 JSON）

```ts
{
  id: string,
  title: string,
  summary: string,
  tags: string[],
  links: string[],
  content: string
}
```

`source` / `updated` / `compressionRatio` 由 HydrationService 在调用后补齐。

---

## 5. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户错误（缺 API key、entry 不存在、非法参数） |

v0 不区分更细的错误码；v1 计划：2 = 配置错误，3 = LLM 错误，4 = 文件 IO 错误。

---

## 6. v1+ 计划暴露的 HTTP REST

仅作占位，**v0 未实现**：

```
POST /wiki/ingest          → 等价 wiki_ingest
GET  /wiki/entries/:id     → 等价 wiki_get
POST /wiki/query-context   → 等价 wiki_query
GET  /wiki/list?collection=...
```

详见 [roadmap.md](./roadmap.md)。
