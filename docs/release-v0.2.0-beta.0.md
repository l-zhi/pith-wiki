pith-wiki 首个公开发布至 npm 的测试版，用于验证 CLI 初始化与个人知识库工作流。本版本不提供桌面安装包。

## 新增与改进

- `pith-wiki init` 支持交互式选择 provider、设置 API Key 和自动监控目录，也提供对应命令行参数。
- 支持通过 `PITH_WIKI_HOME` 指定配置、知识库、队列及会话记录的位置，便于隔离开发和日常使用环境。
- 提供中英文 README、快速上手、使用指南、REPL 工作流及配置文档。
- 增加发布前检查，覆盖测试、类型检查、构建、打包及隔离安装后的版本号验证。

## 安装此版本

```bash
npm install -g pith-wiki@0.2.0-beta.0
pith-wiki init
```

## 已知限制

这是历史预发布版本，当时未覆盖 Windows CI；配置格式及功能与当前版本存在差异。新用户建议使用[最新版本](https://github.com/l-zhi/pith-wiki/releases/latest)。

版本源码：[v0.2.0-beta.0](https://github.com/l-zhi/pith-wiki/tree/v0.2.0-beta.0) · [问题反馈](https://github.com/l-zhi/pith-wiki/issues)。
