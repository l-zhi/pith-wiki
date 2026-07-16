---
name: weread
description: 微信读书助手 — 搜索书籍、查看书架、笔记划线、阅读统计、书评与推荐
http_allow:
  - host: i.weread.qq.com
    auth_env: WEREAD_API_KEY
test:
  kind: http
  url: https://i.weread.qq.com/api/agent/gateway
  method: POST
  body: '{"api_name":"/_list","skill_version":"1.0.3"}'
---

# 微信读书助手

通过微信读书 Agent 网关访问个人阅读数据：搜书、书架、笔记划线、阅读统计、书评、推荐。

## 怎么调用（pith-wiki 专用）

本 skill 在 pith-wiki 里用 **`http_request` 工具**调用统一网关，鉴权由工具自动注入，
你不需要也不应该自己拼 Authorization 头或处理 API Key。

- **端点**：`https://i.weread.qq.com/api/agent/gateway`
- **方法**：POST，`content_type` 用默认的 `application/json`
- **body**：JSON 字符串，`api_name` 指定接口，业务参数**平铺在同一层**，
  并且**每次都必须带 `skill_version`**（当前用 `"1.0.3"`）

调用形如：

    http_request(
      url="https://i.weread.qq.com/api/agent/gateway",
      method="POST",
      body='{"api_name":"/store/search","keyword":"三体","count":10,"skill_version":"1.0.3"}'
    )

若工具回错 `WEREAD_API_KEY is not set`，告诉用户：到
https://weread.qq.com/r/weread-skills 登录获取 key，写进 `.env`：
`WEREAD_API_KEY=wrk-xxxxxxxx`，然后重启 REPL。

## 核心接口

| 意图 | api_name | 关键参数 |
|------|----------|----------|
| 搜书 | `/store/search` | `keyword`、`count` |
| 书架 | `/shelf/sync` | （无，自动按当前用户） |
| 书籍详情 / 章节 | `/book/chapterinfo` | `bookId` |
| 我的笔记本（有笔记的书） | `/user/notebooks` | `count`、翻页用 `lastSort` |
| 某书划线 | `/book/bookmarklist` | `bookId` |
| 章节热门划线 | `/book/bestbookmarks` | `bookId` |
| 我的想法/点评 | `/review/list/mine` | `bookId` |
| 书籍公开点评 | `/book/readreviews` | `bookId` |
| 阅读统计 | `/readdata/summary` | （按当前用户） |
| 推荐 | `/store/recommend` | 视情况带 `bookId` 求相似 |

**不确定参数或还有哪些接口时**，发 `{"api_name":"/_list","skill_version":"1.0.3"}`
可列出全部接口及参数定义；调用前以它返回的定义为准，不要凭字段名猜含义。

## 调用约定

1. **先解析 bookId**：用户给书名时，先 `/store/search` 拿到 `bookId`，再做后续操作；
   对话中记住已查到的 `bookId`，不要反复让用户提供。
2. **参数平铺**：业务参数和 `api_name`、`skill_version` 放同一层，**不要**包进
   `params`/`data`/`body` 对象（否则后端收不到，会静默返回第一页/默认值）。
3. **翻页**：列表接口用返回的 `lastSort`（或类似游标）平铺到下一次请求继续取。
4. **时间戳**：所有 Unix 时间戳字段展示时转成 `YYYY-MM-DD`，不要直接显示数字。
5. **阅读时长**：单位是秒，展示时转成「X小时Y分钟」。
6. **错误处理**：回包 `errcode` 非 0 时给中文提示；若出现 `upgrade_info` 字段，
   先按其 `message` 指引处理再继续。
7. **结果展示**：列表用编号方便用户选择；搜索结果重点给书名、作者、评分。

## 深度链接（可选）

展示书/章节/划线时，可附微信读书 App 跳转链接方便用户点开：

- 打开书（回到进度）：`weread://reading?bId={bookId}`
- 跳到章节：`weread://reading?bId={bookId}&chapterUid={chapterUid}`
- 跳到某条划线：`weread://bestbookmark?bookId={bookId}&chapterUid={chapterUid}&rangeStart={s}&rangeEnd={e}`
  （`range` 字段格式 `"起始-结束"`，拆开填 s/e）

## 与知识库联动

用户想保存读书笔记时，把 `/book/bookmarklist`、`/review/list/mine` 拿到的划线/想法
整理好后，用 `wiki_ingest` 存进知识库，形成可检索的读书笔记条目。
