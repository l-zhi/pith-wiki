pith-wiki 首个非预发布版本，重点改进原文检索与终端阅读体验。本版本通过 npm 分发 CLI，不提供桌面安装包。

## 新增与改进

- 新增 `wiki_grep` 精确子串与正则检索，优先搜索原始资料；原文不可读时回退到整理后的内容，并标明实际搜索来源。([#37](https://github.com/l-zhi/pith-wiki/pull/37))
- REPL 支持 Markdown 正文渲染，包括表格、链接与文本样式。([#36](https://github.com/l-zhi/pith-wiki/pull/36))
- 支持通过 `@文件`、`@集合/` 限定本轮检索范围。([#35](https://github.com/l-zhi/pith-wiki/pull/35))
- 分层展示正文、工具过程与思考信息，并以单行动态状态显示执行进度。([#34](https://github.com/l-zhi/pith-wiki/pull/34))

## 修复

- 支持按 provider 配置 JSON 模式能力，显示失败队列任务的具体错误，并隔离开发环境数据。([#32](https://github.com/l-zhi/pith-wiki/pull/32))

## 安装此版本

```bash
npm install -g pith-wiki@0.2.0
```

完整变更：[v0.2.0-beta.0…v0.2.0](https://github.com/l-zhi/pith-wiki/compare/v0.2.0-beta.0...v0.2.0)。
