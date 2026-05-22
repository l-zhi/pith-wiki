# Windows 标 best-effort，CI 不强制覆盖

**状态**：accepted（2026-05-22）

## 背景

项目核心代码有多处依赖**非 Linux 的 fs 行为**，其中 Windows 与 POSIX 系统语义差异最大：

| 位置 | Windows 行为 |
|---|---|
| `LibraryService` 的原子写（`.tmp + rename`） | Windows `rename` 在目标存在时抛 EEXIST，需要先 unlink 或用 `fs.renameSync` 的不同语义 |
| watcher（chokidar） | Windows 默认走 polling fallback，事件模型与 inotify / FSEvents 不同 |
| `path.delimiter` 用于解析 `LLM_WIKI_READ_PATHS` | Windows 是 `;`，POSIX 是 `:` |
| 文件名大小写敏感性 | Windows NTFS 默认 case-insensitive，影响 entry id 冲突检测 |
| 路径分隔符 | `\` vs `/`；现有代码用 `path.join` 但 string match 可能漏 |

完整的 Windows 支持估计需要 1-3 天工作量，且需要 Windows 测试机或 GitHub Actions Windows runner 持续验证。

作者本人不在 Windows 上开发，没有动力先做预防性修复。

## 决定

CI 矩阵首发只跑 `ubuntu-latest` + `macos-latest`，**不加 `windows-latest`**。

README 与 docs/quickstart.md 明确标注：

> **Platform support**：Linux / macOS 一类支持。Windows 二类（best-effort，PRs welcome）。

Windows 相关 bug 接受 issue 上报，但不阻塞首发，不进 release-blocker 标签。

## 为什么

1. **作者无 Windows 主机**：没法本地验证修复是否真的可用
2. **CI runner 不能替代真实使用**：跑测试通过不等于交互式 CLI 在 Windows Terminal / cmd / PowerShell 里体验良好
3. **不预修不可见 bug**：哪些路径在 Windows 上真的坏、哪些其实可用，要等真实用户报上来
4. **OSS 社区可以补**：Windows 修复是典型的 "good first issue" 类工作；交给有 Windows 主机的贡献者更合适

## 后果

- **Windows 用户首发体验未知**：可能能跑（POSIX 兼容路径多）、可能崩；不投资预测
- **未来贡献者警示**：如果某天 Windows 测试集中失败、且 CI 上跑了 `windows-latest`，**不要默默把 Windows 从矩阵里删掉**。要么修，要么开 issue 标 `platform-windows` + `help wanted`
- **可逆性**：将来如有 Windows 用户群 + 持续贡献者，可以加回 `windows-latest` 矩阵并补完平台特异性修复；ADR-0003 届时标 superseded
