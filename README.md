# pith-wiki

> **English TL;DR** — A terminal-native LLM wiki, Karpathy-style: don't shove
> raw docs into a vector DB and pray. Hydrate them into dense Markdown entries;
> retrieve by keyword + link traversal. Local, file-based, works with any
> OpenAI-compatible LLM endpoint.
>
> 中文完整文档见下方。 README in Chinese below.

---

一个仿 Claude Code 风格的命令行工具，用于搭建 **Karpathy 风格** 的 LLM 知识库。
默认模型：**DeepSeek**（`deepseek-chat`）。默认存储：一个装 Markdown 文件的文件夹。

> 设计哲学：**数据工程 > 检索算法。** 不要把原始文档塞进库里、再指望 embedding
> 把它捞回来。用 LLM 把原文 _脱水（hydrate）_ 成高密度的 Markdown 词条，
> 检索时靠关键词 + 链接遍历，简单直接，肉眼可读。

**平台支持**：Linux 与 macOS 一等公民，CI 矩阵两个都跑（Node 20 / 22）。Windows
理论可用但**不在 CI 覆盖范围**——`fs.rename` 原子性、chokidar fs-event、`path.delimiter`
都跟 POSIX 不一样；社区 PR 欢迎，但首发不投入这部分工程量。详见
[ADR-0003](docs/adr/0003-windows-best-effort.md)。

## 安装

> 5 分钟从 0 跑通第一条入库 → [docs/quickstart.md](docs/quickstart.md)。

### 用户：装来用

```bash
# 从 npm 装到全局（v0.3.0 发布后可用）
npm install -g pith-wiki

# 一次性初始化：建 ~/.pith-wiki/、写 .env 模板、chmod 600
pith-wiki init

# 编辑 ~/.pith-wiki/.env 填 DEEPSEEK_API_KEY；或者一行非交互 setup：
pith-wiki init --force --api-key sk-xxxxxxxxxxxxxxxx

# 进 REPL
pith-wiki
```

### 开发者：从源码构建

想改代码 / 贡献 PR / 跑没发布的 main 分支：

```bash
git clone https://github.com/l-zhi/pith-wiki.git
cd pith-wiki
npm install
npm run dev -- init     # 建 ~/.pith-wiki/、写 .env 模板（tsx 直接编译执行，免 build）
npm run dev             # 跑 REPL
```

其它开发期脚本：`npm test` / `npm run typecheck` / `npm run lint` / `npm run build`。
详细贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这工具能干啥

**1. 脱水**（Hydrate）—— 把原始文档（markdown / PDF / DOCX / HTML / email）压缩成
~30% 大小的高密度词条，扔掉口水话和修饰词，只留信号。LLM 直接读得动。

**2. 检索**（Retrieve）—— 没 embedding、没向量库。关键词加权（title × 2、
tags × 2、summary × 1、content × 0.5）+ BFS 链接遍历，简单到不可能出错。
词条本身就是 markdown，Obsidian / VS Code / Git 都能直接用。

**3. 对话**（Chat）—— REPL agent 通过 8 个工具（read / write / list_dir +
wiki_ingest / wiki_get / wiki_query / wiki_list / wiki_read_source）跟你的库
聊天。每次回合自动写 transcript，`/digest` 把对话精华回灌成 wiki 条目，
形成 "聊 → 落库 → 下次能查到" 的反馈环。

**4. 自动入库**（Ingest）—— 配 `watchDirs` 之后，你的笔记目录（Obsidian vault /
inbox folder）有变动就自动入队，后台 worker 自动消化。`pith-wiki doctor` 定期
检查库的健康度（孤儿链接、坏 frontmatter、id 撞名）。

## 命令速览

| 命令 | 一句话 |
|---|---|
| `pith-wiki init [--force] [--api-key <k>]` | 一次性初始化 `~/.pith-wiki/`（建目录 + 写 .env 模板 + chmod） |
| `pith-wiki` | 进 REPL（chat + 自动 worker + 自动 transcript） |
| `pith-wiki ingest --collection <c> --file <p>` | 单文件脱水入库 |
| `pith-wiki ingest --collection <c> --dir <d>` | 目录批量入库 |
| `pith-wiki queue add\|status\|run\|retry\|clear` | 持久化队列管理 |
| `pith-wiki watch` | 启动目录监听 |
| `pith-wiki get <id>` / `list` / `query "..."` | 检索（不需要 API key） |
| `pith-wiki doctor [--json] [--check ...]` | 库健康度体检（不需要 API key） |
| `pith-wiki converters` / `status` | 列转换器 / 启动 dashboard |
| `pith-wiki --help` | 全部子命令 |

每条命令的详细 flag、REPL 内的 slash 命令、watcher / queue 配置见 [docs/usage.md](docs/usage.md)。

## 完整文档

| 文档 | 看这个的时机 |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | 5 分钟入门，从安装到第一条入库 |
| [docs/usage.md](docs/usage.md) | 详细 CLI 命令 + REPL + queue + watcher + doctor + 多 provider |
| [docs/repl-workflow.md](docs/repl-workflow.md) | 多终端协作、transcript、`/digest`、日常工作流 |
| [docs/config.md](docs/config.md) | 配置字段表、`additionalReadPaths`、文件落在哪 |
| [docs/config.example.json](docs/config.example.json) | 完整 `~/.pith-wiki/config.json` 示例（多 provider + watchDirs + queue） |
| [docs/entry-format.md](docs/entry-format.md) | 词条文件 YAML frontmatter 格式 |
| [docs/architecture.md](docs/architecture.md) | 三件套核心服务 + 数据流图 |
| [docs/security-model.md](docs/security-model.md) | 沙箱不变量（贡献者必读） |
| [docs/roadmap.md](docs/roadmap.md) | Likely next / Maybe someday / 明确不做 |
| [SECURITY.md](SECURITY.md) | 漏洞上报渠道 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

## License

[MIT](LICENSE) · Copyright (c) 2026 lizhi
