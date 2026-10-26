# macOS 签名、公证与发布

桌面发布使用 Developer ID Application 签名，并向苹果提交公证。完成公证的安装包仍可能有 macOS 正常的首次下载确认，但用户无需通过 `xattr` 移除隔离属性。旧版未签名安装包不会自动改变。

## 凭据

在仓库 Settings → Secrets and variables → Actions → Repository secrets 配置：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | 包含证书及私钥的 `.p12` 文件的 Base64 文本 |
| `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | 苹果开发者账户邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 账户中生成的 App 专用密码 |
| `APPLE_TEAM_ID` | 证书所属团队的 10 位 Team ID |

凭据仅注入 macOS 构建步骤；Windows 不使用苹果证书。不要把 `.p12`、密码或 Base64 文本提交到仓库。修改 Apple 账户主密码会撤销 App 专用密码，届时需更新对应 Secret。

## 合并前验证

进入 GitHub Actions → release → Run workflow，选择待验证分支，保持 **publish=false**。此流程会使用真实凭据签名、公证并校验，成功后保留 7 天的 Actions artifacts，不创建 GitHub Release。

```bash
gh workflow run release.yml --ref <待验证分支> -f publish=false
```

流程包括：

1. 检查五项凭据非空，签名发现未被禁用。
2. 为 arm64、x64 应用及其嵌套代码执行 Developer ID 签名，启用 Hardened Runtime 和 Electron 所需的 `allow-jit` entitlement。
3. electron-builder 提交应用公证并附加票据，再生成 ZIP 和已签名 DMG。
4. 单独提交两个 DMG 公证并附加票据。
5. 分别解压 ZIP、只读挂载 DMG，校验其中的应用：严格签名验证、Team ID、时间戳、Hardened Runtime、版本、CPU 架构、公证票据及 Gatekeeper。DMG 容器也执行签名、票据和 Gatekeeper 校验。
6. 全部通过后计算 `macos-SHA256SUMS.txt`，上传最终安装包。DMG 不生成 updater 元数据，避免附加票据后原哈希失效；ZIP 的 updater 元数据保留。

首次公证可能较慢。单个 DMG 的等待上限为 30 分钟，整个构建上限为 120 分钟。超时或被拒绝时不会发布；可从日志中的 submission ID 在苹果公证服务查询详情。仅配置了 Secret 名称并不代表凭据已验证。

如果构建长时间没有新日志，可单独运行只读诊断，不必取消构建或重新上传安装包：

```bash
gh workflow run release.yml --ref <待验证分支> -f notary_status=true
```

也可在 Run workflow 中勾选 **notary_status**。此模式跳过构建和发布，只用三项 `APPLE_*` 凭据查询最近 10 次公证提交；不读取签名私钥，且与正在运行的打包任务互不阻塞。查询成功说明苹果认证通过；`In Progress` 表示苹果尚未给出最终结果，`Accepted` 才表示该次公证通过。认证失败时按错误信息核对邮箱、App 专用密码和 Team ID，不要重复提交相同安装包来尝试修复凭据。

## 正式发布

合并后更新 `desktop/package.json` 与对应锁文件的版本，编写 `docs/release-v<版本>.md`，推送匹配的 `v<版本>` tag。发布日志缺失或为空会阻止正式构建。也可以在该版本 tag 上手动运行并设置 **publish=true**；分支不能用于正式发布。已有公开 Release 不会被覆盖。

所有平台构建成功后，独立发布任务才创建草稿 Release、上传验证过的同一批文件并公开，设为 Latest。标题统一为 `pith v<版本>`，正文使用对应的版本日志，不再自动拼接提交标题。任何签名、公证、校验或上传失败都会阻止发布；上传失败可能留下草稿，重跑时可补传。本流程用于稳定版发布；预发布版本应单独配置 prerelease 与 Latest 策略。

历史版本的标题和正文可按对应 `docs/release-v*.md` 同步，保留标签、安装包及预发布标记。不要重命名历史安装包或用新包覆盖旧版本；签名、公证或应用代码发生变化时发布新的版本号。

发布前应从 Actions artifacts 或浏览器下载的新包在另一台 Mac 上安装，确认未执行 `xattr` 也能打开；分别验证 Apple Silicon 和 Intel Mac 的界面及 Engine 启动。命令行校验通过不能代替实机启动测试。

## 本地构建

`npm run pack` / `npm run dist` 保留原来的未签名开发构建行为。`npm run dist:mac:release` 使用独立发布配置，要求在装有 Xcode 工具的 Mac 上提供上述环境变量；该命令仅构建和验证，不会上传 GitHub Release。

打包器固定为 electron-builder 26.16.1。旧版 25.1.8 将 `.p12` 密码误用为临时钥匙串密码，在新的 macOS runner 上会报 `SecKeychainUnlock`；26.16.1 包含[上游修复](https://github.com/electron-userland/electron-builder/pull/10172)。不要仅因此错误就重置用户的证书或密码。

## 参考

- [Electron 公证与 entitlement 要求](https://github.com/electron/notarize#prerequisites)
- [electron-builder 签名配置](https://www.electron.build/v26/docs/features/code-signing/)
- [苹果 App 专用密码](https://support.apple.com/en-us/102654)
