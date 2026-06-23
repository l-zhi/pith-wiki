---
name: lark
description: 飞书 lark-cli 助手 — 通过 lark-cli 操作飞书：发消息、查日程、建任务、读写云文档/多维表格/知识库、查会议纪要等
commands:
  - lark-cli
requires:
  - bin: lark-cli
    install: npx @larksuite/cli@latest install
---

# 飞书（lark-cli）

通过本机已安装的 `lark-cli` 操作飞书。所有动作都用 `run_command` 调用 `lark-cli`。

## 前置条件（用户已在终端完成）

1. 安装：`npx @larksuite/cli@latest install`（装好后 `lark-cli` 在 PATH 上）。
2. 认证：`lark-cli auth login`（交互式登录，凭据由 lark-cli 自存）。

**重要**：`run_command` 是非交互沙箱（无 stdin），所以：

- 不要尝试运行需要交互输入的命令（如 `lark-cli auth login`）——那必须用户自己在终端做。若命令报“未认证 / not authenticated”，请明确告诉用户去终端执行 `lark-cli auth login`，而不是自己重试。
- 一切参数都用命令行 flag 传齐，不要依赖运行中的提问。

## 用法

不确定子命令或参数时，**先自查帮助**再执行：

```
lark-cli --help
lark-cli <子命令> --help
```

常见能力（具体子命令以 `--help` 为准）：消息（im）、日历/日程（calendar）、任务（task）、云文档（docx）、电子表格（sheets）、多维表格（base）、知识库（wiki）、云空间（drive）、会议与妙记（vc / minutes）、通讯录（contact，按姓名/邮箱解析 open_id）。

## 约定

- 涉及人名时，先用通讯录把姓名解析成 open_id，再发消息 / 加群 / 排日程。
- 输出里出现 open_id 时，回显给用户前尽量换成姓名。
- 多身份（个人/机器人）用 `--as` 切换。
- 命令失败先看 stderr：认证类问题指向重新 `auth login`；权限/scope 问题如实告知用户，不要反复重试。
- 执行有副作用的操作（发消息、建日程、改文档）前，向用户复述将要做什么。
