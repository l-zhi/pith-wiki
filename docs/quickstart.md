# Quickstart — 5 分钟入门

从 0 到第一条入库 entry。完整文档去 [README.md](../README.md)；这里只走主路。

## 1. 装

```bash
npm install -g pith-wiki   # 全局；后续命令直接叫 `pith-wiki`
# 或不想全局污染：
# npx pith-wiki <subcommand>
```

需要 **Node ≥ 20**。

> 想跑源码 / 改代码？看 [README §开发者](../README.md#开发者从源码构建) 那一段，
> 用 `git clone` + `npm run build` 走开发者路径。本文以已装好 `pith-wiki` 命令为前提。

## 2. 拿个 API key

pith-wiki 走 OpenAI-compatible 协议，任何同协议的服务都能用。最便宜的选择是
[DeepSeek](https://platform.deepseek.com/api_keys)（`deepseek-chat` 输入约
$0.27 / 1M tokens）。注册拿 key，写到 home 配置：

```bash
# 一行建好 ~/.pith-wiki/ + .env 模板 + chmod 600：
pith-wiki init

# 然后编辑 ~/.pith-wiki/.env 填入：
# DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

或者直接非交互一行（CI / 自动化友好）：

```bash
pith-wiki init --force --api-key sk-xxxxxxxxxxxxxxxx
```

> 想用别的 provider（Qwen / OpenAI / 本地 Ollama …）？看
> [docs/config.example.json](config.example.json) 多 provider 示例。

## 3. 入库第一条

挑一个你想"消化"的 markdown 文件（一篇 paper、一篇博客、自己的笔记都行），
管道送进 `ingest`：

```bash
cat ./some-article.md | pith-wiki ingest --collection reading
```

或者 `--file ./some-article.md`。成功会输出新 entry 的 id；库默认落在 `~/.pith-wiki/wiki-data/`：

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
# 装配上下文（无 LLM 调用，纯本地关键词检索）
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

- **想自动入库**？把笔记目录配进 `watchDirs`（README §目录监听 watcher）
- **想批量入库一整个目录**？`ingest --batch '<glob>'` 或 `--dir <folder>`
- **想换 provider 或同时配多个**？看 README §多 provider 切换 +
  [docs/config.example.json](config.example.json)
- **库脏了想检体检**？`pith-wiki doctor` 扫一遍格式错误、孤儿链接、重复 id（README §诊断）
- **想知道项目要往哪走**？[docs/roadmap.md](roadmap.md)
- **想贡献**？[CONTRIBUTING.md](../CONTRIBUTING.md)

## 装好却报错？

| 现象 | 多半是 |
|---|---|
| `Error: API key required` | `~/.pith-wiki/.env` 没建好，或 key 名字写错（DeepSeek 用 `DEEPSEEK_API_KEY`） |
| `command not found: pith-wiki` | 没全局装；要么 `npm install -g pith-wiki`，要么用 `npx pith-wiki <subcommand>` 替代。源码开发者用 `node dist/bin/pith-wiki.js` 或先 `npm link` |
| `tsc` 报一堆类型错 | Node 版本太低，需要 ≥ 20。`node --version` 看一下 |
| `Failed to parse ~/.pith-wiki/config.json` | `config.json` 写错了，删掉这个文件让默认值兜底，再按 README §配置 重写 |
| ingest 卡很久 | 大概率正常 —— DeepSeek 在 hydrate 一篇 5KB 文章要 5-15 秒。看不到进度可以另开终端 `pith-wiki status` |

碰到不在列表里的报错，去 [GitHub Issues](https://github.com/l-zhi/pith-wiki/issues)
开一个 bug。
