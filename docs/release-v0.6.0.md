# pith v0.6.0

本次桌面端发布包含 v0.5.0 之后合入主分支的更新。

## 新增与改进

- 接入 Codex CLI 和 pi CLI 委托型 provider；CLI 也可使用 Codex。
- 新增可选的 pi-ai 传输层和 pi-agent-core 对话实现，默认仍使用 pith agent。
- Provider 设置支持 reasoning effort 和 verbosity；委托型 CLI 的鉴权与额度错误提供更明确的处理提示。
- 定时任务产物按任务目录归档，并进入 Wiki 检索；桌面端支持查看任务产物。
- 新增文件夹逐层浏览、子文件夹检索范围、`@` 引用选择器，以及集合右键打开文件夹。
- 技能支持“测试连接”；微信读书增加 MCP gateway 工具，改进 Claude Code 对飞书和微信读书工具的调用。
- 新增可折叠通知中心、源码安装指南和 CLI Docker 构建配置。

## 修复

- 桌面安装包包含内置技能资源，支持离线安装微信读书技能。
- Codex 子进程启动失败或被取消时正确处理错误，避免 Engine 因未捕获的进程错误退出。
- 归一化 frontmatter 日期，避免条目因日期解析失败而从索引中消失。
- 入库前移除 data URI 图片并限制超长内容，减少模型请求超限。
- `@` 引用选择器显示全部文件夹，移除此前的八项上限。

## 下载与运行

- Apple Silicon Mac：`pith-0.6.0-arm64.dmg` 或 `pith-0.6.0-arm64-mac.zip`。
- Intel Mac：`pith-0.6.0.dmg` 或 `pith-0.6.0-mac.zip`。
- Windows x64：`pith-Setup-0.6.0.exe`。

安装包沿用项目现有的未签名发布方式。委托型 provider 仍需自行安装并登录对应 CLI；定时任务仅在桌面应用运行时触发，并按配置补跑错过的任务。

完整变更：[v0.5.0...v0.6.0](https://github.com/l-zhi/pith-wiki/compare/v0.5.0...v0.6.0)。
