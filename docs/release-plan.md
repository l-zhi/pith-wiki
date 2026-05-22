# 开源首发准备计划（v0.3.0）

> 这份文档是开源准备期的 single source of truth。所有 A/B/C 档工作项都会拆成
> GitHub issue 跟踪；本文件只保留决策摘要 + 总览，不写实现细节。
>
> **状态**：草案完成，待开始执行。
> **目标版本**：v0.3.0（首个公开发布版）。
> **最近更新**：2026-05-22。
> **关联**：[ADR-0001](./adr/0001-cli-only-no-library-mode.md) · [ADR-0002](./adr/0002-issue-driven-roadmap.md) · [ADR-0003](./adr/0003-windows-best-effort.md)

---

## 0. 第一性原则

开源**首发**和**持续迭代**是两件不同的事。首发只决定一件事：**陌生人 5 分钟内是不是相信这个项目能用**。

- ✅ 卡的不是功能完整度，是"信任感"：文档清楚、CI 绿、能跑起来、贡献流程明确
- ❌ 不卡的是功能丰满度：OSS 是反馈循环的开始，不是终点；缺失功能交给 issue 驱动

所有 scope 决定都按这条切。

---

## 1. 决策摘要（Q1-Q7）

通过 `/grill-with-docs` 走了 7 轮 grill，结论如下：

| 题 | 决定 | 理由 |
|---|---|---|
| **Q1 doctor 进首发？** | 进，列为 A11 | 信任感工具；首发不带，第一个 issue 大概率是 "entry 报错被静默跳过" |
| **Q2 doctor 形态？** | report-only + `--json`，`--fix` 推后 | 自动 fix 破坏"文件就是文件"的契约；fix 策略要 PRD 才能想清楚 |
| **Q3 README 语言？** | 英文 TL;DR + 中文主文 | 兼顾国际可见度 + 维护成本；演进式英文化 |
| **Q4 Demo 内容？** | 脱水压缩比（GIF）+ query 输出（GIF）二连 | 突出"LLM 把垃圾压成精华"的核心论点；不演 chat agent |
| **Q5 后续 roadmap？** | 三栏：Likely next / Maybe someday / 不做 | solo dev 不承诺时间表；按 issue +1 排优先级 → [ADR-0002](./adr/0002-issue-driven-roadmap.md) |
| **Q6 CI 矩阵？** | ubuntu + macos，Windows 标 best-effort | macOS 是作者主开发环境，必须进；Windows 留给社区贡献 → [ADR-0003](./adr/0003-windows-best-effort.md) |
| **Q7 SECURITY 政策？** | GHSA 主 + 邮箱备 + best-effort，不承诺 SLA | solo dev 承诺 SLA 必翻车；GHSA 是 OSS 标准 |

加上更早达成的一个：

| 题 | 决定 | 理由 |
|---|---|---|
| **CLI-only** | 放弃 npm 库出口，单一 CLI 包 | 库用户被迫拖入 ink/react/commander 等 ~20MB 无用依赖；先发 CLI，库模式留给真实需求 → [ADR-0001](./adr/0001-cli-only-no-library-mode.md) |

---

## 2. 工作清单（11 + 5 + 3 项）

### A 档 阻塞项（不做不能发）

| # | 项 | 说明 |
|---|---|---|
| A1 | 修测试隔离 | [tests/config.test.ts:353](../tests/config.test.ts:353) 现在会读真实 `~/.pith-wiki/config.json`，外部 clone 立即红；引入 `PITH_WIKI_CONFIG_PATH` env 或 `configPath` 显式参数 |
| A2 | CI 加 `macos-latest` | 修 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 的 matrix；跑了之后看实际暴露什么 bug 再决定是否阻塞首发 |
| A3 | `CONTRIBUTING.md` | Node 版本 / `npm install` / 测试命令 / commit 风格（conventional commits）/ PR 流程 |
| A4 | `SECURITY.md` | 按 Q7 草稿；GHSA + 邮箱备用 + best-effort；明确列出 scope 与 out-of-scope |
| A5 | `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 标准模板 |
| A6 | issue + PR 模板 | `.github/ISSUE_TEMPLATE/`：bug / feature / question；`.github/pull_request_template.md` minimal |
| A7 | LICENSE 作者改真名 | **TBD：填什么名字** |
| A8 | `docs/roadmap.md` 重写 | 按 Q5 三栏结构；删除原 v0.2/v0.3 计划（已变现实） |
| A9 | `CHANGELOG.md` 收拢 | `[Unreleased]` 整块归到 0.3.0；按 Added / Changed / Fixed 整理；摘要不留实现细节 |
| A10 | 提交 main 上 4 个未 commit 文件 | hydration.ts / queue/processJob.ts / queue/runner.ts / converters/builtin/eml.ts；先 review 一遍 |
| A11 | 实现 `pith-wiki doctor` | 5 类检查 + `--json` + 非零 exit code（具体规格写在对应 issue 里） |

### B 档 第一印象（不做能发但冷场）

| # | 项 | 说明 |
|---|---|---|
| B1 | README 顶部 demo GIF | 两段：脱水压缩比 + query 输出；工具推荐 `vhs` 或 `asciinema + agg` |
| B2 | README 英文 TL;DR | ~80 字英文 hook + 一行 "中文完整文档见下"；**TBD：措辞** |
| B3 | `docs/config.example.json` | 完整多 provider 示例；每个字段加注释 |
| B4 | `docs/quickstart.md` | 5 分钟从 0 到第一条 entry；≤ 100 行 |
| B5 | `docs/security-model.md` | 沙箱不变量、审批流、威胁面；~80 行；保护后续重构 |

### C 档 工程氛围（不做也能发但 PR 来了会乱）

| # | 项 | 说明 |
|---|---|---|
| C1 | ESLint + Prettier | `@typescript-eslint/recommended` + `prettier` plugin；`.prettierrc` 跟现有风格对齐（`singleQuote: true, semi: true`） |
| C2 | `.editorconfig` + `.nvmrc` | `.nvmrc` 写 `20`；editorconfig 标准 |
| C3 | `scripts/migrate-*` 整理 | 三个一次性脚本挪到 `scripts/migrations/`；加 README 说明哪些已过期 |

### 推后到首发后（明确写在 roadmap.md 的 Likely next）

| # | 项 | 原 roadmap 阶段 |
|---|---|---|
| D1 | URL 抓取（`--url` 真发 HTTP + readability） | 老 v0.3 |
| D3 | `pith-wiki update <id>`（重脱水保留 backlink） | 老 v0.3 |
| D4 | `pith-wiki rename <old> <new>`（同步引用） | 老 v0.3 |
| D5 | `[[concept-id]]` 自动建链补全 | 老 v0.2 |
| D6 | `/save` `/load` 会话 | 老 v0.2 |
| D2.5 | `doctor --fix` 自动修复 | 来自 Q2 推后 |

### 推后到中长期（明确写在 roadmap.md 的 Maybe someday）

| # | 项 | 原 roadmap 阶段 |
|---|---|---|
| E1 | HTTP REST 接口 | 老 v1.0 |
| E2 | BM25 评分模式 | 老 v1.0 |
| E3 | 同义词字典 | 老 v1.0 |
| E4 | embedding 混合检索（可选） | 老 v2.0 |
| E5 | Web UI（只做查看器） | 老 v2.0 |
| E6 | 团队协作 / Git 后端 | 老 v2.0 |

---

## 3. 执行顺序（推荐 1 周全职）

```
Day 1-2:  A1 → A10 → A2          清干净 baseline + 跑 macOS CI 看暴露什么
Day 3:    A11 doctor              唯一的新代码
Day 4-5:  A3 A4 A5 A6 A7 A8 A9   社区文件全套 + roadmap/CHANGELOG 重写
Day 6:    B2 B3 B4 B5             英文 TL;DR + config 示例 + quickstart + security model
Day 7:    C1 C2 C3 + B1 demo     lint 配齐 + 最后录 GIF（留到最终态再录）
Day 8:    🚀 发布 v0.3.0
```

GIF 必须放在最后录 —— 录早了之后任何 UI 改动都得重录。

---

## 4. 未决的 TBD

需要在执行前填的三个具体信息：

1. **A7 LICENSE 真名** —— 现在写的是 GitHub handle `l-zhi`，git config 里是 `lizhi fan`。要保留哪个？还是另起一个？
2. **A4 SECURITY.md 收件邮箱** —— 建议起一个专用邮箱（如 `security@<你的域名>` 或 `<前缀>+pith-wiki.security@gmail.com`），不要混工作 / 私邮
3. **B2 英文 TL;DR 措辞** —— 草案见下，可以改：

   ```
   A terminal-native LLM wiki, Karpathy-style: don't shove raw docs into a vector DB
   and pray. Hydrate them into dense Markdown entries; retrieve by keyword + link
   traversal. Local, file-based, works with any LLM endpoint.

   > 中文完整文档见下方。 README in Chinese below.
   ```

---

## 5. 跟踪机制

- **issues**：A1-A11 / B1-B5 / C1-C3 各自一个 GitHub issue，贴标签 `release-blocker` / `release-polish` / `eng-quality`
- **milestone**：`v0.3.0` 在 GitHub 上创建 milestone，所有 issue 挂上去
- **本文档**：完成的项打 ✓，剩余未决的 TBD 实时更新；不删完成项（保留决策回溯）

---

## 6. 不在本次首发范围

明确**不做**（避免 scope creep）：

- 任何老 roadmap 里写的 D / E 类功能（推迟到首发后，按 issue 驱动）
- HTTP REST 接口（E1，留给真实需求）
- embedding（E4，明确与项目哲学冲突）
- Web UI（E5，明确不取代 CLI）
- Windows 完整支持（在 [ADR-0003](./adr/0003-windows-best-effort.md) 里说明）
- 全面英文化（保留中文 docs，仅做英文 TL;DR）
- 完整的 release 自动化（changesets / release-please，首发后再加）
