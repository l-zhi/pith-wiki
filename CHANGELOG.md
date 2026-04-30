# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **持久化索引 `<wikiRoot>/index.json`：冷启动免去全量 scanAll。**
  LibraryService 现在把 entryCache 防抖（默认 5s）写到磁盘；下次启动若磁盘
  cache 比 collection 目录新鲜（mtime 比较），直接跳过 `readFileSync + matter.parse`
  整组操作。500 条 entry 大库的冷启从 ~80ms 降到 ~5ms（10× 提速）。
  - **新鲜度检查**：load 时对比 `index.json` mtime 与每个 collection 目录的 mtime；
    任一目录较新 → 拒绝 cache，scanAll 重建。能抓到"外部新增/删除文件"，
    抓不到"原地编辑现有文件且 mtime 一致"——后者交给 watcher → put 链路覆盖。
  - **写入触发**：`put` / `delete` 后 schedulePersist；多次写入合并为一次磁盘写。
    Timer 用 `unref()` 不阻塞 CLI 退出。
  - **Schema 兼容**：JSON 含 `version: 1`；version 不匹配或解析失败时 silent
    fallback 到 scanAll。每条 entry 用 EntrySchema 二次校验，损坏字段 → 拒绝整份。
  - **新方法 `flushIndex()`**：同步刷盘，绕过防抖。已接入：
    - REPL 退出（`App.tsx` 卸载 effect）
    - `queue run` 命令的 finally 块
    - `ingest` 单文件 / 批量分支结尾
  - **架构清理：REPL 共用一个 LibraryService 实例**。原本 agent 工具和 queue
    worker / watcher 各自 new 一份，导致 in-memory cache 不同步——worker 刚
    ingest 的新条目，agent 的 `wiki_list` 拿不到；两份 cache 还会互相覆盖
    `index.json`。现在 `App.tsx` 顶层 `useMemo` 一份 library，透传到 `buildContext`、
    runQueue、runWatcher、`/digest` handler。`buildContext` 加可选第 4 参数
    接收外部 library，CLI 子命令仍走默认 new。
  - 8 个新增测试覆盖：写入/读回、跨实例验证、外部 .md 增加触发拒绝、版本不
    匹配 / 损坏 JSON 退化、`persist=false` 完全不写、防抖窗口合并多次 put、
    schema 不合法的旧 cache 拒绝。

- **检索链路升级：四级检索阶梯 + 中文 bigram + source 路径透传给模型。**
  彻底解决 v0 的两个软肋——中文查询打不中、模型不知道何时该读原文。
  - **`ContextAssembler.tokenize` 接入 CJK bigram**。原 `\W+` 切词把整段中文当一
    个 token，纯中文查询全打不中。新管线分两条：ASCII 走 `\W+`，CJK 抽连续段做
    2 字符滑窗（`成长和低谷期` → `成长/长和/和低/低谷/谷期`）。不上 jieba/segmentit
    是因为依赖体积大，bigram 已能覆盖 80%+"问句对题目"召回；真要语义检索得换
    embedding。单字仍不参与匹配，避免"的/了"高频字噪声。
  - **新增工具 `wiki_list`**：浏览内存索引（id/title/summary/tags/source），不带
    content。当 `wiki_query` 关键词打不中时，让模型语义性地从摘要列表挑候选。
    支持 `collection` / `tags`（OR） / `contains`（id+title+summary 子串）过滤，
    按 `updated` 降序。
  - **新增工具 `wiki_read_source`**：读 entry.source.value 指向的原始文件。把
    "wiki_get → 取 source 路径 → read_file" 三步压成一个动作；source.type ≠ 'file'
    时清晰报错，路径在沙箱外 / 文件已删除时给出可操作的提示。
  - **`wiki_query` 返回新增 `references` + `total_entries_in_library`**。每条
    `references[]` 含 `{id, title, collection, source: {type, value?}}`，模型据此
    直接判断"hydrated digest 不够细 → wiki_read_source 这条原文"。
    `total_entries_in_library` 让模型在零结果时知道是"库空"还是"没匹配"。
    旧字段 `referenced_entries: string[]` 保留兼容。
  - **SYSTEM_PROMPT 重写**：把检索阶梯（query → list → get → read_source）写成
    显式 4 步 workflow，标明 wiki_query 是关键词打分而非语义检索、context 是
    ~30-50% 压缩 digest、Chinese 用 bigram 等关键不变量。模型从此知道"何时该
    fallback、何时该读原文"。
  - 新增 `tests/wiki-tools.test.ts`（15 用例覆盖 list 过滤组合 / read_source 各种
    source.type 与沙箱失败路径 / query 新字段形状）；更新 `tests/assembler.test.ts`
    把"v0 已知中文局限"6 条断言翻转成"接入 bigram 后能正常工作"。

- **REPL slash 命令实时提示 + Tab 补全。** 在输入框打 `/` 会立即弹出全部 slash
  命令的清单（`/help` / `/clear` / `/reset` / `/transcript` / `/digest` / `/exit`），
  按命令前缀实时过滤；Tab 触发补全（1 个匹配 → 完整补全；多匹配 → 最长公共前缀，
  fish/zsh 风格）。`takesArg` 命令（如 `/digest`）补全后自动追加空格提示填参数。
  - 单一注册表 `src/cli/slashCommands.ts`：`/help` 文本、欢迎语、提示框、Tab 补全
    都从这里读，避免命令名在多处漂移。
  - 历史浏览（↑/↓）逻辑保留不变；Tab 仅在 `/` 开头且有匹配时拦截，其他情况下交回
    给 ink-text-input。
  - 新增 `tests/slash-commands.test.ts`（15 用例）覆盖 `filterCommands` /
    `completeOnTab` 的所有边界（无匹配、唯一匹配、多匹配、参数区不补全、别名前缀）。

- **目录监听 watcher：自动把笔记变动入队。** 配置 `watchDirs` 后，REPL 启动会
  起一个 chokidar 监听器，对源目录里 `.md` 文件的 add/change 事件自动 `enqueue`
  到持久化队列；worker 拣起来后 hydrate → `library.put` → 索引自动新鲜。
  - **使用最简形式**：在 `~/.llm-wiki/config.json` 里加：

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

    再 `pnpm dev`，REPL 顶部出现 `watch N` 标记，从此往 vault 加 `工作/笔记.md`
    会自动落进 `<wikiRoot>/工作/<id>.md`。
  - **collection 解析**：
    - 固定模式 `collection: "tech"` — 整棵树统一进 `tech`
    - 一级子目录模式 `collectionFromSubdir: true` — `工作/笔记.md` → `工作`，
      `tech/foo.md` → `tech`，深层子目录始终取一级；中文/英文目录名直接用，
      `subdirAlias` 是可选改名工具（如把 `工作` 映射成 `work`）
    - 直接挂在 watch root 下的文件 → `fallbackCollection`
  - **沙箱**：watch 路径必须落在 `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths`
    之内（沿用 `LLM_WIKI_READ_PATHS` 同款校验），且**绝不允许是 wikiRoot 子树**——
    否则 `library.put` 写完会触发 watcher，形成自写循环；启动期硬校验，失败 fail-fast。
  - **默认 ignored**：`.obsidian/`、`.git/`、`.DS_Store`、`.icloud`（任意层级）+
    `wiki/` / `outputs/` / `node_modules/`（任意层级）。Obsidian vault 里的
    plugin/workspace 配置不会污染队列。
  - **awaitWriteFinish** 自动合并编辑器多次保存事件（500ms 稳定窗口）；外加 1s
    内存 cooldown 兜底防抖。
  - **change 事件 → force=true**：watcher 检测到已 ingest 文件变动时，把队列里
    对应 job reset 为 `pending` + `force=true` + `attempts=0`，让 worker 必跑一次
    重 hydrate。`processJob` 的 `isOverwriteOfSelf` 路径保证同一文件覆盖原 entry，
    不会产生 `-2` 后缀。
  - **CLI 命令 `llm-wiki watch`**：独立前台进程，只 enqueue 不取队列锁，可与
    REPL / `queue run` 并行：
    ```bash
    # 临时配一条
    llm-wiki watch --dir ~/notes/inbox --collection reading --initial-scan
    # 或读 config.watchDirs
    llm-wiki watch
    ```
  - **REPL 启动开关**：默认开（`watchAutoStart: true`）；`pnpm dev --no-auto-watch`
    或 `~/.llm-wiki/config.json` 里 `"watchAutoStart": false` 关掉。
  - 新增 chokidar 依赖；新增 `src/wiki/queue/watcher.ts`、`tests/watcher.test.ts`
    （32 用例覆盖纯函数、enqueue 状态机、initialScan 批量、真 fs 集成）。

### Changed

- **`.env` 默认从 `~/.llm-wiki/.env` 读取（覆盖项目根 `.env`）。** dotenv
  加载顺序：先项目根 `.env`（fallback / 首次 setup 仍走传统约定），再
  `~/.llm-wiki/.env` with `override: true`。两个都不存在时静默 no-op。
  - 设计意图：避免每个项目都要复制 `.env`；`DEEPSEEK_API_KEY` 这类跨
    workspace 不变的密钥只放一份在 home。
  - 升级路径：`mv ./.env ~/.llm-wiki/.env && chmod 600 ~/.llm-wiki/.env`。
    保留项目 .env 也行，但 home 里同名变量优先生效。
  - README 安装步骤同步更新成 `cp .env.example ~/.llm-wiki/.env`。

- **`wikiRoot` 默认值挪到 `~/.llm-wiki/wiki-data`。** 旧默认是
  `<workspaceRoot>/wiki-data/`——容易被无意提交进项目仓库，且多个 workspace
  无法共享同一份 wiki。新默认让所有 llm-wiki 本地数据（wiki / config /
  history / 队列状态 / 队列日志）都集中在 `~/.llm-wiki/` 下。
  - **升级方式**：旧用户已经在项目下攒了条目时手动 `mv ./wiki-data
    ~/.llm-wiki/wiki-data`；想保留原位置在 `~/.llm-wiki/config.json` 里
    写 `"wikiRoot": "<绝对路径>"` 或 export `LLM_WIKI_ROOT`。
  - `.gitignore` 同步：去掉 `wiki-data/*/` + `!wiki-data/.gitkeep` 这套
    特例，换成更直白的 `/wiki-data/`——给那些把 wikiRoot 设回项目内的
    用户兜底，避免他们的 wiki 数据误入版本控制。
  - 删除 `wiki-data/.gitkeep`（旧默认占位符，新默认下没意义）。

### Added

- **`/digest [collection]` slash 命令：把当前对话压缩成 wiki entry。** 在 REPL
  里抓 agent 自上次 `/reset` 起的全部 `user` / `assistant` 消息（含 `tool_calls`
  名字 + 参数），喂给 `HydrationService.hydrate`，产出一条规整的高密度
  wiki entry 落到 `<wikiRoot>/<digestCollection>/`。从此这条对话的精华就成了
  可被 `query` / `wiki_query` 检索的正式条目，形成"对话 → wiki 条目 → 下次
  对话又能查到"的反馈环。
  - 新增 `Agent.snapshot()`：把 messages 数组格式化成 markdown，原始 tool 返回值
    不引入（噪声大且关键结论已在下一条 assistant 消息里被复述）。
  - 新增 `Agent.hasContent()`：reset 后只剩 system prompt 时返回 false。
  - 新增 config 字段 `digestCollection`（默认 `output`）。
  - 新增 `tests/agent-snapshot.test.ts`（9 用例）覆盖 reset / 多轮顺序 / tool_calls
    格式化 / 空 content 不产生空段 / raw tool 返回值不被引入。
- **Conversation 专用 hydration prompt（`CONVERSATION_SYSTEM_PROMPT`）。**
  早期 `/digest` 直接套用文档脱水的 `SYSTEM_PROMPT`，把对话当成单边材料压缩，
  导致用户视角丢失——例如"成长**和低谷期**"被笼统压成"成长经历"。修复：
  - 新增 `CONVERSATION_SYSTEM_PROMPT`，硬约束"PRESERVE THE QUESTION"——
    title / summary 必须反映用户问的角度而不是仅总结答案，多对比维度不能合并。
  - `content` 用 `## Q: <提问>` 段按原对话顺序排列，独立话题不混为一谈；
    `tags` 必须同时覆盖"用户问的角度"和"答案的领域"。
  - `HydrateInput` 新增 `mode?: 'document' | 'conversation'`（默认
    `'document'`），`/digest` 路径传 `'conversation'`，其它入库路径不变。
  - `tests/hydration-prompt.test.ts` 增加 9 个对话 prompt 不变量断言，
    其中一条把"成长和低谷期 → 成长经历"反例直接焊死。
- **transcript 默认目录挪进 wiki-data 树。** `outputDir` 默认从
  `<workspaceRoot>/output/` 改为 `<wikiRoot>/output/transcripts/`。和数字化
  的 wiki 条目共享同一棵树根，但子目录 `transcripts/` 屏蔽 `LibraryService` 的
  collection 扫描（scanAll 只读 `<wikiRoot>/<collection>/*.md` 一层）。
  这样 raw transcripts 和 `/digest` 产出的 entry 自然共生：前者在
  `<wikiRoot>/output/transcripts/`，后者在 `<wikiRoot>/output/<id>.md`。

- **REPL 自动 transcript：每 session 一份 markdown 落盘。** 默认开，
  路径为 `<workspaceRoot>/output/<ISO 时间戳>.md`。每个回合按时间顺序记录
  `User → tool call → tool result → Assistant`，工具参数与返回值原样保留，
  方便复盘 LLM 决策路径。同步 `appendFileSync` 落盘，REPL 异常退出（kill -9 /
  断电）也不丢内容；写失败吞掉一次 stderr 后静默，主流程不受影响。
  - 新增 `src/cli/transcript.ts`（`TranscriptLogger` + `deriveTranscriptPath`）。
  - 新增 config 字段 `outputDir`、`transcriptEnabled`，新增 `ensureOutputDir`。
  - 新增 CLI flag `chat --no-transcript`，新增 REPL slash 命令 `/transcript`
    显示当前 session 文件路径。
  - `tests/transcript.test.ts`（7 用例）覆盖文件名派生稳定性、写入顺序、
    markdown 转义（``` 不会提前关闭代码块）、错误吞掉。

- **REPL 启动时自动起队列 worker（idleBehavior=wait）。** 进 REPL 即拥有
  "聊天 + 队列消费" 双能力，单进程单事件循环，无子进程、无线程。组件 unmount
  时 abort 释放锁，worker 协程自然结束。锁被另一进程占着（用户开了 `queue run`）
  时降级为只读状态展示，不报错。
  - 新增 `runner.ts` 的 `idleBehavior: 'exit' | 'wait'` 选项 + `idlePollMs`。
    `'wait'` 模式下空闲不退出，定期重读 state 让外部新增 pending 被自动拾起。
  - 新增 `src/cli/QueueIndicator.tsx` 状态行，每 2s 轮询 `state.json` 显示
    `worker / external / off / error` 模式 + `pending / running / completed / dead` 计数。
  - 新增 config 字段 `queueAutoStart`，新增 CLI flag `chat --no-auto-queue`。
  - `tests/queue.runner.test.ts` 增加 `idleBehavior=wait` 集成测试，验证
    外部 mutate 入队后 worker 自动拾起。

- **持久化 ingest 队列。** 把"待 wiki 化的文件"做成跨进程持久化队列，
  支持任意时刻入队 / 查进度 / 异常重试。
  - **CLI 子命令族**：`queue add`（去重 enqueue，`deriveJobId = sha1(file|collection)`
    前 12 hex）、`status`（counts + running + dead + 最近 10 条事件，`--json`
    机器可读）、`run`（前台 worker，进程锁 + Ctrl-C 排干）、`clear`
    （`--completed | --dead | --all`）、`retry [ids...] | --all-dead`。
  - **REPL 工具**：`wiki_queue_add`（带读沙箱校验）、`wiki_queue_status`。
  - **状态机**：`pending → running → completed`，失败 `attempts++` 不到上限走
    `pending + nextEarliestRunAt`（退避 5s/30s/2min），到上限归档 `dead`。
    崩溃恢复在 worker 启动时把残留的 `running` 重置为 `pending`，attempts 不变。
  - **持久化**：`~/.llm-wiki/queue/state.json` 整文件 atomic write
    （`.tmp + rename`，仿 LibraryService.put），事件环形缓冲 cap 200 条。
  - **进程锁**：`state.json.lock` 含 pid + ISO ts，`fs.openSync(... 'wx')`
    原子创建；陈旧锁（`process.kill(pid, 0)` 探活失败）自动接管。
  - **每 job 独立 log**：`<queueLogDir>/<jobId>.log`，append-only，`tail -f` 友好。
  - **collection 级 snapshot**：每次成功 `library.put` 后刷新该 collection 的
    `linkCandidates / claimedIds`，长跑队列下保持新鲜，避免反链索引颠簸。
  - **共享底层逻辑**：把原 `batch.ts` 的 `processOne / claimUniqueId /
    formatResultLine / resolveSourcePath` 抽到 `src/wiki/queue/processJob.ts`，
    `runBatch` 与 `runQueue` 共用同一份单文件处理逻辑（`tests/batch.test.ts`
    全部 17 用例零回归）。
  - 新增 config 字段：`queueStatePath`、`queueLogDir`、`queueConcurrency`（默认
    `2`）、`queueMaxAttempts`（默认 `3`），新增 `ensureQueueDirs`。
  - 新增 5 个 queue 模块文件 + 1 个 CLI 命令文件 + 2 个 REPL 工具文件。
  - 新增 `tests/queue.state.test.ts`（16 用例）+ `tests/queue.runner.test.ts`
    （10 用例），覆盖：deriveJobId 稳定性、原子写、事件环形缓冲、进程锁
    + 陈旧锁接管、状态机全分支、并发、崩溃恢复、snapshot 刷新、id 冲突避让、
    AbortSignal 排干、退避闸门、idleBehavior=wait。

- **`.env` 配可读目录支持 JSON 数组语法 + `~/` 展开。** v0.2 早期版本只支持
  `path.delimiter` 分隔串（`/a:/b:/c`），现在 `LLM_WIKI_READ_PATHS` 还可以写成：
  ```
  LLM_WIKI_READ_PATHS=["~/notes", "~/research/papers"]
  ```
  自动判别：以 `[` 或 `{` 开头按 JSON 解析，对象/语法错误立刻抛错（不静默回退到分隔符模式）；
  否则按 `path.delimiter` 切分。两种语法都把 `~` 展开成用户 home 目录。
  `parseReadPathsFromEnv` 抽到 `src/config.ts` 命名导出，新增
  `tests/config.test.ts`（24 用例）覆盖两种语法、JSON 错误、空输入、`~` 展开等边界。
- **`ingest` 强制源文件位于读沙箱内。** 之前 `llm-wiki ingest --file /etc/passwd`
  能跳过 `read_file` 的沙箱直接读任意系统文件，这是个安全漏洞。现在单文件
  (`--file`)、glob (`--batch`)、目录 (`--dir`) 三种模式都把源路径走 `resolveSafePath`
  校验，必须落在 `workspaceRoot ∪ wikiRoot ∪ additionalReadPaths` 之内才进入
  hydration。批量模式下任一文件越界即整体 abort，提示用户先调整 `--read-path` /
  `LLM_WIKI_READ_PATHS`。
- **可配置的额外只读目录 `additionalReadPaths`。** 默认情况下 `read_file` /
  `list_dir` 工具只能访问 `workspaceRoot ∪ wikiRoot`。新增配置项允许把若干外部
  目录加入"只读白名单"，让 LLM 能查阅项目外的笔记 / 参考资料，但**不能修改**
  这些目录（`write_file` 仍只锁定在 workspace + wiki）。三种来源：
  - 全局 CLI flag `--read-path <dir>`（可重复）；
  - 环境变量 `LLM_WIKI_READ_PATHS`（多条用 `path.delimiter` 分隔）；
  - 配置文件 `~/.llm-wiki/config.json` 的 `additionalReadPaths` 字段。
  优先级：flag > env > 配置文件 > 默认 `[]`。所有路径经 `realpath` 归一化，
  符号链接逃逸仍会被拒绝。`tests/safety.test.ts` 增加 9 用例（21 → 30）覆盖
  扩展读、写仍被拒、symlink 逃逸、多条目录命中、空数组等边界。
- **批量 ingest：`--batch <glob>` 与 `--dir <folder>`。** v0.1 只能一次脱水
  一个文件，现在可以一次扫整个文件夹。
  - `--batch 'papers/**/*.md'` 用 fast-glob 语法，支持排除模式。
  - `--dir ./folder` 递归找该目录下所有 `.md`。
  - `--concurrency <n>` 控制并发（默认 3）；429 限流自动指数退避重试 ≤ 3 次。
  - `--force` 跳过"源路径已入库"的去重检查，强制重脱水覆盖。
  - 批内 id 冲突自动追加 `-2`、`-3` 后缀，不会静默覆盖。
  - 单条失败不影响其它文件；末尾汇总打印 `N ingested · M skipped · K failed`。
  - 兼容 v0.1 时代用相对路径写入的 `source.value`（双向归一化比较）。
  - 新增 `src/wiki/batch.ts` 编排器；hydrator 增加 `linkCandidates` /
    `filenameHint` 可选入参以支持批量场景的 snapshot 链接候选。
  - 新增 `tests/batch.test.ts`（17 用例），覆盖去重、id 冲突、429 重试、
    日志格式、退出码、snapshot 行为等。
  - 新增依赖 `fast-glob`。
- **REPL 命令历史记录与回溯。** 启动时从 `~/.llm-wiki/history` 加载最近 20 条
  命令，REPL 内按 ↑/↓ 浏览（↑ 进入更老，↓ 朝当前方向走，到底回到正在编辑
  的草稿）。提交（含 slash 命令）会即时追加到内存数组与磁盘文件。
  - 进入历史前自动暂存当前草稿，从历史回到 -1 时还原。
  - 修复 `ink-text-input` 已知行为：外部 setValue 不会自动把光标挪到末尾；
    用 `key={historyIndex}` 强制 remount，让光标在切换历史项时落在末尾。
  - 历史助手抽到独立模块 `src/cli/history.ts`，便于测试。
  - 新增 `tests/history.test.ts`（17 用例），覆盖 limit 截尾、UTF-8、IO 容错、
    跨会话 round-trip。
- `/help` 输出现在显示历史回溯按键说明。

### Fixed

- **REPL 终端闪烁修复。** v0.1 的 `ChatView` 把所有消息放在动态渲染区，
  Ink 的 `log-update` 在每次输入或新消息到达时都要清屏重绘整片区域，
  内容超过终端高度时表现为整屏闪烁。改用 Ink 的 `<Static>` 组件包裹
  已完成消息：渲染一次后写入 scrollback、永不重绘；只有 spinner 留在
  动态区。动态区面积始终保持几行，从根本上消除闪烁。
- **Hydration prompt: 语言漂移修复（#6）。** v0.1 的 system prompt 是英文且没有
  "保持源语言"约束，导致中文 README 经 ingest 后被翻译成英文（实际观察到
  `compressionRatio = 0.79` 且整篇英文化）。重写 prompt 加入：
  1. 显式 "SAME PRIMARY LANGUAGE as input" 规则；
  2. 硬性 400 词上限（CJK 内容按 ~600 汉字估算）；
  3. 明确的压缩比目标（稀疏源 ≤ 0.3，稠密源 ≤ 0.5）；
  4. id/tags 强制保持 kebab-case ASCII（不受输入语言影响）。
  - `SYSTEM_PROMPT` 现在是 `src/wiki/hydration.ts` 的命名导出。
  - 新增 `tests/hydration-prompt.test.ts`（9 用例），断言关键约束词不被回退掉。

### Tests

- 测试套件从 16 用例扩展到 87，覆盖范围加厚：
  - **library**：17 用例（+13），新增中文内容 round-trip、frontmatter Date 归一化、
    `compressionRatio` round-trip、孤儿链接索引、扫描器对格式错误文件的容错。
  - **assembler**：20 用例（+16），新增 tag/summary/content 权重对比、BFS 1 层边界
    （不会越界到 2 层）、多种子链接展开去重、context 渲染字段断言、中文 tokenize
    行为锁定（v0 已知局限：纯中文不可被检索）。
  - **safety**：21 用例（+13），新增 `..` 路径展开、嵌套子目录、深层不存在路径攀升
    realpath、`truncatePayload` 对 UTF-8 多字节字符的字节级截断验证。
  - **types**（新增）：29 用例覆盖 `EntrySchema` / `SourceSchema` / `HydrationOutputSchema`
    所有合法/非法输入边界，包含中文字段、kebab-case id 正则、必填校验、
    `compressionRatio` 范围。
- 所有测试用例均带详细中文注释，解释**测什么**与**为什么这么测**。


## [0.1.0] - 2026-04-28

首个脚手架版本。

### Added

- **Ink 富终端 REPL**：`App` / `ChatView` / `InputBox` / `ToolApproval` / `TokenMeter`
  组件，Ctrl+C 双击退出 + 单击取消在飞 LLM 调用，slash 命令 `/help` `/clear`
  `/reset` `/exit`，对话历史持久化到 `~/.llm-wiki/history`。
- **DeepSeek 工具调用循环**（`src/llm/agent.ts`）：OpenAI 风格 function calling，
  串行执行（p-queue），AbortController 注入，错误分类
  （auth / rate_limit / network / model_error / tool_error），429 指数退避自动重试 ≤2 次。
- **6 个 LLM 工具**：`read_file`、`write_file`（沙箱 + 审批）、`list_dir`、
  `wiki_ingest`、`wiki_get`、`wiki_query`。
- **Wiki 三件套核心服务**：
  - `HydrationService` —— 用 DeepSeek JSON 模式把原文压缩成 Entry。
  - `LibraryService` —— 文件 CRUD + 原子写 + 懒加载内存反链索引（正向链接落盘、
    反向计算）。
  - `ContextAssembler` —— tokenize + 加权评分（title × 2、tags × 2、summary × 1、
    content × 0.5）+ top-5 种子 + BFS 1 层链接展开 + token 预算拼接。
- **CLI 子命令**：`ingest --collection ... [--file|--url|stdin]`、`get <id>`、
  `list`、`query "..."`，与 LLM 工具共用同一份 `wiki/*` 实现。
- **路径沙箱**：`workspaceRoot ∪ wikiRoot` 的 realpath 校验，符号链接逃逸拒绝，
  写入审批（`y` / `a` / `n`），`--read-only` 全局禁写，工具回灌 100KB 截断。
- **分层配置**：CLI flag > env > `~/.llm-wiki/config.json` > 默认，zod 校验，
  启动时 fail-fast。
- **测试**：vitest 覆盖 `library` / `assembler` / `safety`，共 16 个用例。
- **文档**：[README](./README.md)、[PRD](./docs/PRD.md)、[架构](./docs/architecture.md)、
  [API](./docs/api.md)、[Roadmap](./docs/roadmap.md)、[PRD-issue](./docs/PRD-issue.md)。

### Known limitations

- 仅 DeepSeek（OpenAI 兼容接口），未抽象多 provider。
- 中文 tokenization 简单按 `\W+` 切分，对中英混合查询精度有限。
- 链接索引每次启动全量扫描，未持久化（适用于 < 1k entry）。
- `[[concept-id]]` 自动建链补全未实现。
- 没有 HTTP REST 接口。

[Unreleased]: https://github.com/l-zhi/llm-wiki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/l-zhi/llm-wiki/releases/tag/v0.1.0
