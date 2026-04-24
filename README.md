<p align="center">
  <img src="assets/banner.jpg" alt="茶园树洞 banner" width="100%">
</p>

# 茶园树洞 / teahole

> [English](README.en.md) · 中文

> **仅限内部访问。** 为了保持小圈子氛围，只有 allowlist 里的邮箱才能注册。
> 想体验的朋友，请发邮件或加微信找我：
> 邮箱 <cynb2dwszz@privaterelay.appleid.com> · 微信 `<your-wechat-id>`

一个「登录可见、默认匿名」的社区论坛。在线访问：<https://teahole.fly.dev>

普通用户通过短期令牌发帖，账号与内容在数据库里没有任何关联路径；
管理员可以选择用用户名直接发言，方便大家 `@` 反馈。

## 为什么要这样做

两条硬需求天然矛盾：

- **严格访问控制** — 只有登录用户能读、能发。
- **默认不可追溯** — 普通成员的帖子和评论，不应该能在数据库里连回某个账号。

「先登录、再用昵称发帖」的常见做法过不了第二条：数据库里一行 `posts.user_id = 42`
就把一切暴露了。本项目的做法是把**认证**和**发言授权**解耦 —— 用短期的、
和账号无关联的令牌来授权发言。

## 你看到的网页是怎么跑的

1. **注册 / 登录**
   - 用邮箱注册，邮箱必须在服务端的 allowlist 里（allowlist 文件里的邮箱
     只以 sha256 存在内存，不写库也不打 log）。
   - 注册时会发 6 位验证码到邮箱（通过 Gmail SMTP），验证通过才能设密码。
   - 登录后得到一枚长期 session cookie，只用来证明「你是合法成员」。
2. **领取发帖令牌**
   - 进来之后先点左下角「获取 / 轮换令牌」，拿到一枚随机 32 字节的令牌。
   - 服务器只存 `sha256(token)` 和过期时间，以及你今天**领了几次**的计数 —— 不存原始令牌，也不存「这枚令牌属于哪个账号」的映射。
   - 原始令牌只返回你一次，客户端放在 `localStorage`。
3. **发帖 / 评论 / 反应**
   - 每次写操作都带上令牌。服务器按 hash 查令牌、判断有效，然后写入：
     - 普通成员：`pseudonym = sha256(token)[:8]`，一个 8 位十六进制的匿名 ID。
     - 管理员：`pseudonym = username`，直接用用户名署名。
   - 任何时候数据库里都没有 `user_id` 和帖子并列。
4. **令牌过期**
   - 每 10 分钟扫一遍，删除过期的令牌哈希（默认 TTL 24 小时）。
   - 令牌过期那一刻，「这条帖子是哪枚令牌发的」就再也查不到了 —— 同时你也
     不能再编辑/删除用那枚令牌发的内容。这是默认状态。

## 功能

### 内容

- **Markdown 渲染** — 粗体、斜体、行内 / 围栏代码、链接、列表、引用、h1–h3。
  原始 markdown 保存在库里，HTML 只在客户端生成。
- **代码高亮** — 围栏代码块自动着色。支持 js/ts、Python、C 系（C/C++/Rust/Go/Java/Swift/Kotlin）、SQL、Shell、JSON、CSS；
  未识别语言显示为纯文本不报错。
- **LaTeX 公式** — 行内 `$E=mc^2$`，块级用两行 `$$` 围起来，由 KaTeX 渲染（同源加载，不走 CDN）。
- **图片上传** — 上传时剥离 EXIF 等元信息，按内容 hash 存盘，不按用户归档。
- **搜索** — FTS5 全文索引覆盖标题 + 正文 + 评论，trigram 分词，中文
  3 字以上可搜；搜索词本身不进日志。
- **`#<帖子ID>`** — 直接输入 `#123` 能跳到对应帖子。

### 交互

- **嵌套评论** — 评论可以回复评论。
- **`@` / `#` 提醒** — 在任意输入框里支持 `@abc12345`（匿名 ID）/ `@admin`（管理员用户名）/ `#帖子ID` 的自动补全；写完之后变成可点击的 chip。
- **收件箱** — 发往你当前匿名身份（或管理员用户名）的 `@提醒` 会进「提醒」栏，24 小时内可见。
- **反应** — 👍❤️😂😮😢🎉 六种固定反应，一枚令牌对一个帖子每种反应只能投一票。
  令牌过期时通过外键 cascade 自动清除。「我投过没」只在本地 `localStorage` 里，服务器的读接口不会返回任何用户粒度的状态。
- **编辑 / 删除自己的内容** — 用令牌做权限校验，只要令牌还没过期就能改、过期了就改不动。

### 组织

- **频道** — 管理员建立的话题分区。每个用户可以**置顶**常看的频道、**静音**不关心的频道，还能看到**未读计数**。
- **关注帖子** — 订阅特定帖子的后续评论，账号维度的状态，不依附令牌。
- **收藏帖子** — ★ 收藏到账号上，换令牌不会丢。
- **公告栏** — 管理员专用的站内公告，侧栏常驻。
- **RSS** — `/api/feed.xml` 给登录用户提供最近 50 条帖子；不绑定请求者身份，也没有分页游标。
- **深链接** — 每篇帖子有 `/p/<id>` 的永久链接，前端自己路由，后端 SPA catch-all 无论 id 是否存在都返回 `index.html`（不泄露存在性）。

### 端

- **桌面 + 移动端网页** — 同一份 SPA，移动端布局单独适配。
- **深色 / 浅色主题** — 右上角切换；跟随系统偏好。

## 数据库里任一时刻有什么

| 表             | 能追回账号？                   | 存了什么                                  |
|----------------|-------------------------------|-------------------------------------------|
| `users`        | 是                            | 邮箱、bcrypt 密码、每日令牌计数             |
| `post_tokens`  | 否                            | `sha256(token)`、`expires_at`             |
| `posts`        | 普通成员：否 / 管理员：是     | `pseudonym`、标题、正文、频道、时间         |
| `comments`     | 普通成员：否 / 管理员：是     | `pseudonym`、正文、`post_id`、`parent_id` |
| `reactions`    | 否（以 `token_hash` 外键 cascade） | 帖子 / 令牌 / 反应种类                |
| `mentions`     | 否（目标是 pseudonym）         | 目标匿名 ID、来源帖子 / 评论、时间          |
| `saved_posts`  | 是（按账号收藏）               | 用户、帖子                                |
| `follows`      | 是（按账号订阅）               | 用户、帖子、已读评论水位                    |
| `channel_prefs`| 是（按账号 pin / mute）        | 用户、频道、偏好                          |
| `bulletins`    | 是（管理员署名）               | 管理员发布的站内公告                        |

普通成员的 `posts` / `comments` 没有通向 `users` 的连接路径。阅读类偏好
（收藏 / 关注 / 频道 pin / mute）故意用账号维度，因为这些是读者端状态，
**不涉及作者身份**。

## 已知局限

- **时序关联**。能看到 web server access log / 网络抓包的攻击者，可以把
  「用户 X 在 14:02:11 请求 `/api/token`」和「14:02:14 有人用某枚令牌发
  帖」关联起来。真正意义上的不可追溯需要盲签之类的协议；本项目只保证
  **数据库**里的内容不可追溯。
- **管理员发言是公开的**。这是产品上有意为之，不是漏洞。
- **令牌丢失**。清浏览器 `localStorage` 就会丢，今天剩余的发帖配额也
  跟着失效，只能重新领（计入每日上限）。
- **滥用**。每日令牌上限（默认 5 枚）限制了一个账号能创建的匿名身份数量。
  管理员只能删内容，不能把匿名发言反查成具体用户。

## 本地运行

```bash
npm install
JWT_SECRET=$(openssl rand -hex 32) npm start
# 打开 http://localhost:3000
```

环境变量：

| 变量                  | 默认         | 作用                                             |
|----------------------|--------------|--------------------------------------------------|
| `PORT`               | `3000`       | 监听端口                                         |
| `JWT_SECRET`         | 启动时随机    | 生产环境务必自己设；用默认会让重启后所有 session 失效 |
| `TOKEN_TTL_HOURS`    | `24`         | 发帖令牌寿命                                      |
| `MAX_TOKENS_PER_DAY` | `5`          | 每个账号每天最多领几枚令牌                         |
| `GMAIL_USER`         | —            | 发验证码用的 Gmail 账号                            |
| `GMAIL_APP_PASSWORD` | —            | Google 的应用专用密码（不是登录密码）               |
| `GMAIL_FROM`         | —            | 覆盖发件人显示名                                   |
| `DEPT_ALLOWLIST_FILE`| `./dept-allowlist.txt` | 注册白名单文件路径                    |
| `TRUST_PROXY`        | —            | 反向代理后填 `1` 或 CIDR，让 `req.ip` 取真实客户端 IP |

未设 `GMAIL_USER` / `GMAIL_APP_PASSWORD` 时，验证码直接打到服务端日志，方便本地开发。

### 首个管理员

```bash
sqlite3 data.db "UPDATE users SET is_admin = 1 WHERE username = 'you';"
```

### 注册白名单

把允许注册的邮箱一行一个写进 `dept-allowlist.txt`（`#` 开头是注释）。
文件不存在 = 注册全关闭。服务端每 2 秒 `stat` 一次，可以热改。

## 部署到 fly.io

`Dockerfile` 和 `fly.toml` 已经在仓库里；现网部署在 <https://teahole.fly.dev>。
首次部署：

```bash
fly launch --no-deploy
fly volumes create teahole_data --region sin --size 1
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  GMAIL_USER=you@gmail.com \
  GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx'
fly ssh console -C 'sh -c "cat > /data/dept-allowlist.txt"' < dept-allowlist.txt
fly deploy
```

后续：`git commit … && fly deploy`。

SQLite 文件落在挂载的 volume 上，机器数必须保持 `min = max = 1`，否则
多实例会分叉数据库。
