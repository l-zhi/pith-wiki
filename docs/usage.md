# 使用手册

详细的 CLI 命令、REPL 用法、各子系统的开关。新用户先看 [quickstart](quickstart.md)，
回到这里查具体命令。

- [初始化 init](#初始化-init)
- [REPL](#repl)
- [同步 ingest](#同步-ingest)
- [持久化队列](#持久化队列)
- [目录监听 watcher](#目录监听-watcher)
- [检索](#检索)
- [诊断 doctor](#诊断-doctor)
- [多 provider 切换](#多-provider-切换)
- [全局开关](#全局开关)

---

## 初始化 init

一次性建好 `~/.pith-wiki/`（创建目录 + 写 `.env` 模板 + `chmod 600`）。**装完跑一遍**：

```bash
pith-wiki init                                # 默认：建目录，提示用户编辑 .env
pith-wiki init --force                        # 强制覆盖已存在 .env（自动备份到 .env.pre-init.bak）
pith-wiki init --api-key sk-xxxxxxxxxxxxxxxx  # 把 DEEPSEEK_API_KEY 直接写进去（CI / 自动化）
pith-wiki init --force --api-key sk-xxx       # 两个一起：覆盖 + 内联 key
```

行为：

- **幂等**：`.env` 已存在时默认拒绝（exit 1），保护用户已填的真 key
- **`--force`**：先把现有 `.env` 备份到 `.env.pre-init.bak` 再覆盖
- **`--api-key`**：模板里的 `DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx` 占位符被替换；
  其它 provider 的 key 仍是占位符，按需编辑

模板里默认只启用 DeepSeek（最便宜的 OpenAI-compatible 服务）；其它 provider 的
环境变量（Qwen / OpenAI / Moonshot / Zhipu / OpenRouter / Groq）都注释了，按需取消注释。

---

## REPL

交互式 REPL（基于 Ink 的富终端 UI）：

```bash
npm run dev            # 等价于 tsx bin/pith-wiki.ts
# 构建后也可以直接：
pith-wiki
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
| `/queue` | 显示当前队列状态 |
| `/dashboard` | 重新渲染启动 dashboard |
| `/provider [name]` | 列出 / 切换 provider（详见下方[多 provider](#多-provider-切换)） |
| `/exit` | 退出 REPL |

按一次 `Ctrl+C` 取消正在飞的 LLM 请求；连按两次退出。

REPL 启动 flag：

| Flag | 作用 |
|---|---|
| `--no-auto-queue` | 不在本 session 里起后台 worker（仅展示状态，不抢锁） |
| `--no-auto-watch` | 不在本 session 里起 watcher（仅展示，不监听） |
| `--no-transcript` | 不写本次 session 的 markdown transcript |

子命令（脚本化或人工操作均可）见下。

---

## 同步 ingest

```bash
# 单文件脱水入库（按扩展名自动选转换器：.md/.txt/.pdf/.docx/.html/.eml）
pith-wiki ingest --collection tech --file ./paper.md
pith-wiki ingest --collection tech --file ./paper.pdf      # 走 pdf-parse
pith-wiki ingest --collection tech --file ./report.docx    # 走 mammoth

# 或从 stdin（不进转换器，直接当 markdown 喂 hydrator）：
cat paper.md | pith-wiki ingest --collection tech

# 批量入库：glob 模式（fast-glob 语法）
pith-wiki ingest --collection tech --batch 'papers/**/*.md'

# 批量入库：递归整个目录（任何已注册扩展名都能被批量解析）
pith-wiki ingest --collection tech --dir ./papers/
# 默认并发 3、自动 429 退避、源路径已入库会跳过；--force 强制重脱水覆盖
pith-wiki ingest --collection tech --dir ./papers/ --force --concurrency 5

# 强指定转换器（绕过扩展名）；--no-cache 跳过 .cache/converters/ 调试用
pith-wiki ingest --collection tech --file ./readme.unknown --converter markdown-passthrough
pith-wiki ingest --collection tech --file ./paper.pdf --no-cache

# 列出当前 build 注册的所有转换器（包括 host 自定义）
pith-wiki converters
```

---

## 持久化队列

异步入库，可中断、可查进度、异常重试。worker 通过文件锁保证同一时刻只有一个进程消费。

```bash
# 入队（不立即处理；deriveJobId 基于路径+collection，重复 add 自动去重）
pith-wiki queue add --collection reading --file ./paper.md
pith-wiki queue add --collection reading --batch 'inbox/**/*.md'
pith-wiki queue add --collection reading --dir ~/notes/inbox      # 需配 --read-path
pith-wiki queue add --collection reading --dir ~/notes/inbox --force  # 重新入库

# 起前台 worker（占锁；Ctrl+C 安全退出，下次自动续跑）
pith-wiki queue run
pith-wiki queue run --concurrency 4   # 临时覆盖 queueConcurrency 配置

# 任意时刻查进度（无锁；与 worker 并存）
pith-wiki queue status                # 人类可读：counts + running + 最近 10 条事件
pith-wiki queue status --json | jq '.counts'

# 失败 job 处理：每个异常重试 maxAttempts 次（默认 3，含 5s/30s/2min 退避），
# 用尽后归档为 dead，等手动复位
pith-wiki queue retry <jobId> ...     # 复位指定 jobId
pith-wiki queue retry --all-dead      # 复位所有 dead

# 清理（不删 log 文件）
pith-wiki queue clear                 # 默认清 completed
pith-wiki queue clear --dead
pith-wiki queue clear --all           # 含 pending！谨慎
```

REPL 里也有同名工具：`wiki_queue_add` / `wiki_queue_status`，用自然语言指挥 LLM 调用即可：

```
> 把 ~/notes/inbox/ 里的所有 .md 加到 reading collection 的队列
> 队列还剩多少？哪些挂了？
```

多 worker 协作 + 崩溃恢复细节见 [docs/repl-workflow.md](repl-workflow.md#多终端协作)。

---

## 目录监听 watcher

不想每次手动 `queue add`？配 `watchDirs` 让 chokidar 监听一棵笔记目录，
add/change 自动入队，worker 自动消化。在 `~/.pith-wiki/config.json` 里：

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

启动 `pith-wiki`，REPL 底部会显示 `watch N`；从此往 vault 加 `工作/笔记.md`
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
  期 fail-fast）。如果 vault 在 home 之外，把它加进 `PITH_WIKI_READ_PATHS`。
- **自动 ignored**：`.obsidian/`、`.git/`、`.DS_Store`、`.icloud`、任意层级的
  `wiki/` / `outputs/` / `node_modules/`。Obsidian vault 的 plugin 数据不会污染队列。
- **change 事件**：检测到已 ingest 文件变动 → 自动 reset 队列里的对应 job 为
  `force=true`，worker 重跑覆盖原 entry（同 id，无 `-2` 后缀）。
- **`--no-auto-watch`** 临时关掉，或写到 `~/.pith-wiki/config.json` 里 `"watchAutoStart": false`。

CLI 独立运行：

```bash
# 临时配一条 watcher（不进 config）
pith-wiki watch --dir ~/notes/inbox --collection reading --initial-scan

# 用 collectionFromSubdir
pith-wiki watch --dir ~/.../vault --collection-from-subdir --fallback-collection misc

# 读 config.watchDirs（前台运行；Ctrl-C 关闭）
pith-wiki watch
```

watcher 自身**不取队列锁**——可以和 REPL（自动起的 worker）/ `queue run` 并行；
它只 `enqueue`，不跑 hydrate。

---

## 检索

不需要调用 LLM 的本地操作：

```bash
# 查看一个词条
pith-wiki get llm-agent-design

# 装配上下文（无 LLM 调用，纯本地检索）
pith-wiki query "agent 的重试逻辑应该怎么设计"

# 列出全部 / 某个 collection 的词条
pith-wiki list --collection tech
```

---

## 诊断 doctor

对积攒到几十上百条之后的 wiki 做一次体检，把"格式坏掉、引用错位、id 撞名"
这类不会被 LibraryService 静默跳过却真实存在的问题摊出来。仅报告，不动数据。
不需要调用 LLM。

```bash
# 默认人类可读输出；有问题时 exit 1，便于 CI 钩进 pre-commit
pith-wiki doctor

# 机器可读，喂给 jq / 监控系统都方便
pith-wiki doctor --json

# 只跑某一类（默认全跑，五类排序：frontmatter / orphan-link / duplicate-id
# / illegal-source / dangling-concept）
pith-wiki doctor --check orphan-link,dangling-concept
```

五类 check：

| 名 | 严重度 | 抓什么 |
|---|---|---|
| `frontmatter` | error | YAML 语法坏 / `EntrySchema` 校验不过（id 不是 kebab-case、tags 超 6 个、updated 不是 ISO 时间等） |
| `orphan-link` | warning | `links: [foo]` 但库里没有 `foo` 这条 entry |
| `duplicate-id` | error | 同一 id 在两个或更多 collection 出现 —— 按 id 查询会歧义 |
| `illegal-source` | warning | `source.type=file` 但 `source.value` 落在沙箱外（`workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`）—— `wiki_read_source` 会读不到 |
| `dangling-concept` | warning | 正文 `[[id]]` 标注但目标不存在，或目标存在但没登记到 `links:` 字段 |

每条 problem 自带 `suggestion`，告诉你具体改哪个文件的哪个字段。结构化 JSON
输出 schema 见 [src/wiki/doctor.ts](../src/wiki/doctor.ts) 顶部的 `DoctorReport` 类型。

> 计划中的 `doctor --fix`（自动修复）单独跟踪在后续 issue —— 当前版本明确只读。

---

## 多 provider 切换

pith-wiki 走的是 OpenAI-compatible 协议——任何同协议的服务（DeepSeek / Qwen
DashScope / OpenAI / Moonshot Kimi / Zhipu GLM / OpenRouter / Groq / 本地
Ollama …）都能直接接入。在 `~/.pith-wiki/config.json` 里并列声明多条：

```jsonc
{
  "providers": {
    "deepseek": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "qwen":     { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "apiKeyEnv": "DASHSCOPE_API_KEY" },
    "openai":   { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" },
    "kimi":     { "baseURL": "https://api.moonshot.cn/v1", "model": "moonshot-v1-32k", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "ollama":   { "baseURL": "http://localhost:11434/v1", "model": "llama3.1:70b", "apiKey": "ollama" }
  },
  "activeProvider": "deepseek"
}
```

每个 entry 的 API key：`apiKey`（字面，不推荐写在 JSON 里）或 `apiKeyEnv`（env 变量名）。

切换方式（优先级从高到低）：

```bash
pith-wiki --provider qwen                  # 仅当前命令
PITH_WIKI_PROVIDER=qwen pith-wiki          # 当前 shell session
# config.json 里 "activeProvider": "qwen" → 持久默认
```

REPL 内动态切换：

```
› /provider                # 列出全部，* 标当前
› /provider qwen           # 切换；隐式 /reset 对话（不同模型不共享 history）
```

provider 必须支持 **function calling + JSON mode** 才能完整工作；缺前者 REPL
agent loop 卡死，缺后者 `wiki_ingest` / `/digest` 失败。

---

## 全局开关

| Flag | 作用 |
|---|---|
| `--read-only` | 禁用一切写入（read_file / list_dir 仍可） |
| `--model <name>` | 覆盖 active provider 的 model |
| `--root <dir>` | 覆盖 wikiRoot |
| `--read-path <dir>` | 添加额外只读目录（可重复，详见 [docs/config.md](config.md#额外可读目录)） |
| `--provider <name>` | 临时切 provider（不写持久 config） |
