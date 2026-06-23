# PRD — 定时任务（Scheduled Tasks）

状态：v1 已实现（2026-06）。本文档既是规格也是实现说明。

## 一句话

到点用一段 `input` 串驱动 agent 跑一轮，产出落成一个可回看 / 续聊的 session。
把「定时让 pith 干活并沉淀进知识库」变成一等能力。

## 决策（grill 共识）

| 维度 | 结论 |
|---|---|
| 任务做什么 | 跑一段 agent prompt / skill（不是单纯 ingest，也不是纯提醒） |
| 触发宿主 | **桌面 engine**（常驻 utilityProcess）。**App 开着才触发 + 启动补跑**；不上 OS 级后台 |
| 调度表达 | `once`（绝对时刻）\| `cron`（5 字段 + tz），二选一存同一条 |
| 任务体 | 一条 `input` 串，复用桌面会话执行路径（prompt / `/skill` 同源），不设结构化 payload |
| 产出 | **每触发新开 session**，正常持久化；任务侧存指向 session 的 run 历史。**不强制 ingest**（要落盘由 agent 自己调 `wiki_ingest`） |
| 错过补跑 | cron 折叠成 1 次 `catchUp`；once 迟到补跑；`catchUp=false` 的任务错过即 `skipped` |
| 重叠 | 全局串行（`p-queue(concurrency=1)`）；同任务在跑时新触发跳过 |
| 入口 | **agent 工具** `schedule_*` + **桌面 UI**，共用 core `ScheduleService` |
| 展示 | 日历（未来触发点 + 历史 run 叠加，月/周/agenda）+ 任务列表（双视图） |

## 架构

```
core（src/schedule/，UI-free 纯逻辑，唯一真相源）
  cron.ts      手搓 5 字段 cron 求值（parse / nextFireAfter / fireTimesBetween）—— 离线、零依赖
  types.ts     schema + 原子 IO 形状（ScheduledTask / RunRecord / ScheduleState）
  store.ts     ScheduleStore：load → mutate（同步）→ 原子写回（无 lockfile，单进程 engine）
  service.ts   ScheduleService：CRUD + nextFire + computeDue（catch-up 决策）

agent 工具（src/tools/schedule.ts）
  schedule_add / list / update / delete / status
  schedule 判别联合摊平成 kind/at/cron/tz（绕开手搓 zodToJsonSchema 不认 union）
  仅桌面 engine 注入 ctx.scheduleService 时可用；否则返回「仅桌面可用」

桌面 engine（desktop/src/engine/）
  scheduler.ts     Scheduler：30s tick → computeDue → markTick → 串行执行 run/skip；
                   启动即补跑一拍；runNow（立即触发，不推进 lastFiredAt）
  bootstrap.ts     装配 ScheduleService + Scheduler；schedule_* 进 agentFactory extraTools；
                   schedule.* 请求处理 + scheduleTaskToDTO（含 upcomingFires 枚举）
  sessionManager   runScheduled(input, title)：新开 session 跑一轮，返回 {sessionId, status, preview, error}

桌面 UI（desktop/src/renderer/）
  views/Schedule.tsx  月历（未来点 + 历史 run 叠加 + 状态色图例）+ 任务列表（启停/Run now/编辑/删除/run 历史）+ 创建/编辑表单
  cronText.ts         友好 cron 编辑器的纯函数层：buildCron / parseCron / describeCron。
                      表单里 CronBuilder 提供 每天/每周/每月/自定义 四档（星期 chips、日期下拉、
                      时间选择器），底层生成/反解析 cron，带人话实时预览；普通用户不用手写 cron。
                      describeCron 也用于列表摘要（「每周 一 09:00」而非 0 9 * * 1）。
  store + protocol     schedule.list/create/update/delete/runNow 请求；schedule.update 事件 → 重拉
```

## 数据模型

`~/.pith-wiki/schedule/state.json`（config `scheduleStatePath`）：

```ts
ScheduledTask {
  id, input, title?,
  schedule: {kind:'once', at} | {kind:'cron', expr, tz},
  enabled, catchUp,
  lastFiredAt?,            // 推进点：已处理到的 occurrence
  runs: RunRecord[],       // 封顶 50，环形截断
  createdAt, updatedAt,
}
RunRecord { runId, sessionId, firedAt, status: ok|failed|skipped|catchUp, preview?, error? }
ScheduleState { version, tasks, lastTickAt }   // lastTickAt 用于判定停机窗口
```

## 无人值守的审批（重要）

定时触发的会话是**无人值守**的。交互式审批（写文件 / `run_command` 执行命令）会 `await`
一个「等人点 y/a/n」的 Promise —— 没人在触发时刻回答就会让整轮**永久卡死**（曾导致
任务转圈不结束）。处理：

- 默认 **auto-approve**：`runScheduled` 用一个自动放行的审批桥（`SessionManager.create({autoApprove})`）。
  依据——任务是用户亲手排的（standing consent）、写入受 `wikiRoot`/`workspace` 沙箱约束、
  可执行二进制在 skill 安装时已进白名单。这样任务能真正跑通（查 lark/weread、写 output）。
- 每任务 `requireApproval` 开关（默认 false）：true 时沿用交互式审批——只有有人在看并批准
  才完成，否则被整轮超时记 `failed`。给做敏感操作、希望「跑前确认」的任务用。
- **整轮超时兜底** `SCHEDULED_TURN_TIMEOUT_MS`（10 分钟）：任何无超时的工具/LLM 挂起都会被
  abort → 记 `failed`，**绝不永久挂起**。

## 日期占位符（触发时解析）

任务文案写「昨天」靠 agent 自己推断日期不可靠（曾把昨天算错）。改为**触发时**把占位符
替换成确定日期再喂给 agent —— 解析器在 `desktop/src/shared/placeholders.ts`（引擎触发 +
渲染层实时预览共用一份）。

- 语法 `${<格式> [偏移]}`：格式 token `yyyy/yy/mm/m/dd/d`（之间字符原样保留）；偏移
  `[+-]N[dwmy]?`（前需空格，单位默认 d）。例：`${yyyy-mm-dd}`=今天、`${yyyy-mm-dd -1}`=昨天、
  `${yyyy/mm/dd +7}`、`${yyyy年mm月dd日}`、`${yyyy-mm -1m}`=上个月。
- 基准时刻 = 本次 **occurrence 的 fireTime**（catch-up 补跑时按当初该跑的日期解析，而非补跑当下）。
- 安全：只有含年 token（yyyy/yy）的 `${...}` 才解析，其余原样保留，绝不破坏输入。
- `Scheduler.enqueueRun` 在 `runScheduled` 前对 input + title 解析；schedule_add 工具描述也提示
  模型用占位符代替「昨天」；表单有占位符提示、今天/昨天快捷插入、实时「今日预览」。

## 「新增日期」语义（每日 digest 的关键）

任务「整理某天新增的内容」曾总是读到「今天入库」的东西。根因：每个 entry 只有一个
`updated`，在每次水合时被设成 now（= 入库/水合时刻，不是内容日期），而 wiki_list 只能按
`updated` 倒序、无日期过滤；当天批量导入历史内容会让一切看起来「今天新增」。修法（两条时间线）：

- **入库时间 `Entry.ingestedAt`**（A）：首次进库时刻，**稳定**、再水合不刷新（`LibraryService.put`
  维护：保留既有值或首次置 now；旧条目读取时回退到 `updated`）。「某天新增到 pith 的」按它查。
- **内容自身日期 `Entry.date`**（B）：文档修改日 / 读书笔记日 / 文章发布日，与何时导入无关。
  水合时 LLM 从原文抽取（抽不到则省略，不许猜），或 `wiki_ingest` 的 `date` 参数显式传入。
- **检索**：`wiki_list` 加了 `added_after/added_before`(按 ingestedAt) 和 `date_after/date_before`
  (按 date) 日期范围过滤（YYYY-MM-DD，含两端），并在结果里暴露 `ingestedAt`/`date`。工具描述
  提示模型：批量导入会把 added 日期都盖成今天，要「内容自身日期」就用 date_*。
- **固有限制**：同一天批量导入的历史内容，按「入库日期」无法和当天读的少量内容区分；要按内容
  日期区分，得该内容在入库时带上 `date`（新内容走 hydration 抽取 / ingest 传入，已导入的旧内容
  没有则无法追溯）。

## catch-up 语义细节

- `computeDue(now)`：`wasDowntime = now - lastTickAt > 2min`。
- cron：找 `(lastFiredAt ?? createdAt, now]` 内最近一次触发（折叠多次错过为一次）。
- once：`at ≤ now` 且未触发过。
- 停机窗口内触发 → `catchUp`（或 `catchUp=false` 时 → `skipped`，并推进 `lastFiredAt` 不再 lingering）。
- 失败不自动重试（与 ingest 队列不同）；下个触发点照常。
- 时区：每条 cron 自带 `tz`，**v1 求值按本机本地时区**（tz 暂作元数据，无依赖下不做跨时区/DST 换算）。

## 已知边界 / 后续

- App 关着不触发（宿主即 engine）。需要「关机也准点跑」要上 OS 级后台（launchd/cron），core 逻辑可复用，加宿主即可。
- 日历未来点窗口：cron 枚举 now 起 90 天内、封顶 60 条；超窗口的未来月份不画未来点。
- CLI 子命令 `pith-wiki schedule …`、`schedule run` headless 守护：未做（core 现成，加宿主 + lockfile 即可）。
- cron 求值最远前瞻 366 天（不可能的表达式如 `0 0 30 2 *` 返回 null）。

## 测试

- `tests/schedule.test.ts`：cron 解析/语义、id 派生、CRUD、computeDue 的 catch-up（折叠/迟到/跳过/禁用）。
- `desktop/tests/scheduler.test.ts`：tick → run/skip 记录、lastFiredAt 推进、同任务重叠跳过。
