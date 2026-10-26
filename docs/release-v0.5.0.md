本次桌面端更新引入输出复核模式、Claude Code 对话支持和可直接打开的文件产物，并改进模型及凭据配置。

> 历史版本：macOS 安装包未采用 Developer ID 签名与苹果公证流程。新安装建议使用 [最新版本](https://github.com/l-zhi/pith-wiki/releases/latest)。

## 新增与改进

- 新增“生成 → 复核 → 修订”的输出复核模式，可用于聊天及定时任务，并支持独立选择复核模型。
- 支持在设置中编辑 `SOUL.md` 和 `REVIEW.md`，配置助手行为与复核标准。
- 支持将 Claude Code 作为聊天 provider，并改进 provider 选择与配置体验。
- 文件产物支持直接打开和“在 Finder 中显示”；优化来源引用、模型标识、上下文用量及产物列表刷新。
- 支持为文档整理与输出复核分别指定 provider；凭据统一保存至 `config.json` 的 `secrets`，替代 `.env`。
- 项目许可证调整为 Apache-2.0。

## 修复

- 修复 Claude Code 工具结果被显示为“空结果”的问题。
- 修复退出时窗口已销毁导致的错误，避免关闭过程中重新启动 Engine。
- 改善聊天、复核模式及编辑器的错误提示，减少静默失败与白屏。

## 下载与兼容性

下方 Assets 提供 Apple Silicon Mac、Intel Mac 和 Windows x64 安装包。使用 Claude Code 前需自行安装并登录对应 CLI；定时任务仅在桌面应用运行期间触发。

完整变更：[v0.4.0…v0.5.0](https://github.com/l-zhi/pith-wiki/compare/v0.4.0...v0.5.0)。
