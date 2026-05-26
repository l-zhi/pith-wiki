# Quickstart — 5 分钟入门

> English version → [quickstart.md](./quickstart.md)

从 0 到第一条入库 entry。完整文档去 [README.md](../README.md)；这里只走主路。

## 1. 安装

```bash
npm install -g pith-wiki
```

需要 **Node ≥ 20**。

## 2. 拿个 API key

pith-wiki 走 OpenAI-compatible 协议，任何同协议的服务都能用。最便宜的选择是
[DeepSeek](https://platform.deepseek.com/api_keys)（`deepseek-chat` 输入约
$0.27 / 1M tokens）。注册拿 key，然后跑交互式 `init`——它会让你选 provider、
写最小化 `.env`、可选写 `config.json`：

```bash
pith-wiki init
# 提问顺序：
#   Select an LLM provider:  [1] DeepSeek (default)  [2] OpenAI  ...
#   Enter your DeepSeek API key:  sk-xxxxxxxxxxxxxxxx
#   Auto-watch directory (optional):  ~/Obsidian   (回车跳过)
#   Scan existing files now? [Y/n]  Y
```

任何一步回车都跳过 / 用默认。非交互一行（CI / 自动化）：

```bash
pith-wiki init --provider deepseek \
               --api-key sk-xxxxxxxxxxxxxxxx \
               --no-prompt
```

> 想用别的 provider（Qwen / OpenAI / OpenRouter / 本地 Ollama …）？交互式 init
> 时直接挑，或者参考 [docs/config.example.json](config.example.json) 写多 provider 配置。

## 3. 入库第一条

挑一个你想"消化"的 markdown 文件（一篇 paper、一篇博客、自己的笔记都行），
管道送进 `ingest`：

```bash
cat ./some-article.md | pith-wiki ingest --collection reading
```

或者 `--file ./some-article.md`。成功会输出新 entry 的 id；库默认落在
`~/.pith-wiki/wiki-data/`：

```bash
ls ~/.pith-wiki/wiki-data/reading/
# → my-article-title.md   (id 由 LLM 派生，kebab-case)
```

打开 entry 看看脱水成什么样：

```bash
cat ~/.pith-wiki/wiki-data/reading/my-article-title.md
```

`frontmatter` 里有 `compressionRatio` —— 原文压到了几分之几，肉眼可见。

## 4. 查回来

```bash
# 本地关键词检索（无 LLM 调用）
pith-wiki query "你刚 ingest 那篇文章的核心观点"

# 或者列全部 entries
pith-wiki list --collection reading

# 或者交互式 REPL（一边问，一边让 LLM 自动调 wiki_query）
pith-wiki
```

REPL 里直接用自然语言聊。例如："基于我 reading collection 里的笔记，对比一下
[topic A] 和 [topic B]" —— LLM 会自动调 `wiki_query` 拉相关 entries 拼上下文，
再回答。

## 5. 接下来去哪

- **想自动入库**？把笔记目录配进 `watchDirs`（init 时可能已经做过了）。详见
  README §watchDirs。
- **想批量入库一整个目录**？`ingest --batch '<glob>'` 或 `--dir <folder>`。
- **想换 provider 或同时配多个**？看 README §多 provider +
  [docs/config.example.json](config.example.json)。
- **库脏了想检体检**？`pith-wiki doctor` 扫一遍格式错误、孤儿链接、重复 id。
- **想知道项目要往哪走**？[docs/roadmap.md](roadmap.md)。
- **想贡献**？[CONTRIBUTING.md](../CONTRIBUTING.md)。

## 装好却报错？

| 现象 | 多半是 |
|---|---|
| `Error: API key required` | `~/.pith-wiki/.env` 没建好，或 key 名字写错（DeepSeek 用 `DEEPSEEK_API_KEY`）。重跑 `pith-wiki init`。 |
| `command not found: pith-wiki` | 没全局装。要么 `npm install -g ./pith-wiki-*.tgz`，要么从源码用 `node dist/bin/pith-wiki.js`，要么 `npm link`。 |
| `tsc` 报一堆类型错 / 诡异 ESM 报错 | Node 版本太低，需要 ≥ 20。`node --version` 看一下。 |
| `Failed to parse ~/.pith-wiki/config.json` | `config.json` 写错了。删掉这个文件让默认值兜底，再 `pith-wiki init` 重写。 |
| `watch path outside read sandbox: /some/path` | watch 目录不在读取沙箱里。`pith-wiki init --force --watch-dir /your/path` 会重写 config，把这个路径同时加进 `additionalReadPaths`。 |
| ingest 卡很久 | 大概率正常——DeepSeek 在 hydrate 一篇 5KB 文章要 5–15 秒。另开终端 `pith-wiki status` 看进度。 |

碰到不在列表里的报错，去 [GitHub Issues](https://github.com/l-zhi/pith-wiki/issues)
开一个 bug。
