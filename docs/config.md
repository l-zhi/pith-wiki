# 配置与数据落地

- [配置优先级](#配置优先级)
- [字段一览](#字段一览)
- [额外可读目录](#额外可读目录)
- [文件落在哪](#文件落在哪)

---

## 配置优先级

```
命令行 flag  >  环境变量  >  ~/.pith-wiki/config.json  >  内置默认
```

需要一份能直接 copy 的完整 `config.json` 示例？看
[docs/config.example.json](config.example.json)——多 provider + watchDirs + queue
+ 自定义路径全字段都有，对照下面的字段表挑你要的部分粘到
`~/.pith-wiki/config.json` 就行。

---

## 字段一览

| 字段 | 环境变量 | 默认 |
| --- | --- | --- |
| `apiKey` | `DEEPSEEK_API_KEY` | _必填_（仅 ingest 与 REPL 需要；多 provider 模式下被 active entry 覆盖） |
| `baseURL` | `PITH_WIKI_BASE_URL` | `https://api.deepseek.com` |
| `model` | `PITH_WIKI_MODEL` | `deepseek-chat` |
| `providers` | _（无 env，复杂结构）_ | `{}`（详见 [usage.md#多-provider-切换](usage.md#多-provider-切换)） |
| `activeProvider` | `PITH_WIKI_PROVIDER` | _未设_（CLI `--provider` 优先） |
| `wikiRoot` | `PITH_WIKI_ROOT` | `~/.pith-wiki/wiki-data` |
| `workspaceRoot` | `PITH_WIKI_WORKSPACE` | `<cwd>` |
| `readOnly` | `PITH_WIKI_READ_ONLY` | `false` |
| `additionalReadPaths` | `PITH_WIKI_READ_PATHS`（JSON 数组或 `:` 分隔） | `[]` |
| `queueStatePath` | _（无 env）_ | `~/.pith-wiki/queue/state.json` |
| `queueLogDir` | _（无 env）_ | `~/.pith-wiki/queue/logs` |
| `queueConcurrency` | _（无 env）_ | `2` |
| `queueMaxAttempts` | _（无 env）_ | `3` |
| `queueAutoStart` | _（无 env）_ | `true`（CLI `--no-auto-queue` 关） |
| `watchDirs` | _（无 env）_ | `[]`（详见 [usage.md#目录监听-watcher](usage.md#目录监听-watcher)） |
| `watchAutoStart` | _（无 env）_ | `true`（CLI `--no-auto-watch` 关） |
| `outputDir` | _（无 env）_ | `<wikiRoot>/output/transcripts` |
| `transcriptEnabled` | _（无 env）_ | `true`（CLI `--no-transcript` 关） |
| `digestCollection` | _（无 env）_ | `output`（`/digest` 默认落地的 collection） |
| `cacheConverted` | _（无 env）_ | `true`（CLI `--no-cache` 关） |
| `soulFile` | `PITH_WIKI_SOUL` | _自动查找_（详见 SOUL.md.example） |
| `maxToolPayloadBytes` | _（无 env）_ | `100000` |
| `configPath` | `PITH_WIKI_CONFIG_PATH` | `~/.pith-wiki/config.json` |

---

## 额外可读目录

默认情况下，`read_file` / `list_dir` 工具只能访问当前工作目录与 `wikiRoot` 之下。
如果你希望让 LLM 也能查阅项目外的资料目录（笔记库、参考论文等），但**不让它修改**这些目录，可用：

```bash
# CLI flag（可重复）
pith-wiki --read-path ~/notes --read-path ~/research/papers

# 环境变量 / .env —— 推荐 JSON 数组写法，~ 自动展开
PITH_WIKI_READ_PATHS=["~/notes", "~/research/papers"]

# 环境变量也支持分隔符串（POSIX `:` / Windows `;`）
PITH_WIKI_READ_PATHS=/Users/me/notes:/Users/me/research/papers

# ~/.pith-wiki/config.json
{ "additionalReadPaths": ["/Users/me/notes", "/Users/me/research/papers"] }
```

**两层效果**：

1. **读扩展**：`read_file` / `list_dir` 工具能读到这些目录；`write_file` 仍只锁在
   `workspaceRoot ∪ wikiRoot`。
2. **入库门槛**：`pith-wiki ingest --file <p>` 与 `--batch` / `--dir` 模式都强制要求源文件落在
   `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths` 之内。从沙箱外的路径 ingest 会立即报错并拒绝。
   这避免了"`pith-wiki ingest --file /etc/passwd`"这种意外把任意系统文件 wiki 化的可能。

所有路径都经 `realpath` 归一化，符号链接逃逸到沙箱外仍会被拒绝。沙箱设计细节
见 [docs/security-model.md](security-model.md)。

---

## 文件落在哪

所有 pith-wiki 的本地数据都在 `~/.pith-wiki/` 下，**不沾染任何 workspace**：

```
~/.pith-wiki/
├── .env                                 # 默认 .env 加载位置（mode 600）
├── config.json                          # 可选用户配置
├── history                              # REPL 上下键的命令历史（最近 N 条）
├── SOUL.md                              # 可选；persona overlay（见 SOUL.md.example）
├── wiki-data/                           # 默认 wikiRoot —— 你的整套 wiki
│   ├── tech/                            # collection（被 LibraryService 索引）
│   │   └── agent-loop.md                # entry：YAML frontmatter + Markdown body
│   ├── reading/                         # collection
│   └── output/                          # collection（默认 digestCollection）
│       ├── agent-retry-policy.md        # /digest 产出的 wiki entry（被索引）
│       └── transcripts/                 # raw transcripts 子目录（不被索引）
│           └── 2026-04-30T08-15-32-100Z.md   # 每次 REPL session 一份
├── queue/
│   ├── state.json                       # 持久化队列状态（jobs + 事件环形缓冲）
│   ├── state.json.lock                  # worker 持锁时存在；含 pid/ts
│   └── logs/
│       └── <jobId>.log                  # 每个 job 的独立 append-only 日志
└── index.json                           # LibraryService 持久化 entry 索引（冷启动加速）
```

> **想把 wiki 跟 workspace 绑在一起？** 在 `~/.pith-wiki/config.json` 里写
> `"wikiRoot": "/Users/me/code/myproject/wiki-data"`，或 export `PITH_WIKI_ROOT`。
> `.gitignore` 里加 `/wiki-data/` 防止误提交。
