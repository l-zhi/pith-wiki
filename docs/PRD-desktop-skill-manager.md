# PRD — 桌面端「技能」管理页

状态：设计已定稿（grill 共识），待实现。
范围：`@pith/desktop`（`desktop/`）。日期：2026-06-13。

## 背景 / 问题

桌面端**能用**已安装的 skill（引擎启动时 `buildSkillRegistry` 装配，`agentFactory` 挂载 `makeSkillTool`/`run_command`/`http_request`，见 `desktop/src/engine/bootstrap.ts:117,180`），但**没有任何安装/管理入口**：协议层无 `skill.*` 请求，渲染层零 skill UI。用户要装 skill 只能手动拷目录到 `skillDirs` + 重启。

目标：在桌面端加一个「技能」页，展示策展好的 bundled 建议清单与安装状态，一键安装（复制 bundled → 正式 skill 目录），并为需要 appkey 的 skill（如 weread）就地配置密钥。

## 关键事实（实现依据）

- **Bundled 机制**：`src/skills/bundled.ts` 的 `listBundledSkills()`/`resolveBundledSkill()` 扫 `<packageRoot>/bundled-skills/`；当前仅 `weread`（`http_allow: i.weread.qq.com` + `auth_env: WEREAD_API_KEY`）。
- **安装**：`src/skills/install.ts` `installSkillFromSource(source, config)` 解析顺序 git → bundled → 本地路径，复制到 `config.skillDirs[0]`（默认 `~/.pith-wiki/skills`），返回 `InstallResult{ skill, dest, source, missingRequires, missingEnv }`。`removeSkillByName(name, config)` 删 skillDirs 下直接子目录。
- **appkey 读取**：`src/tools/http_request.ts:75` **仅**在调用时读 `process.env[auth_env]`，不经 config.json。
- **.env 一次性加载坑**：`src/config.ts:17` `loadDotenvOnce()` 有模块级 `dotenvLoaded` 标志 → 进程内只读一次 `.env`。所以「写 .env + 重建 services」在同进程内**读不到**新 key；必须直接写 `process.env`。
- **settings 保存生效模式**：`desktop/src/engine/bootstrap.ts:637` `settings.save` → 全量 `initServices()` 重建 + 发 `engine.ready` → 渲染层重新 bootstrap（当前会话被重置）。

## 决策（10 条）

1. **三层全做**：协议 + 引擎 + UI，复用 `installSkillFromSource`/`removeSkillByName`/`listBundledSkills`。
2. **建议列表数据驱动**：`listBundledSkills()` 动态渲染，不硬编码；当前仅 weread。
3. **appkey 存储/生效**：upsert 写 `~/.pith-wiki/.env`（权威密钥位置、不进 config.json）+ 直接设引擎进程 `process.env[key]` → **即时生效、不重建、不丢会话**。下次启动靠 .env 恢复。
4. **安装/卸载重建**：复用 `settings.save` 的全量 `initServices()` + `engine.ready`（**重置当前会话**，与切 provider 一致）。配 key 不重建。
5. **UI 位置**：侧边栏新增顶级页面「技能」。
6. **列表范围**：仅 bundled 建议清单 + 状态（已安装 / 待安装）。
7. **key 交互**：卡片**内联**，缺失高亮；掩码显示（`已配置 ab…wxyz` / `未配置`），可编辑/清除，绝不回显明文。
8. **卸载**：支持（带确认），**保留** `.env` 里的 key。
9. **key 校验**：v1 不做（无通用健康检查端点，错了在调用时报错）。
10. **来源限制**：仅 bundled；不做通用路径/Git 安装、不做 `commands`/`requires` 授权提示 UI（weread 用不到，留待出现需要的 bundled skill 再加）。

## 实现面

### 协议层（`desktop/src/shared/protocol.ts`，EngineRequest 并集 :179）

新增请求 + DTO：

```ts
// 请求
| { kind: 'skills.list' }
| { kind: 'skills.install'; name: string }
| { kind: 'skills.remove'; name: string }
| { kind: 'skills.setEnv'; key: string; value: string }   // value 空串 = 清除

// DTO
interface SkillEnvDTO { name: string; set: boolean }       // auth_env 名 + process.env 是否已设
interface SkillCardDTO {
  name: string;
  description: string;
  installed: boolean;        // registry 中是否有同名
  requiredEnv: SkillEnvDTO[]; // 来自 httpAllow[].auth_env（已装读 registry；未装读 bundled SKILL.md）
}
interface SkillsDTO { skills: SkillCardDTO[] }
```

### 引擎层（`desktop/src/engine/bootstrap.ts`，`handle()` switch :332）

- `skills.list`：合并「`skillRegistry.list()` 已装项」与「`listBundledSkills()` 未装项」，按 name 去重；`requiredEnv` 由 `skill.httpAllow[].auth_env` 解析、`set = !!process.env[name]`。
- `skills.install`：`installSkillFromSource(name, config)` → 全量重建（抽出 `settings.save` 的 stop→initServices→`engine.ready` 逻辑复用）。
- `skills.remove`：`removeSkillByName(name, config)` → 全量重建。
- `skills.setEnv`：新增 `.env` upsert helper（读 `~/.pith-wiki/.env` 行、替换或追加 `KEY=value`、空值则删除该行）+ `process.env[key] = value`（空则 `delete`）。**不重建**。

### 渲染层（`desktop/src/renderer/`）

- `Nav` 加 `'skills'`（`store.ts:46`）；路由 `App.tsx:53`；Sidebar 导航项 `Sidebar.tsx:98`（图标 `Blocks`/`Puzzle`）。
- i18n：`nav.skills`（zh『技能』/ en『Skills』）+ 页面文案（安装/卸载/已安装/待安装/配置 appkey/已配置/未配置 等）。
- store：`loadSkills()`（`bridge.request<SkillsDTO>({kind:'skills.list'})`）、`installSkill/removeSkill/setSkillEnv`；`setNav` 里 `nav==='skills'` 触发 `loadSkills`（`store.ts:162`）。安装/卸载后 engine 发 `engine.ready` → 自动重新 bootstrap + reload。
- `views/Skills.tsx`：卡片网格。每卡 = 名称 + 描述 + 状态徽章（已安装/待安装）+ 安装(待装)/卸载(已装,确认) 按钮 + 已装且 `requiredEnv` 含未配置项时**内联高亮**掩码 key 输入（保存调 `skills.setEnv`，乐观刷新或重拉 list）。

## 非目标（v1）

- 通用「从本地路径 / Git owner-repo 安装」入口。
- `commands`（run_command 授权提示）/ `requires`（缺失依赖探测提示）UI。
- key 有效性在线校验 / 「测试连接」。
- 管理已装的非 bundled skill（如 lark-*）。

以上都因数据/引擎能力已就位而易于后续扩展。

## 验收

- 「技能」页列出 weread，状态正确（已装/待装）。
- 点安装 → weread 复制进 `~/.pith-wiki/skills/weread`，引擎重建后该 skill 在新会话可用。
- 未配 key 时卡片高亮提示；填入 `WEREAD_API_KEY` 保存后**无需重启**即生效（`http_request` 下次调用读到），`.env` 落盘、状态变「已配置」掩码。
- 卸载（确认）后 skill 从 registry 消失，`.env` 中 key 保留。
- `npm run typecheck` 通过。
