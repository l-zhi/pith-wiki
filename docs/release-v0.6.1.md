本次维护更新修复 macOS 桌面端的 CLI 发现问题，并首次提供经过 Developer ID 签名及苹果公证的正式 macOS 安装包。

## 修复

- 从 Finder 启动 pith 时，自动读取用户终端 PATH 中的 npm、Node 等环境，并补充 Homebrew 等常见安装目录，修复已安装 `lark-cli` 等命令仍提示找不到的问题。
- 在 pith 运行期间安装 CLI 后，点击技能的“测试连接”即可重新检测，并同步更新依赖状态；已有聊天的后续调用立即使用新的命令环境，无需重启应用。
- 依赖检测、连接测试及实际命令执行使用一致的查找规则；刷新 PATH 时保留原有凭据隔离，并改善命令缺失、运行环境及认证错误的提示。

## 安装与分发

- Apple Silicon 和 Intel Mac 的应用及 DMG 均经过 Developer ID 签名、苹果公证和票据附加。正常安装无需执行删除 quarantine 的命令；首次启动仍可能出现“从互联网下载”的正常确认。
- 发布前自动验证四个 macOS 包中的签名、版本、架构、公证票据与 Gatekeeper 评估；全部平台构建成功后才公开安装包。
- 提供最终 macOS 文件的 SHA-256 校验清单，避免将旧的未签名 v0.6.0 包误认为本次发布。

## 下载

| 平台 | 安装包 |
| --- | --- |
| macOS · Apple Silicon（M 系列） | [pith-0.6.1-arm64.dmg](https://github.com/l-zhi/pith-wiki/releases/download/v0.6.1/pith-0.6.1-arm64.dmg) |
| macOS · Intel | [pith-0.6.1-x64.dmg](https://github.com/l-zhi/pith-wiki/releases/download/v0.6.1/pith-0.6.1-x64.dmg) |
| Windows · x64 | [pith-Setup-0.6.1.exe](https://github.com/l-zhi/pith-wiki/releases/download/v0.6.1/pith-Setup-0.6.1.exe) |

macOS ZIP 包、更新元数据及 [SHA-256 校验清单](https://github.com/l-zhi/pith-wiki/releases/download/v0.6.1/macos-SHA256SUMS.txt) 见下方 Assets。Windows 安装包尚未配置代码签名，可能出现 SmartScreen 提示。

## 升级说明

退出旧版 pith 后安装并替换应用即可，无需删除知识库、配置或聊天数据。CLI 的安装与登录仍需由用户完成；未加入 PATH 的自定义安装目录可能需要手动配置。苹果签名与公证仅适用于本次及后续按同一流程发布的安装包，旧版本不会自动获得签名。

完整变更：[v0.6.0…v0.6.1](https://github.com/l-zhi/pith-wiki/compare/v0.6.0...v0.6.1) · 相关改动：[CLI 路径修复 #59](https://github.com/l-zhi/pith-wiki/pull/59)、[macOS 签名与公证 #60](https://github.com/l-zhi/pith-wiki/pull/60)。
