# Quickstart — 5 分钟入门

从 0 到第一条入库 entry。完整文档去 [README.md](../README.md)；这里只走主路。

## 1. 装

```bash
git clone https://github.com/l-zhi/llm-wiki.git
cd llm-wiki
npm install
npm run build
```

需要 **Node ≥ 20**。

## 2. 拿个 API key

llm-wiki 走 OpenAI-compatible 协议，任何同协议的服务都能用。最便宜的选择是
[DeepSeek](https://platform.deepseek.com/api_keys)（`deepseek-chat` 输入约
$0.27 / 1M tokens）。注册拿 key，写到 home 配置：

```bash
mkdir -p ~/.llm-wiki
cp .env.example ~/.llm-wiki/.env
chmod 600 ~/.llm-wiki/.env

# 编辑 ~/.llm-wiki/.env，填入：
# DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

> 想用别的 provider（Qwen / OpenAI / 本地 Ollama …）？看
> [docs/config.example.json](config.example.json) 多 provider 示例。

## 3. 入库第一条

挑一个你想"消化"的 markdown 文件（一篇 paper、一篇博客、自己的笔记都行），
管道送进 `ingest`：

```bash
cat ./some-article.md | node dist/bin/llm-wiki.js ingest --collection reading
```

或者 `--file ./some-article.md`。成功会输出新 entry 的 id；库默认落在 `~/.llm-wiki/wiki-data/`：

```bash
ls ~/.llm-wiki/wiki-data/reading/
# → my-article-title.md   (id 由 LLM 派生，kebab-case)
```

打开 entry 看看脱水成什么样：

```bash
cat ~/.llm-wiki/wiki-data/reading/my-article-title.md
```

`frontmatter` 里有 `compressionRatio` —— 原文压到了几分之几，肉眼可见。

## 4. 查回来

```bash
# 装配上下文（无 LLM 调用，纯本地关键词检索）
node dist/bin/llm-wiki.js query "你刚 ingest 那篇文章的核心观点"

# 或者列全部 entries
node dist/bin/llm-wiki.js list --collection reading

# 或者交互式 REPL（一边问，一边让 LLM 自动调 wiki_query）
node dist/bin/llm-wiki.js
```

REPL 里直接用自然语言聊。例如："基于我 reading collection 里的笔记，对比一下
[topic A] 和 [topic B]" —— LLM 会自动调 `wiki_query` 拉相关 entries 拼上下文，
再回答。

## 5. 接下来去哪

- **想自动入库**？把笔记目录配进 `watchDirs`（README §目录监听 watcher）
- **想批量入库一整个目录**？`ingest --batch '<glob>'` 或 `--dir <folder>`
- **想换 provider 或同时配多个**？看 README §多 provider 切换 +
  [docs/config.example.json](config.example.json)
- **库脏了想检体检**？`llm-wiki doctor` 扫一遍格式错误、孤儿链接、重复 id（README §诊断）
- **想知道项目要往哪走**？[docs/roadmap.md](roadmap.md)
- **想贡献**？[CONTRIBUTING.md](../CONTRIBUTING.md)

## 装好却报错？

| 现象 | 多半是 |
|---|---|
| `Error: API key required` | `~/.llm-wiki/.env` 没建好，或 key 名字写错（DeepSeek 用 `DEEPSEEK_API_KEY`） |
| `command not found: llm-wiki` | 没 `npm link` 或直接用 `node dist/bin/llm-wiki.js` |
| `tsc` 报一堆类型错 | Node 版本太低，需要 ≥ 20。`node --version` 看一下 |
| `Failed to parse ~/.llm-wiki/config.json` | `config.json` 写错了，删掉这个文件让默认值兜底，再按 README §配置 重写 |
| ingest 卡很久 | 大概率正常 —— DeepSeek 在 hydrate 一篇 5KB 文章要 5-15 秒。看不到进度可以另开终端 `llm-wiki status` |

碰到不在列表里的报错，去 [GitHub Issues](https://github.com/l-zhi/llm-wiki/issues)
开一个 bug。
