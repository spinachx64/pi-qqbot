> 本文为上游 2.8.0 的历史说明。当前分支的安装、隔离方案和限制请以[仓库首页](../README.md)为准。

# pi-qqbot

把 **[Pi](https://pi.dev) coding agent** 接入 QQ 单聊的桥接插件：在 QQ 里发一句话，让 AI 在运行 pi 的那台机器上干活 —— 执行危险工具前会先在 QQ 里向你申请审批。

[English](https://gitee.com/zxh126/pi-qqbot/blob/main/README.md) | **简体中文**

> **单会话设计（v1）**：所有 QQ 用户共用同一个 pi 会话。多用户/多会话后续基于 pi SDK 实现。

## 功能

| 功能 | 说明 |
|---|---|
| **对话驱动 agent** | QQ 单聊消息送入当前 pi 会话，AI 的回复发回 QQ（长文本自动分片）。 |
| **消息队列** | 正在处理任务时，后续 QQ 消息会被**排队**而不是被拒；当前任务结束（settled）后按到达顺序自动逐条执行。`/cancel` 是例外——立即生效并清空队列。 |
| **远程审批** | pi 执行 `bash` / `powershell` / `write` / `edit`，或任何带 `destructiveHint` 注解的工具前，先在 QQ 里申请审批（`markdownReply` 开启时审批卡片带内联按钮，文本回复同样有效）。 |
| **远程上下文提醒** | **每个会话第一次真正把 QQ 消息交给 pi 跑起来**时，才告诉它「对话来自远程 QQ 用户、本机可能锁屏」：桌面截屏 / 屏幕 OCR / UI 自动化 / 带界面的浏览器默认禁用，要图就离屏渲染再用 `qq_send_file` 发回。仅载入扩展、或本机 TUI 直接对话时都不注入；上下文压缩后自动重新注入。 |
| **会话级「以后都同意」** | 点审批卡片上的 🚀 以后都同意（或回复「以后都同意」），**当前会话**内所有审批请求直接放行，连已经挂起的那条也一起放行。 |
| **单实例锁** | 只有一个 pi 进程作为宿主连接 QQ，其余待命，宿主退出后自动接管。 |
| **中断正在运行的任务** | 发 `/cancel`（或「取消」/「停止」），当前任务立刻中断 —— QQ 回复、待审批工具调用、写到一半的回答、排队中的消息一并清理。 |
| **斜杠命令路由** | 以 `/` 开头的 QQ 消息会先被路由：pi 的扩展命令、prompt 模板、`/skill:name` 交给 pi 派发；一部分 pi 内置命令（`/reload`、`/new`、`/compact`、`/session`、`/name`、`/model`、`/thinking`、`/quit`）由本扩展接管；只能在主机执行的内置命令直接回执，不会送给模型。 |
| **进度汇报** | 任务运行期间按 `progress.intervalMs`（默认 **15 秒**）推一条进度摘要（轮次、工具调用、正在跑的工具、token 用量）。随时发 `/progress`（别名 `/p`、「进度」）可立即获取；`/progress off` 在本会话内暂停自动汇报，`/progress on` 恢复。推送失败后自动推送静默，直到你再次问询。 |
| **敏感信息脱敏** | 离开本机的文本先脱敏——进度摘要、审批提示、队列预览、日志文件：`Authorization` 头（含 QQ bot token）、`sk-…`/`ghp_…`/`npm_…`/`AKIA…`/JWT/PEM、`token=`/`password=`/`--api-key` 的值、URL 里的 `user:pass@`，以及超长高熵串。 |
| **多 bot 同机** | 一份配置里写多个 QQ bot（`qqbots: [...]`，详见 [accounts.md](./accounts.md)），同一台机器上每个 pi 进程按配置顺序接入第一个未上线的 bot；全部在线则待命、每 5 秒重扫，有人退出就接管。别人只是 `/reload` 临时释放的 bot 不会被抢（留 20 秒预约窗口）。接入/接管时会告知当前 bot 名称与工作目录。 |
| **图片与文件** | QQ 里发来的附件会先下载到临时文件，再以标记行交给 pi——图片是 `图片路径 <path>`，其余按类型是 `语音路径` / `视频路径` / `文档路径` / `压缩包路径` / `文件路径`；QQ 侧收到一条回执（数量、类型、路径）。pi 的 `read` 工具能直接看图片，`bash` 能处理文件。 |
| **把本机文件发到 QQ** | 让 agent 把机器上的文件发给你（「把 D:\docs\报告.pdf 发给我」）或发 `/sendfile <路径>`；机器人按 5MB 分片上传（QQ 富媒体），图片(png/jpg) / 视频(mp4) / 语音(silk) 直接展示，其余变成可下载的文件卡片。外发是否审批由 `files.forceApproval` 决定（默认不强制，见下文）。 |
| **内置指令** | `/status`、`/queue`、`/progress`、`/reset`、`/cancel`、`/sendfile`、`/update`、`/help`。 |
| **`!` / `!!` 只回执、不执行** | 这两个 shell 快捷前缀只在 pi 的 TUI / RPC 前端生效，扩展 API 没有等价能力，所以 QQ 侧只回一条说明，既不执行、也不把 `!ls` 当聊天丢给模型。要跑命令直接用中文说需求，agent 会调 `bash` 工具并在执行前向你申请审批。 |

## 安装

```bash
# 从 npm 安装
pi install npm:@zxh126/pi-qqbot

# 或从本地目录安装（需要先装依赖）
npm install
pi install ./pi-qqbot
```

然后创建 `~/.pi/agent/pi-qqbot.json`：

```json
{
  "appId": "你的AppID",
  "appSecret": "你的AppSecret",
  "sandbox": true,
  "allowlist": [],
  "markdownReply": false,
  "streaming": false,
  "approve": {
    "tools": ["bash", "powershell", "write", "edit"],
    "remember": true
  },
  "queue": {
    "max": 20,
    "ack": true
  },
  "commands": {
    "passthrough": true,
    "allowReload": false,
    "allowQuit": false,
    "allowUpdate": false,
    "allowSession": true
  },
  "attachments": {
    "enabled": true,
    "dir": "",
    "maxBytes": 26214400,
    "maxPerMessage": 10,
    "retentionHours": 24,
    "maxFiles": 200
  },
  "files": {
    "enabled": true,
    "maxBytes": 31457280
  },
  "remote": {
    "notice": true,
    "guidelines": true,
    "extra": ""
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 必填 | QQ 开放平台机器人凭据 |
| `sandbox` | `false` | 未提审上线的 bot 用 `true`（沙箱环境） |
| `allowlist` | `[]` | openid 白名单，空 = 不限制 |
| `markdownReply` | `false` | 用 QQ markdown 消息（msg_type=2）回复，GFM 表格可渲染，审批与选择列表附带内联按钮（自定义按钮需平台内邀开通）；需要该 bot 的 markdown 权限，发送失败自动回退纯文本 |
| `streaming` | `false` | 预留，v1 未启用流式 |
| `approve.tools` | `["bash","powershell","write","edit"]` | 需要审批的工具名；带 `destructiveHint` 注解的工具同样会拦截 |
| `approve.remember` | `true` | 会话内按工具记住决策（同类工具不再重复询问） |
| `commands` | 见下 | 斜杠命令路由开关：`passthrough`、`allowReload`、`allowQuit`、`allowSession` |
| `queue.max` | `20` | 任务运行期间最多排队多少条；`0` = 关闭排队（忙碌时直接拒绍，回到旧行为） |
| `queue.ack` | `true` | 排队消息开始执行时是否回执 QQ（入队回执总是会发） |
| `progress.enabled` | `true` | 任务运行期间是否定期推送进度摘要（会话启动时读取，改完需 `/new` 或重启；运行时用 `/progress off`） |
| `progress.intervalMs` | `15000` | 推送间隔（可用环境变量 `PI_QQBOT_PROGRESS_MS` 覆盖，便于测试） |
| `attachments.enabled` | `true` | 是否把附件下载到临时文件并把路径交给 pi；`false` = 只回一句忽略提示、只处理文字 |
| `attachments.dir` | `""` | 落盘目录；空 = 系统临时文件夹下的 `pi-qqbot/<bot>`（Windows：`%LOCALAPPDATA%\Temp\pi-qqbot\…`） |
| `attachments.maxBytes` | `26214400` | 单个附件上限（25 MB），超出的记为下载失败、不落盘 |
| `attachments.maxPerMessage` | `10` | 单条消息最多处理几个附件 |
| `attachments.retentionHours` | `24` | 超过此时长的临时文件在会话启动时清理 |
| `attachments.maxFiles` | `200` | 目录内最多保留多少个文件（超出删最旧） |
| `files.enabled` | `true` | 是否允许把本机文件发到 QQ（工具与 `/sendfile` 共用）；`false` 则拒绕 |
| `files.maxBytes` | `31457280` | 发送单个文件的上限（30MB；QQ 硬限 200MB） |
| `files.forceApproval` | `false` | 外发硬性门禁：`true` = `qq_send_file` 每次单独确认，不吃「以后都同意」与会话内记忆；`false` = 普通审批规则（仅在 `approve.tools` 里列出时审批，此时自动同意 / 记忆照常生效） |
| `remote.notice` | `true` | 每会话第一条消息交给 pi 前注入一次「对话来自远程用户」的说明（QQ 侧不可见，压缩后重新注入） |
| `remote.guidelines` | `true` | 每次来自 QQ 的 run 额外往系统提示里加三条短规则（远程用户、锁屏→离屏渲染、需要人工就直说） |
| `remote.extra` | `""` | 追加到内置提醒末尾的自定义补充 |

也可用环境变量 `PI_QQBOT_APPID` / `PI_QQBOT_APPSECRET` 代替文件里的凭据（仅单 bot 场景）。
2.8 之前的 `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` 仍作弃用别名可用（两个都设时以 `PI_` 前缀的为准）；
pi-qqbot 自己的变量统一用 `PI_QQBOT_*` 名字空间，避免吃到别的 QQ 桥接工具的环境变量。

### 多个 bot（2.0）

```jsonc
{
  "qqbots": [
    { "name": "work", "appId": "1903340143", "appSecret": "…", "sandbox": true },
    { "name": "home", "appId": "1020123456", "appSecret": "…" }
  ],
  "queue": { "max": 20, "ack": true }   // 这里仍是全局默认，qqbots 内可逐键覆盖
}
```

多个 pi 进程按配置顺序各自接入一个未上线的 bot，抢不到的待命并每 5 秒重扫；
`PI_QQBOT_ACCOUNT=<name|appId>` 可以钉住某个 bot，不走自动抢占。细节见 [accounts.md](./accounts.md)。

## 使用

启动 pi 后，在 QQ 里给机器人发消息，pi 会处理并回复。

| 指令 | 说明 |
|---|---|
| `/reset` | 重置：清空回复缓冲、审批记忆与自动同意开关（**不换会话**，换会话发 `/new`） |
| `/status` | 查看本进程服务的 bot（名称 + 工作目录）、忙闲状态、上一轮来源（QQ / 本机 TUI）、队列长度、自动同意状态、待审批数量、自动汇报模式 |
| `/queue` | 查看队列（别名 `/q`）；`/queue clear` 清空，`/queue drop <编号>` 删一条 |
| `/progress` | **立即获取当前进度摘要**（别名 `/p`、「进度」「当前进度」「进展」；忙碌时「到哪了」「怎么样了」这类问法同样生效）。手动暂停期间**问一次只回一次**，要重新打开定时汇报需发 `/progress on` 或「恢复汇报」；若只是配额静默，问一次即恢复 |
| `/progress off` | **在本会话内暂停自动进度汇报**（别名：`pause`、`stop`、`暂停`、「暂停汇报」、「关闭汇报」）。手动 `/progress` 仍可看一次，但不再解除暂停 |
| `/progress on` | **恢复自动进度汇报**（别名：`resume`、`start`、`恢复`、「恢复汇报」、「继续汇报」） |
| `/cancel` | **中断当前正在运行的任务**并清空队列（别名：`/stop`、`/abort`、「取消」、「停止」、「中止」、「终止」、「算了」、「停」、「停下」、「停一下」、「别跑了」）。注意：单说「停」是中断**任务**，要关进度推送请说「别汇报了」「闭嘴」或 `/progress off` |
| `/help` | 帮助 |

### QQ 里发来的图片与文件

发一张图（或文档、压缩包、语音/视频），机器人会把它下载到临时文件，然后给 pi 一行路径：

```
图片路径 C:\Users\you\AppData\Local\Temp\pi-qqbot\bot-340143\2026-02-11\msg-abc-1-103045.jpg
```

| 附件类型 | 交给 pi 的行 |
|---|---|
| 图片 | `图片路径 <path>` |
| 语音 / 音频 | `语音路径 <path>` |
| 视频 | `视频路径 <path>` |
| 文档（pdf、office、文本、代码…） | `文档路径 <path>` |
| 压缩包（zip、rar、7z、tar…） | `压缩包路径 <path>` |
| 其它 | `文件路径 <path>` |

你自己的文字保持在第一行：发「看下这个」+ 一张图，送给 pi 的就是
`看下这个\n图片路径 C:\…\a.jpg`——同一轮，路径已在里面。QQ 侧还会收到回执，例如
`已收到 2 个附件（图片 ×1、文档 ×1），已存为临时文件并交给 pi：` 后跟各条路径；下载失败的附件会列出原因，
文字部分照常执行。

注意：

- QQ 的下载地址带短期有效的 `rkey`，所以收到消息的当下就下载。
- 带附件的消息会**绕过**斜杠命令、审批解析与编号选择，一律当作普通内容交给 pi（附带 `/status` 不会被执行）。
- 临时文件由 `attachments.retentionHours` / `attachments.maxFiles` 在会话启动时清理；交给 pi 的路径在当前会话（通常一天内）都可读。
- 落盘文件名只保留 `[0-9a-zA-Z._-]`，并以 QQ 消息 id 作为前缀。

### 把本机文件发到 QQ

两种触发方式：

| 触发 | 用法 |
|---|---|
| 自然语言 | 「把 D:\docs\报告.pdf 发给我」——agent 会调 `qq_send_file` 工具 |
| 斜杠命令 | `/sendfile D:\docs\报告.pdf`（路径带空格就加引号；不开 run，直接执行） |

**外发审批由 `files.forceApproval` 决定**（默认 `false`，每次发送时读取）：

- `true` — 硬性门禁：`qq_send_file` 无论 `approve.tools` 怎么配都强制走审批，并且**不吃**会话级
  「以后都同意」、也不吃「同意后记住」，因为外发文件等于数据出境，每个文件单独确认。提示里会写明：
  `[审批 #1] 发送文件到 QQ: D:\…` + 「需单独确认」。
- `false`（默认）— 普通审批规则：只有 `qq_send_file` 出现在 `approve.tools`（或带 `destructiveHint`
  注解）时才审批，此时「以后都同意」与会话内记忆照常生效；默认配置下 agent 发文件不再询问。
- QQ 里直接发的 `/sendfile` 从不审批——路径是你亲手敲的。

发送形态（QQ 富媒体分片上传）：

| 文件 | 对方看到 |
|---|---|
| `.png` / `.jpg` / `.jpeg` | 图片直接展示 |
| `.mp4` | 视频直接播放 |
| `.silk` | 语音条 |
| 其他（pdf / zip / mp3 / epub / exe…） | 可下载的文件卡片 |

注：

- 必须走分片上传（`upload_prepare` → `PUT` → `upload_part_finish` → 合并）：URL 上传要求公网可访问，二进制直传只有 5MB 上限。
- 用被动回复（`srv_send_msg: false` + `msg_type: 7` 带 `msg_id`/`msg_seq`），不烧主动消息额度。
- QQ 侧还有 **200MB 硬上限**和**每天发送文件总容量上限**（错误码 `40093002`），都翻成中文回执。
- 成功后会回一行：`已发送「报告.pdf」（2.31 MB，文件卡片）`。

### 远程上下文提醒

pi 跑在这台机器上，用户在 QQ 那头——而这台机器可能锁屏。所以**每个会话第一次真正把 QQ 消息交给 pi 跑起来**时，
插件会往**系统提示**里加一段说明（`qq-remote-context` section，排在用户消息之前，QQ 侧看不到），告诉它：

- 用户是远程的：看不见屏幕、也点不到弹窗，回复应简明扼要；
- 桌面截屏、屏幕 OCR、UI 自动化、键鼠模拟、带界面的浏览器默认都不要用（文案里点名了 `mcp__screenshot`、`mcp__winui`），
  锁屏下它们只会拍到锁屏画面或直接失败；
- 需要图时自己离屏渲染（headless 浏览器渲 HTML、SVG、matplotlib/Pillow…），生成 PNG 再用 `qq_send_file` 发到 QQ，
  不要为了「确认」先截桌面；
- 只有确实需要判断是否锁屏时，才允许截一次桌面看有没有内容。

时机很关键：只有本扩展派发的 QQ 消息真的开跑（`before_agent_start`）时才会注入——**仅仅载入扩展、或者本机在 TUI 里
直接跟 pi 对话，都不会给 pi 发任何东西**。每个会话注入一次（上下文压缩后重新注入；`remote.extra` 可追加你自己的话）。
开了 `remote.guidelines` 时，同样的要求会压成三条规则，随每次来自 QQ 的 run 一起进系统提示，避免长会话被摘要后丢失。
`remote.notice: false` / `remote.guidelines: false` 可分别关掉这两部分。

如果同一个会话里你从本机接管——上一轮来自 QQ，下一轮直接在 TUI 里打字——本机那一轮会换成一次性
`qq-local-handoff` 更正：「远程 QQ 用户」的前提作废（可以正常截屏，不需要 `qq_send_file`）。识别靠 `input` 事件
（`source: "interactive"`；本扩展自己的 `sendUserMessage` 是 `"extension"`，不会误判），每次交接只更正一次，
QQ run 还在跑时插话不处理（那时不会开新的 run）。`/status` 会显示 `来源: QQ（远程）` 或 `来源: 本机（TUI）`。

### QQ 里的斜杠命令

任何以 `/` 开头的消息都会先走路由，再决定是否当成对话：

| # | 类型 | 行为 |
|---|---|---|
| 0 | 输出只走 `ctx.ui.*` 的扩展命令（`/usage`、`/cost`、`/mcp`、`/llama`） | `/usage`、`/cost` 会**桥接**（见下）把报告发回 QQ；`/mcp`、`/llama` 需要主机 TUI 的选择框/登录，直接回执说明，不再静默 |
| 1 | pi 的**扩展命令**、prompt 模板、`/skill:name` | 以 `expandPromptTemplates: true` 派发给 pi，所以 `/usage`、`/cost` 或你自己注册的命令在 QQ 里也能用 |
| 2 | 本桥接能接管的 pi 内置命令 | 用扩展 API 重新实现（见下表） |
| 3 | 只能在 TUI 里跑的 pi 内置命令 | 回执「请在主机执行」，**不会**送进模型 |
| 4 | 其余（`/tmp 里有什么`、`/etc 看看` …） | 当普通对话处理 |

| QQ 命令 | 实际动作 | 开关 |
|---|---|---|
| `/reload` | 重载扩展 / 技能 / 模板 / 主题 —— **bot 自己也会重启**并重连网关 | `commands.allowReload`（默认 **false**） |
| `/new` | 真正开新会话（`ctx.newSession()`） | `commands.allowSession` |
| `/compact [指令]` | 压缩上下文 | `commands.allowSession` |
| `/session` | 会话 id / cwd / 模型 / 思考等级 / 上下文用量 | `commands.allowSession` |
| `/name [名字]` | 查看或设置会话名 | `commands.allowSession` |
| `/model [provider/model]` | 列出可用模型或切换 | `commands.allowSession` |
| `/thinking [等级]` | 查看或设置思考等级 | `commands.allowSession` |
| `/tree` | 列出会话树上的分支点（编号），回编号或点按钮即跳转 | `commands.allowSession` |
| `/fork` | 列出之前的用户消息（编号），回编号或点按钮即从该处分叉 | `commands.allowSession` |
| `/clone` | 在当前叶子位置复制整个会话 | `commands.allowSession` |
| `/resume` | 列出本项目其他会话（编号），回编号或点按钮即切换 | `commands.allowSession` |
| `/quit` | 关掉主机上的 pi | `commands.allowQuit`（默认 **false**） |
| `/update` | 从 npm 更新 pi-qqbot（`pi update`）并重载自己，见[从 QQ 更新自己](#从-qq-更新自己) | `commands.allowUpdate`（默认 **false**） |

只能在主机执行（回执，不转发给模型）：`/settings`、`/hotkeys`、`/changelog`、`/trust`、`/login`、
`/logout`、`/scoped-models`、`/llama`、`/import`、`/export`、`/share`、`/bug`、`/copy`、`/privacy`。

以 `!` 或 `!!` 开头的消息（全角 `！` / `！！` 也认）**不会被执行**。这两个前缀只在主机 pi 的 TUI / RPC 前端
被当成 shell 命令（`!` 跑完把输出交给模型，`!!` 跑完把输出排除出上下文），而扩展 API 没有等价入口：
`pi.sendUserMessage()` 不做这个分派，`pi.exec()` 又不过审批、不写会话历史。所以 `!ls` 只会收到一条
「QQ 侧不支持」的回执，也不会被当成正文送给模型。想跑命令直接用中文说需求（例如「列一下当前目录里的仓库」），
agent 会调 `bash` 工具，执行前在 QQ 里向你申请审批。单独一个 `!`、`!!!`、以及句末感叹号仍按普通对话处理。

### 只往 TUI 打字的命令，现在会回到 QQ

有些扩展命令从不往对话里输出，而是调 `ctx.ui.notify()`（配合 `pi.appendEntry()`）——只渲染在主机
TUI/RPC 前端。在 QQ 里的表现就是「已派发，然后没下文」。桥接把这个洞堵上：

| 命令 | 现在发生什么 |
|---|---|
| `/usage [范围]`、`/cost [范围]` | 改派为 `/qq usage <范围>`：桥接先重跑原 `/usage` 命令，再**轮询等待**本次新写入的 `customType: "usage-report"` 条目（`appendEntry` 比 `sendUserMessage()` 返回晚约 100 ms，只读一次必然落空），最多等 2 秒，仍未命中才退回读会话文件尾部；然后渲染成文本回 QQ（请求数/总 token/缓存比/费用/按模型）。**用法不变**，照旧发 `/usage today` |
| `/mcp`、`/llama` | 直接回执：它们需要主机 TUI 的选择框 / 浏览器登录，不会派发 |
| `/usage rate <值>`、`/usage rate auto` | 会真的执行（写 `~/.pi/agent/pi-usage-report.json` / 刷新汇率缓存），桥接再读回文件确认新汇率，无效值会体现在“汇率未变”上；只发 `/usage rate` 与 `/usage help` 则本地直接回执，不执行命令 |

桥接与 [`pi-usage-report`](https://gitee.com/zxh126/pi-usage-report) 的耦合只有三处：`usage-report` 这个
custom entry 类型名，以及它写在 `~/.pi/agent/` 下的两个配置文件。

约束：

- 有任务在跑时，`/reload`、`/new`、`/compact`、`/quit`、`/tree`、`/fork`、`/clone`、`/resume` 会拒绝执行
  —— 先发 `/cancel`。
- prompt 模板与 `/skill:name` 会开启一轮 agent run，因此忙碌时会像普通消息一样**排队**
  （见 [忙碌时的队列](#忙碌时的队列)）；自己管理 LLM 交互的扩展命令仍然立即执行。
- 选择型命令（`/tree`、`/fork`、`/resume`）会回一个最多 10 项的编号列表（`markdownReply` 开启时附带点选按钮），只对该用户有效、10 分钟内有效；
  该用户下一条「纯数字」消息即执行选择，其它内容（或「取消」）则放弃。没有待选列表时，数字就是普通对话。
- `/reload` 默认关闭：它会重启 bot，如果新代码加载失败，bot 会一直哑着，只能在主机上救。
  置 `commands.allowReload: true` 才启用。
- 直接发桥接命令（`/qq reload`、`/qq quit`、`/qq new`、`/qq list fork` …）走**同一套门禁**：子命令会先
  翻回对应的内置命令名，所以 `commands.allowReload` / `allowQuit` / `allowUpdate` / `allowSession`
  与忙碌检查全部生效。若按普通扩展命令派发（2.6.1 之前的行为），这些门禁会全被绕过 ——
  `allowQuit: false` 时发 `/qq quit` 也能关掉主机 pi。自毁类子命令（`reload`、`new`、`quit`、`clone`）
  会**先回执再派发**，因为动作会换掉它自己用来回执的运行时。
- 派发回执显示**完整命令**（`已派发 /deploy prod 给 pi。`），超 80 字截断加 `…`；不再只显示首段，
  把参数吞掉（旧回执是 `已派发 /qq 给 pi。`，看起来像 `/qq reload` 的 `reload` 没生效）。
- 为什么要绕一层：pi 只对**扩展命令**执行派发（`prompt()` → `_tryExecuteExtensionCommand`），而
  `reload()` / `newSession()` 又只能在命令上下文里调用。于是本扩展注册了 `/qq`，把 `/reload`
  改派成 `/qq reload`。内置命令名是硬编码的（pi 没有把内置清单导出给扩展）；任何不认识的
  `/xxx` 都会退回当普通文字。
- 桥接命令不会在「换掉运行时」之后再去碰旧 ctx：`reload` / `update` / `new` / `clone` / `quit`
  （以及 `tree` / `fork` / `resume` 的编号选择）会让旧 `ExtensionCommandContext` 立刻失效，之后**读任何
  属性** pi 都会抛 `This extension ctx is stale after session replacement or reload`。这些情况下模型缓存同步
  直接跳过（`REPLACES_RUNTIME` + 防御式读取），不再多报一条错误。

### 忙碌时的队列

pi 的会话一次只跑一轮 agent run，所以串行调度由 bot 自己做：

```text
你：帮我把测试跑一遍
机器人：收到，正在处理
你：顺便看看 README 有没有错别字
机器人：已排队 #1，当前任务结束后自动执行。发 /queue 查看队列，/cancel 可中止当前任务并清空队列。
你：/queue
机器人：当前任务：处理中（发 /cancel 可中断）
       队列：1 条（上限 20）
         1. #1 · 12s 前 · 顺便看看 README 有没有错别字
       发 /queue clear 清空，/queue drop <编号> 删除一条。
机器人：（第一轮结束后）开始执行队列 #1
```

语义：

- 会开启一轮 run 的消息（普通对话、prompt 模板、`/skill:name`）在忙碌时按到达顺序（FIFO）排队；
  回复发给该条消息的发送者。
- 下一条在 pi **settled**（不再有任何自动续跑）之后才启动，所以重试、压缩重试、follow-up 轮次
  不会被从中间撗断。
- 队列上限为 `queue.max`，超出时拒绍入队并回执；`queue.max: 0` 回到旧的「上一条消息还在处理中」。
- 交给 pi 失败时（通常上一轮还没收尾）任务会放回队首重试，不丢消息；已经真的启动过 run 的报错
  不会重试，避免同一条消息执行两次。
- 控制类指令**不排队**：审批回复、`/status`、`/queue`、`/reset`、`/help`、pi 内置命令与 `/cancel`
  都立即生效。
- `/cancel` 会连队列一起清空（“取消”就是“都别做了”）；只想删一条请用 `/queue drop <编号>`。

### 任务进度汇报

任务运行期间，每 `progress.intervalMs`（默认 15 秒）推一条摘要到 QQ：

```
[进度 02:15] · 第 3 轮 · 工具 6 次（bash 4 / read 2）· 失败 1
最近: bash "npm test" · 6.2s
正在: 分析测试输出… · 12.3k tok
```

- 全部由本地事件拼出来（`tool_execution_*`、`turn_end`、`message_end`、`message_update`），
  **不调用模型、不花 token**。
- 工具参数先脱敏再截断，带凭据的命令不会明文出现在 QQ 里。
- **配额感知**：一条用户消息只有 4 次被动回复额度，长任务迟早会用完。第一次发送失败就停掉本轮
  的自动推送（不重试、不刷屏）；你发 `/progress`（或「进度」）即恢复。
- **手动暂停/恢复**：`/progress off`（或「暂停汇报」）在本会话内停掉自动推送——跨 run 保留，
  之后问 `/progress` 也不会把它打开；`/progress on`（或「恢复汇报」）恢复。开新会话（`/new`、重启）后
  恢复默认开启。`/status` 会显示当前处于哪种模式（开启 / 手动暂停 / 配额静默 / 等审批暂缓 / 配置关闭）。
- **审批不被顶走**：有工具审批在等你回复时，自动进度暂缓推送——否则每 15 秒一条进度会把审批提示顶出屏幕；
  你回复（或审批超时）后，下一拍自动恢复。主动发 `/progress` 照旧可用。
- **保护最终答案**：答案因配额发不出去时会被缓存，等你发下一条消息时以
  `（上一条回复发送失败，补发如下）` 前缀补发。
- `agent_settled` / `/cancel` / 会话关闭时定时器都会清掉。
- 想彻底关掉（跨会话）：`progress.enabled: false`（改完需 `/new` 或重启才生效）。

#### 口语说法（整句匹配，只在发整句时生效）

| 意图 | 可以说 |
|---|---|
| 暂停自动汇报 | 「暂停汇报进度」「暂停进度汇报」「别汇报了」「别说了」「闭嘴」「安静」「打住」「停止汇报」，或 `/progress off` |
| 恢复自动汇报 | 「恢复汇报」「恢复汇报进度」「接着说」「说下去」，或 `/progress on` |
| 看一次当前进度 | 「汇报一下当前进度」「看一下进度」「说说进度」「进度如何」「进度怎么样」，或 `/progress` |
| 中断当前任务 | 「停」「停下」「停一下」「停停」「停止」「取消」「别跑了」，或 `/cancel` |

单说「停」是中断**任务**；只有带名词的（「停止汇报」）或明确的闭嘴词（「别说了」「闭嘴」）才是暂停汇报。
「帮我加个进度条」这种任务句仍照常转给 pi，不会被当成口令。

### 取消正在运行的任务

从 QQ 发起的耗时任务（装依赖、编译、agent 跑飞了）不必回到机器上处理：

```
你：/cancel
机器人：已取消当前任务，并终止了 1 个待审批请求，队列中的 2 条已清空。可以发送新消息继续。
```

执行顺序：先终止所有待审批请求、清空队列，再对当前 run 调用 `ctx.abort()`（和 TUI 里按 Escape 同一条路径），
丢弃已经流式产生的半截回答（不会发到 QQ），**忙碌标记保留到 pi 报 `agent_settled`**
（所以 abort 期间新来的消息会排队，而不是和收尾中的 run 撞车），最后回执确认。如果 `agent_settled`
一直不来，8 秒看门狗会强制释放忙碌标记并继续队列。
像「取消自动同意」「恢复审批」这类**只是长得像**取消的回复仍然走审批分支，自动同意开关行为不变。

其余文本都作为用户消息交给 pi。

### 模型欠费 / key 失效时

provider 报错以前在 QQ 侧等于「没反应」：pi 在 assistant 消息上留下 `stopReason: "error"` +
服务端原话，但不产生任何正文，所以桥接没有东西可转。现在错误会被归类
（`billing` / `auth` / `permission` / `rate` / `other`）并回执：

```
❌ 当前模型的余额/额度不足，暂时无法继续对话
当前模型：deepseek/deepseek-flash
服务端原文：402: {"message":"Insufficient Balance (request_id: …)", …}

恢复方式（直接回消息即可，key 我不会写进日志）—
1. 有新 key：只发 key（任意前缀都行，比如 sk-… / ark-… / AIza…，带引号也认）→ 我更新当前模型所属服务的 key
2. 换服务商：发「https://api.xxx.com/v1 <你的 key>」→ 我拉它的模型列表，再把编号发给你挑
3. 先换现成模型：发 /model 看列表，或 /model provider/id 直接切
```

关键在于**恢复动作本身不需要模型活着**——欠费时 agent 已经不可用了，所以这条链路由确定性代码走：

| 你发 | 机器人做什么 |
|---|---|
| `sk-…` / `ark-…` / `AIza…` / 任意一串字符（带 `"引号"` 也认） | 写进 `~/.pi/agent/auth.json`（刚报错的那个 provider），然后用 `GET <baseUrl>/models` **真探测一次**，回执给打码片段与探测结果 |
| `key <任意 key>` | 同上；带显式前缀，**没欠费时也认** |
| `https://api.example.com/v1 <你的 key>` | 探测 `/models`（不带版本号时回退 `/v1`）→ 写 `models.json` + 当前进程注册 → 发编号列表 |
| `endpoint <url> <key> models 模型1,模型2` | 同上，给没有 `/models` 接口的服务用 |

细节：

- **裸 key 只在「刚发生过 402/401」时才当凭据**——否则你随手贴的字符串会被吞掉而不是送给模型；
  显式 `key …` 形式则任何时候都认。带端点时跟在 url 后面的 key 不做长度/熵的额外限制（`ollama` 这种占位 key 也认）。
- key 不落日志、不回显：日志里是 `sk-ab…cd`，离开本机的文本统一过 `redactSecrets()`。
- 写 `auth.json` 用 pi 自己的文件锁 + 原子 rename，**下一次请求就生效**（已实测：磁盘上是坏 key，
  在 `before_agent_start` 里写新 key，同一进程随即请求成功，不用重启）。
- `models.json` 按 pi 的文档格式写，重启后仍在；`pi.registerProvider()` 让当前进程立即可用。
- 新端点的模型参数优先从 pi 内置目录里同 id 模型借（如 `glm-5.3` → `contextWindow: 1e6`、
  `maxTokens: 131072`、`compat.thinkingFormat: "zai"`）；没借到才用保守默认（128k / 16k），回执会说明。
- 过滤 `embedding` / `rerank` / 语音 / 生图等非对话 id；最多注册 40 个，前 10 个做成编号。

### 从 QQ 更新自己

```
你：/update        （或「更新自己」）
机器人：正在检查 pi-qqbot 更新…
机器人：发现新版本 v2.3.0 → v2.4.0，开始更新（pi update，最多等 5 分钟）…
机器人：✅ 已更新到 v2.4.0，正在重载扩展（会话保留，模型上下文不受影响）…
```

走的是 pi 自己的更新链路，不是另造一套：`npm view @zxh126/pi-qqbot version` 查最新版 →
`pi update npm:@zxh126/pi-qqbot` 安装（和发版验收用的是同一条命令）→ `/qq reload`（`ctx.reload()`）。
约束：

- `commands.allowUpdate` 默认 **false**，要在 `pi-qqbot.json` 里显式打开允许 QQ 侧更新。
- 有任务在跑时拒绝（`needsIdle`），与 `/reload`、`/new` 一致。
- **版本校验闸门**：`pi update` 之后磁盘 `package.json` 的版本必须等于 registry 版本；不一致
  （本地提前改过版本号、`pi update` 认为「已是最新」而跳过……）就回执告知并**不重载**。
- `npm view` / `pi update` 失败时不动任何东西，把错误原文回给 QQ。
- 安装目录是共享的：其它还在跑旧代码的 pi 进程要各自 reload / 重启才会换新。
- 自然语言口令刻意收窄：「更新自己」「升级一下插件」「自更新」认，单说「更新」不认。

## 远程审批

```text
[审批 #1] bash: rm -rf node_modules
回复「同意 1」批准，「拒绝 1」拒绝，「停止」终止本轮。
要本会话内全部放行，回复「以后都同意」（可用「取消自动同意」关闭）。
```

`markdownReply: true` 时卡片附带 ✅ 允许一次 / ❌ 拒绝 / 🚀 以后都同意 三个按钮，点按钮与回复等价；
强制审批工具（`qq_send_file`）只显示前两个按钮。无论是否带按钮，文本回复始终有效。

回复用语（审批关键词以中文为主，也支持英文别名；有按钮时点卡片按钮更快）：

| 意图 | 回复 |
|---|---|
| 批准某条 | `同意 1` / `allow 1`；裸 `同意` / `allow` 作用于最早的一条待审批 |
| 拒绝某条 | `拒绝 1` / `deny 1`；裸 `拒绝` / `deny` 作用于最早的一条待审批 |
| 终止待审批 **并中断当前任务** | `停止` / `/cancel` |
| 本会话全部放行 | `以后都同意`、`一直同意`、`全部放行`、`别再问了`、`always allow` |
| 恢复逐条审批 | `取消自动同意`、`恢复审批`、`以后都不同意` |

语义说明：

- **仅当前会话有效**：自动同意开关只存在于内存，`/new`、pi 新会话，或回复「取消自动同意」类用语后立即失效；不写盘、不跨进程保留。
- 该开关是**用户的显式指令**，**不受 `approve.remember` 配置限制**。
- `approve.remember: true` 时会额外**按工具名**记住决策：同意过一次 `bash`，本会话后续 `bash` 不再询问（`/new` 清除）。
- 审批请求 **10 分钟**超时后自动拒绝并通知；超时**不会**被记成“拒绝”，下次仍会询问。
- 没有待审批请求时，这类文本会作为普通消息转交给 pi。

## 单实例锁

QQ 网关对同一 bot 只保留一个活跃连接。插件用 `proper-lockfile` 文件锁（`~/.pi/agent/pi-qqbot-<appId>.lock`）：

- 抢到锁的进程 = 宿主，连接 QQ；
- 其余进程待命，每 5 秒重扫，**列表里任何一个空闲的 bot** 都能抢；
- 宿主退出或崩溃（30 秒心跳超时）后，待命进程自动接管；
- 只是重建会话（`/reload`、`/new`、`/fork`、`/resume`）的宿主会在锁旁留 20 秒预约，别人不会趁空抢走；
- 上一位持有者的 pid 与工作目录记在 `~/.pi/agent/pi-qqbot-<appId>.owner.json`，用来提示「换进程接管」以及新实例的工作目录。

## 前置条件

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 **AppID** 与 **AppSecret**。
2. 未上线阶段配置**沙箱单聊账号**，并把 `sandbox` 设为 `true`。
3. 正式环境填写服务器公网出口 IP 白名单。

## 日志

调试日志写入 `~/.pi/agent/pi-qqbot-<name>.log`（按 bot 分文件，同机多进程不交错）；单 bot 旧格式仍写 `pi-qqbot.log`。每行开头是**本地时间 + 时区偏移**（如 `[2026-10-24T07:39:09.762+08:00]`），和文件 mtime、进程启动时间直接对得上，不需要再拿 UTC 换算。

## 变更日志

见 [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md)：每个版本改了什么、为什么改。（English: [CHANGELOG.en.md](../CHANGELOG.en.md)）进度汇报的暂停/恢复（`/progress off` / `on`）在 **1.5.0** 加入；多 bot 自动抢占在 **2.0.0**；接收 QQ 图片/文件（落盘后以 `图片路径 <path>` 这类标记行交给 pi）在 **2.1.0**；把本机文件发到 QQ（`qq_send_file` / `/sendfile`，富媒体分片上传）在 **2.2.0**。

## License

MIT
