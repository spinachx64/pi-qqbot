# Changelog

本文件记录 pi-qqbot 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 英文版 changelog：[CHANGELOG.en.md](CHANGELOG.en.md)

## [2.8.0] - 2026-11-07

### Changed

- **凭据环境变量改用自带前缀 `PI_QQBOT_`**：`QQ_BOT_APPID` / `QQ_BOT_APPSECRET` →
  `PI_QQBOT_APPID` / `PI_QQBOT_APPSECRET`（其余自带变量 `PI_QQBOT_ACCOUNT`、`PI_QQBOT_PROGRESS_MS`
  本来就是这个前缀）。同名变量不再被两个 QQ 桥接工具共用，避免「一个环境里设一次、两个工具都吃到」。
  `QQ_BOT_*` 作**弃用别名**保留（仅在对应 `PI_QQBOT_*` 未设时生效），后续大版本移除。

### Compatibility

- 无需改动即可升级：只设了 `QQ_BOT_APPID/SECRET` 的脚本仍能工作。两个都设时以 `PI_QQBOT_*` 为准，
  所以想确认「新名真的生效」就直接把旧名删掉。

### Tests

- `test/config.test.mjs`：`clearEnv()` 覆盖新旧四个变量；新增用例「旧名可用 + `PI_QQBOT_*` 优先」；
  原有「v1 仅靠环境变量」用例改读新名。12/12 通过。

## [2.7.0] - 2026-11-07

### Changed

- **外发文件审批改为可配置**：新增 `files.forceApproval`（默认 `false`，可按 bot 逐账号覆盖）。`true` 保持旧的
  硬性门禁——agent 发起的 `qq_send_file` 每次单独确认，不吃会话级「以后都同意」与记住的决策，文案仍是
  「需单独确认」；`false`（新默认）按普通审批规则走：只有 `qq_send_file` 出现在 `approve.tools`（或带
  `destructiveHint` 注解）时才审批，此时自动同意 / 会话内记忆与其他工具一样生效。QQ 里直接发的
  `/sendfile` 仍然从不审批。
- `/help` 与 `qq_send_file` 工具描述不再声称审批是无条件的。

### Compatibility

- **升级即行为变化**：默认配置下 agent 发文件不再在 QQ 里询问。想保留审批但减少打扰：把 `"qq_send_file"`
  加进 `approve.tools`；想完全保留旧的每次必问：配置 `files.forceApproval: true`。

### Tests

- `test/queue.test.mjs`：强制审批用例改为显式 `files.forceApproval: true`；新增默认行为用例
  （配置里连 `files` 键都没有 → 静默放行；加进 `approve.tools` → 问一次、决策写入记忆，之后不再问）。
- `test/config.test.mjs`：新增 `files.forceApproval` 默认值 / 全局 / 账号逐键覆盖用例。

## [2.6.2] - 2026-11-01

### Fixed

- **`/qq …` 绕过命令门禁**：`/qq` 本身就是扩展命令，所以直接发 `/qq reload`、`/qq quit`、`/qq new`
  会落进 `routeSlash` 的 passthrough 分支，既不查 `commands.allowReload` / `allowQuit` / `allowUpdate` /
  `allowSession`，也不查忙碌状态（`needsIdle`）——默认配置（`allowQuit: false`）下 QQ 侧发 `/qq quit`
  就能把主机 pi 关掉。现在 `/qq` 在 passthrough **之前**分流：`bridgeGate()` 把子命令翻回内置命令名
  （多词 `list tree` / `list fork` / `list resume` 先整体匹配），复用同一套 `allowed()` / `needsIdle` 判定。
- **派发回执吞掉参数**：`/qq reload` 过去回「已派发 /qq 给 pi。」——`parseSlash` 只取首段当命令名，
  看起来像 `reload` 没被受理。现在回执与日志都显示完整命令（超 80 字截断加 `…`）。

### Changed

- 自毁类桥接子命令（`reload` / `new` / `quit` / `clone`）改为**先回执再派发**，避免回执和
  `ctx.reload()` / `newSession()` 抢时序。
- `/qq sendfile …`、`/qq usage …`、`/qq pick …` 以及未知子命令不再额外发一条通用回执（子命令自己会回），
  减少一次无意义的消息。
- 顺手清掉 `slash.ts` 里一处历史补丁残留的空行 `+`（`+reply(formatPicker(picker))`，语义上无害但脏）。

### Compatibility

- 发 `/reload`、`/new`、`/quit`、`/compact` 等原命令的行为与门禁不变；只是 `/qq <sub>` 现在受同样约束。
- 无需改配置：原本 `allowReload: true` 的部署照旧可用；`allowQuit: false`（默认）下 `/qq quit` 变成回执拒绝。

### Tests

- 新增 `test/qq-bridge-gate.test.mjs`（21 条断言）：子命令映射、三种门禁拒绝、忙碌拒绝、
  先回执后派发顺序、多词 sub、回执截断、`/reload` 未回归。
- 全套 274 条断言 / 22 个测试文件通过；`tsc --noEmit --strict` 对改动文件 `slash.ts` 无报错。

## [2.6.1] - 2026-11-01

### Changed

- **changelog 分语种**：中文版更名 `CHANGELOG.zh-CN.md`，新增英文版 `CHANGELOG.en.md`（含全部历史版本）；
  README.md（英文）引用 `CHANGELOG.en.md`，docs/README.zh-CN.md 引用 `CHANGELOG.zh-CN.md`。

## [2.6.0] - 2026-11-01

### Added

- **审批与单选列表支持内联按钮**：审批卡片附带「✅ 允许一次 / ❌ 拒绝 / 🚀 以后都同意」按钮
  （强制审批工具只有前两个）；/tree、/fork、/resume 与模型选择列表附带选项按钮（2 列、最多 5 行，
  label 超 10 字符截断，正文仍保留完整列表）。按钮只在 markdown 回复（`markdownReply=true`）时附带。
- **`INTERACTION_CREATE` 事件链路**：网关新增 `1<<26` 意图订阅与互动事件分发；`QQApi.acknowledgeInteraction`
  在 5 秒窗口内 `PUT /interactions/{id}` 回应（命中 ACK 0，过期/越权/越界 ACK 3 重复操作）。
- **`qq/keyboard.ts`**：键盘构建与 `button_data` 编解码（顶层 `t` 字段路由 approval / pick）。

### Changed

- `QQApi.sendC2C` 的 `SendOptions.keyboard` 只随 markdown 消息发送；markdown 失败回退纯文本时自动丢弃键盘。
- `replyTo` / `bridgeReply` 增加可选 `keyboard` 透传；选择按钮点击复用「回复编号」的 `/qq pick` 派发路径，
  审批按钮点击复用 `Approver.confirm` / `allowAll`，文本回复（同意/拒绝 N、编号）全部保留为兜底。

### Compatibility

- `markdownReply=false` 时行为与之前完全一致（键盘不附带、纯文本回复）。
- 自定义按钮需 QQ 开放平台「内邀开通」；未开通时按钮不渲染，编号/文本回复不受影响。

## [2.5.0] - 2026-11-01

### Added

- **`markdownReply` 配置生效**：置 `true` 后回复统一走 QQ markdown 消息（`msg_type=2`），GFM 表格、
  代码块等由 QQ 客户端渲染。此前该配置只被解析、从未被消费。发送失败（如无 markdown 权限）由
  `qq/api.ts` 自动回退纯文本，行为安全。
- **`util/chunk.ts` 切分器防拆表格**：`splitText` 把 GFM 表格整块保留（表格行先入缓冲、遇到非表格行
  再整块提交），代码块边界不作切分点；长回复不再出现被拦腰截断的破表。

### Changed

- 回复格式由 `state.cfg.markdownReply` 决定：`replyTo` 的 `format` 默认值改为 `auto`，最终答案、
  错误通知、审批提示与各回执统一生效；仍可显式传 `"text"` 强制纯文本。

### Compatibility

- `markdownReply` 默认仍为 `false`，未开启时行为与之前完全一致。

## [2.4.1] - 2026-11-01

### Added

- **`!` / `!!` 在 QQ 侧明确回执，不再静默丢给模型**：这两个前缀（含全角 `！` / `！！`）只在 pi 主机
  TUI / RPC 前端被当成 shell 命令（`interactive-mode` 的 `text.startsWith("!")`、RPC 的 `bash` 控制命令），
  扩展 API 没有等价能力（`pi.sendUserMessage()` 不分派它们，`pi.exec()` 不过审批、不写会话历史）。现在
  `routeSlash()` 的第一步就拦下来，回一条说明：为什么不能执行，以及该怎么做（用中文说需求，走 `bash`
  工具并在执行前审批）。既不执行，也不当聊天送给模型。
- **`/help` 增补一行**：说明 `!` / `!!` 不支持。

### Changed

- **判定刻意收紧**：只有「前缀 + 非空命令」才算 bang 命令（单独 `!`、`!!`、`!!!`、`/xxx`、句末感叹号
  `你好!` 都照旧走普通对话），避免把情绪化感叹号吞掉。

### Fixed

- **`/qq reload` 不再报 `This extension ctx is stale after session replacement or reload`**（`/new`、
  `/clone`、`/resume`、`/fork`、`/tree` 的编号选择同理）：`runBridge()` 之后处理器还要 `syncModelFromCtx()`
  读一次 `ctx.model`，而 `reload()` / `newSession()` / `fork()` / `switchSession()` / `navigateTree()`
  一返回，pi 就把旧 `ExtensionCommandContext` 的**每个 guard getter 都变成抛错**（`runner.js` 的
  `createCommandContext` 刻意保留 lazy descriptors）。现在：新增 `REPLACES_RUNTIME`
  （`reload` / `update` / `new` / `quit` / `clone`），换过运行时就直接跳过 ctx 收尾；`syncModelFromCtx()`
  自身也容错（`pick` 选 tree/fork/resume 这类运行时才知道的分支靠它兜底）；桥接抛错后也不再继续碰 ctx。
  回归用例 `test/bridge-stale-ctx.test.mjs` 用「替换后任何 getter 都抛 stale」的假 ctx 复现原报错栈
  （`syncModelFromCtx` ← `handler`）：修前 3 例失败、修后 5 例全绿。

### Compatibility

- 纯新增分支：斜杠命令路由、审批、队列、进度、凭据接手都不受影响。
- 行为变化仅一处：`!xxx` / `!!xxx` 以前是「当作普通正文送给模型」，现在是「回执不执行」。如果之前靠发
  `!xxx` 让模型自己去调 `bash`，请改成正常描述需求。
- 带附件的消息仍绕过所有指令路由（含 bang 判定），与原来一致。
- `/reload`、`/update`、`/new`、`/clone` 的**功能**还是原来的（会话确实被替换/重载），只是不再多报一条错误。
- 测试：新增 `test/bang-notice.test.mjs`（6 例）、`test/bridge-stale-ctx.test.mjs`（5 例），
  `npm test` 19 个用例文件全绿。
- 升级无痛：配置格式、命令名、审批与队列语义均未变；`!` / `!!` 之前就是「不执行」，只是从「静默丢给模型」
  改成「明确回执」。

## [2.4.0] - 2026-11-01

### Added

- **模型欠费 / key 失效时不再沉默**：provider 报错时 pi 只在 assistant 消息上留下 `stopReason: "error"`
  + `errorMessage`，**不产生任何正文**，所以 QQ 侧以前只能看到「没反应」。现在 `message_end` 会把错误
  归类（`billing` / `auth` / `permission` / `rate` / `other`）并在 `agent_settled` 回执：点名**当前模型**
  （`provider/model`）、附服务端原文、给三条恢复路。401/402/`1311 套餐未开放` 都走「可恢复」分支；
  有正文的报错、用户取消的 run、以及 500 类错误行为不变。
- **远程换 key**：欠费后直接发一串 key（`sk-…` / `ark-…` / `AIza…` / 十六进制 / base64 / 本地服务占位串
  `ollama`，带引号或反引号也认）→ 写进 `~/.pi/agent/auth.json` 的对应 provider，再用 `GET <baseUrl>/models`
  真探测一次，回执给打码片段与探测结果。**不假设 `sk-` 前缀**：判据只有「非空 + 可打印 ASCII + 无空白」；
  裸串（整条消息就是 key）额外要求长度 ≥12 且带数字/大写/分隔符，避免把 `configuration.ts` 这类正文吞掉。
- **QQ 里接入新 endpoint**：发 `https://host/v1 <key>` 或 `endpoint <url> <key> models a,b` → 探测 `/models`
  （不带版本号时回退 `/v1`；401/403 立刻判 key 无效）→ 过滤 `embedding`/`rerank`/语音/生图等非对话 id →
  写 `models.json` + `pi.registerProvider()`（当前进程立即可用）→ 发**带上下文大小的编号列表**，
  回编号即 `pi.setModel()` 切过去（复用现有 picker，10 分钟有效）。provider id 自动取 `qq-<host>`，撞名加序号。
- **模型参数向内置目录看齐**：`/models` 通常只给 id，所以 `borrowModelMeta()` 按模型 id 从
  `modelRegistry.getAll()`（内置 catalog + 已配置 provider）借 `contextWindow` / `maxTokens` / `reasoning` /
  `input` / `thinkingLevelMap` / `cost` / `compat` / `inputLimits`；排序为「同 host > 同厂商域名族 >
  `openai-completions`」。借不到才用保守默认（128k / 16k），回执会明说有几个是补全的、几个是默认值。
- **从 QQ 更新自己**：`/update`（或「更新自己」「升级一下插件」「自更新」）→ `npm view` 查最新版 →
  **`pi update npm:@zxh126/pi-qqbot`** → **版本校验闸门**（磁盘 `package.json` 必须等于 registry 版本，否则只回执不重载）
  → `/qq reload`（`ctx.reload()`）。自然语言口令刻意收窄，单说「更新」不认。

### Changed

- **配置 `commands.allowUpdate`**（默认 `false`，与 `allowReload` / `allowQuit` 同风格）：`/update` 与
  「更新自己」的门禁；顶层默认值 + 每个 bot 逐键覆盖。
- **`PickerKind` 新增 `model`**：编号选择支持「新接入服务的模型」，选完直接 `pi.setModel()`；模型已不在目录时
  不静默，提示重新 `/model`。
- **错误提示与日志**：`errorMessage` 统一过 `redactSecrets()` + 压空白 + 截 600 字；错误分类与当前模型写进
  `pi-qqbot.log`（`[reply] 本轮模型接口报错: <类别> <provider/model> <原文>`），事后可排查。

### Compatibility

- 纯增量：不配 `commands.allowUpdate` 时没有任何行为变化；不处于欠费/鉴权失败状态时，裸 key 不会被当成凭据
  （显式 `key …` 除外）。
- 需 pi 提供 `message_end` 的 `stopReason` / `errorMessage`、`pi.registerProvider()`、`pi.setModel()`（现版 pi 1.4.x 均具备）。
- 写盘只碰 pi 自己的 `auth.json` / `models.json`，用 pi 同款 `proper-lockfile` + 原子 rename；`models.json`
  只增改自己的 provider，不动别人。
- 安装目录共享：`/update` 只更新磁盘，其它仍在跑旧代码的 pi 进程需各自 reload / 重启。

### Tests

- 共 **14 套 / 191 条**全绿（`npm test`）。
- 新增 `test/billing.test.mjs`（26）：错误分类、中文文案、`parseCredentialMessage` 各类写法、
  `looksLikeSecret`（含非 `sk-` 前缀 6 种形态、显式/裸串两档松紧）、`stripWrapping`、`normalizeBaseUrl` /
  `extractModelIds`、`probeEndpoint`（成功 / `/v1` 回退 / 401 立即返回 / 网络异常）、`providerIdForEndpoint`、
  `borrowModelMeta`、`filterChatModelIds`、`modelLabel`、`updateProviderKey` / `upsertEndpointProvider` 落盘。
- 新增 `test/credential-intake.test.mjs`（11）：走真实 `handleMessage`——欠费发裸 key、没欠费不吞、显式前缀、
  endpoint 注册 + 编号列表、元数据借用、探测 401、带 `models` 重发、编号选择 `setModel`、非 `sk` 前缀 key、带引号 key。
- 新增 `test/selfupdate.test.mjs`（13）：版本比较（含 prerelease）、npm 输出解析、五种流程结局
  （最新 / 已更新 / 检查失败 / 更新失败 / 版本不一致）、`isUpdateSelfIntent`、`/update` 门禁。
- 新增 `test/error-notice.test.mjs`（8）：402 / 401 / 500 / 有正文 / 取消 / 跑通后作废 / 凭据闸门 / 脱敏。

## [2.3.0] - 2026-10-31

### Added

- **远程上下文提醒**：`before_agent_start` 里先判断「这一轮是不是本扩展刚派发的 QQ 消息」，是才把一段说明写进
  系统提示的 `qq-remote-context` section（排在用户消息之前，QQ 侧与 TUI 都看不到）：说明对话来自远程 QQ 用户、
  对方看不到本机屏幕与弹窗；默认**禁用桌面截屏 / 屏幕 OCR / UI 自动化 / 键鼠模拟 / 带界面的浏览器**
  （点名 `mcp__screenshot`、`mcp__winui`），需要图就离屏渲染生成 PNG 再用 `qq_send_file` 发回，
  只有确认是否锁屏时才允许截一次桌面。**仅仅载入扩展、或本机 TUI 直接对话时都不注入**，必须等第一条 QQ 消息真的开跑。
- **系统提示规则**：每次**来自 QQ 的** run 追加三条短规则（远程用户 / 锁屏→离屏渲染 /
  需要人工就直说），避免长会话被压缩摘要后丢失；同一轮重复触发不叠加，本机 TUI 自己的 run 不加。
- **压缩后重注入**：`session_compact` 之后清掉「已提醒」标记，下一条消息重新注入。
- **配置 `remote`**：`notice`（默认 `true`，每会话一次）、`guidelines`（默认 `true`）、`extra`（追加到提醒末尾，
  默认空）；顶层默认值 + 每个 bot 逐键覆盖。
- **本机接管更正**：同一个会话里「上一轮来自 QQ、下一轮本机 TUI 直接打字」时，本机那一轮注入一次
  `qq-local-handoff` section（「远程 QQ 用户」前提作废：可正常截屏、不需要 `qq_send_file`），连续本机对话不重复；
  用 `input` 事件的 `source=interactive` 识别（本扩展的 `sendUserMessage` 是 `extension`，不会误判）；
  QQ run 跑到一半时插话不算接管（没有新的 run）。`/status` 新增「来源: QQ（远程）/ 本机（TUI）」。

### Fixed

- **等审批期间不再推自动进度**：有工具审批在等用户回复时，自动进度推送暂缓（否则每 15s 一条进度会把审批提示
  顶出屏幕），审批处理完（或超时）后下一拍自动恢复；主动问 `/progress` 不受影响；`/status` 会显示
  「等审批期间暂缓」。本会话内手动暂停（`/progress off`）与配额静默的语义不变。

### Tests

- 新增 `test/remote-notice.test.mjs`（默认值 / 文案要素 / `extra` 追加 / 系统规则长度）。
- `test/config.test.mjs` 新增 `remote` 全局默认 + 账号逐键覆盖用例。
- `test/accounts.test.mjs` 新增 3 个用例：**本机直接对话不注入**、第一条 QQ 消息的 run 才注入且每会话一次、
  压缩后重注入；`remote.notice=false` 只关说明、`remote.extra` 追加；`remote.guidelines=false` 只关规则，
  且同一轮重复触发不叠加。
- `test/progress.test.mjs` 新增用例：等审批期间不推送、`/status` 显示暂缓、手动问进度仍回一次、审批处理完自动恢复。
- `test/accounts.test.mjs` 再加 2 个用例：本机接管只更正一次（`/status` 显示来源）；交接待定会被新的 QQ 轮覆盖，
  `source=extension` 的 input 不算接管。
- `test/remote-notice.test.mjs` 加 `qq-local-handoff` 的 tag 与文案断言。

## [2.2.1] - 2026-02-11

### Fixed

- **把「文案」当成了「指令」**：用户把审批提示整段引回来（或以「你这句话里说『取消自动同意』」这种句子讨论），
  旧代码用**未锚定**的正则，句子里出现「取消自动同意」「以后都同意」就会被当成真的审批动作（日志里能看到
  回了一句「当前没有开启自动同意」）。现在 `parseReply` 先去掉空白与标点做**整句匹配**，并卡长度上限（≤ 12 字），
  引用提示、长句、感叹句一律不解析，当普通聊天交给 pi。
- **审批提示太啰嗦**：从 3 行（含「停止」「以后都同意」「取消自动同意」三句）压到 2 行：
  `[审批 #N] <摘要>` + `回「同意 N」或「拒绝 N」；想全部放行回「以后都同意」。`；
  发文件这类每次都要确认的工具改用 strict 文案（不提「以后都同意」）。

### Tests

- 新增 `test/approver.test.mjs`（6 个用例：批/拒的各种写法、停止/以后都同意/取消自动同意、
  引用提示不解析、句中关键词不解析、「停止汇报」不算指令、超长句不解析、提示文案≤两行）。
- `test/queue.test.mjs` 同步 strict 文案断言（19 个用例）。

## [2.2.0] - 2026-02-11

### Added

- **把本机文件发到 QQ**：新增工具 `qq_send_file(path, name?)` 与命令 `/sendfile <路径>`。按官方富媒体接口走
  分片上传（`upload_prepare` → 分片 `PUT` → `upload_part_finish` → 合并拿 `file_info`），再用
  `msg_type=7` + `media.file_info` 以**被动回复**发出（`srv_send_msg:false`，不烧主动额度）。
  本地文件没有公网 URL，而二进制直传只有 5MB 上限，所以统一走分片，不依赖中转。
- **`file_type` 判定**：png/jpg/jpeg → 图片(1)、mp4 → 视频(2)、silk → 语音(3)、其余 → 文件(4)；
  否则 QQ 报 `850019`。图片/视频/语音直接展示，其他格式对方收到可下载的文件卡片。
- **外发文件强制审批（每次都要问）**：`qq_send_file` 被加入 `FORCE_APPROVAL_TOOLS`，无论 `approve.tools` 怎么配都
  必须先回 QQ 审批；并且**跳过会话级「以后都同意」与记住的决策**，每个文件单独确认，也不会写入 remember。
  审批文案会显示文件路径与显示名，并注明「需单独确认」。
- **配置 `files`**：`enabled`（默认 true）、`maxBytes`（默认 30MB；QQ 硬限 200MB），可按 bot 逐键覆盖。
- **错误码翻译**：`850031` 超大、`850019` 格式不支持、`40093002` 今日容量上限、`850027` 超时、
  `850018` 禁言/限频、`40093001` 转存失败，都转成中文回执。

### Changed

- `qq/api.ts`：新增 `sendC2CMedia(openid, fileInfo, { msgId })`，复用已有的发送队列与 `msg_seq` 计数。
- `slash.ts`：新增可接管命令 `sendfile`（不受 `commands.allowSession` 限制，由 `files.enabled` + 审批把关）。
- `index.ts`：`State` 记录 `restBase`；`/help` 增加 `/sendfile` 说明。
- `package.json`：新增 peer 依赖 `typebox`（工具参数 schema，pi 运行时已内置别名）。

### Tests

- 新增 `test/upload.test.mjs`（9 个用例：file_type 映射、md5/sha1/md5_10m、分片全链路与字节回拼、
  图片类型、分片失败重试、本地校验（不存在/目录/空文件/超限）、合并缺 `file_info`、错误码翻译、
  `sendC2CMedia` 的 `msg_type=7` 请求体）。
- `npm test` 新增该文件；全套 130 → 140 个用例全绿（queue 18 → 19，新增「发送文件每次都审批」）。

## [2.1.0] - 2026-02-11

### Added

- **接收 QQ 附件（图片 / 语音 / 视频 / 文档 / 压缩包 / 普通文件）**：收到的附件马上下载到临时文件，
  再把路径以标记行交给 pi——图片是 `图片路径 <path>`，其余按类型是 `语音路径` / `视频路径` /
  `文档路径` / `压缩包路径` / `文件路径`。原有文字保持在第一行，与路径同属一轮对话；pi 的 `read` 工具
  可以直接打开图片，`bash` 可以处理文件。（v2.1.0 之前只保留图片且完全没落盘，纯图片消息会给 pi 送空串。）
- **QQ 回执**：落盘后先回一条「已收到 N 个附件（图片 ×1、文档 ×1），已存为临时文件并交给 pi：」+ 各条路径；
  下载失败会列出原因，文字部分照常执行。
- **临时文件自动清理**：落盘目录按日期分子目录（`<系统临时目录>/pi-qqbot/<bot>/<YYYY-MM-DD>/`），
  每次会话启动时按 `attachments.retentionHours`（默认 24 小时）与 `attachments.maxFiles`（默认 200）
  清理；目录里不是本插件建的 `<日期>` 子目录一律不动。
- **配置 `attachments`**：`enabled` / `dir` / `maxBytes` / `maxPerMessage` / `retentionHours` / `maxFiles`，
  支持像 `queue` / `progress` 一样在 `qqbots[]` 里逐 bot 覆盖。`enabled: false` 时回一句忽略提示、只处理文字。
- **新的 `attachment.ts`**：六类判定、文件名规整（只保留 `[0-9a-zA-Z._-]`）、并发下载（默认 3）、
  单个 25 MB 上限、下载超时 30 秒、401/403 带凭据重试一次、失败不影响其它附件。

### Changed

- `qq/gateway.ts`：`QQMessage.attachments` 改为 `{ url, contentType, filename?, size? }[]`，
  **不再丢弃非图片附件**；语音消息的消息体只有 `voice_wav_url` 时也取它当下载地址。
- 网关日志不再打整包 JSON（里面带 `rkey` 临时凭据），改为 openid / content 摘要 / 附件数量 / 来源主机。
- `handleMessage()`：带附件的消息**绕过**斜杠命令、审批解析、编号选择与内置指令，一律当普通内容（忙碌时照旧入队）。

### Tests

- 新增 `test/attachment.test.mjs`（12 个用例：六类判定、扩展名、落盘内容、超限、401 重试、部分失败、
  单条上限、回执文案、目录清理）。
- `test/queue.test.mjs` 12 → 18 个用例（纯图片派发、文字+文档拼行、忙碌入队、`enabled=false` 忽略提示、
  绕过 `/status`、下载失败照发正文）。

## [2.0.1] - 2026-10-25

### Fixed

- **口令语序：「暂停汇报进度」之前不被识别**，会漏成普通对话丢给模型。现在「暂停**进度汇报**」与
  「暂停**汇报进度**」两种语序都认；「别汇报了**吧**」这类双尾字也不再漏。

### Changed

- **口语静音词扩充**：「别汇报了」「别说了」「别讲了」「别推了」「别发了」「别报了」「闭嘴」「安静」
  「打住」「甭」等，与 `/progress off` 等价（恢复用「恢复汇报」「接着说」）。
- **「停」改为中断任务**（按用户反馈）：`停`/`停下`/`停一下`/`停停`/`停掉`/`别跑了` 归入 `RE_CANCEL`，
  与 `/cancel` 完全等价；只有带名词的「停止汇报」或纯闭嘴词才是静音。
- **主动问进度归为指令**：「汇报一下当前进度」「看一下进度」「说说进度」「进度如何」「进度怎么样」
  不再当聊天转给 pi，忙时回一次摘要且不入队，空闲时直接回「当前没有正在运行的任务」。
- `/help` 区分两种语义：只关推送用 `/progress off`/「别汇报了」/「闭嘴」；「停」是中断任务。
- 两份 README 新增「口语说法」对照表（意图 → 可说的话）。

### Tests

- `test/progress.test.mjs` 16 → 22 个用例（新增 / 改写：语序两边、口语静音词、
  「停/停下/停一下/停止/取消」均为中断、「停止汇报」仍为静音、主动问进度三姿态、口令不误伤）。

## [2.0.0] - 2026-10-25

### Added

- **多 QQ bot（一份配置、一台机器、多个 pi 进程）**：配置里用 `qqbots: [...]` 写多组
  `appId` / `appSecret`，支持 `name`、以及逐账号覆盖 `sandbox` / `allowlist` / `queue` /
  `progress` / `approve` / `commands`（未写的继承全局默认值，逐键合并）。
- **自动抢占**：每个 pi 进程启动时（`session_start`）按配置顺序找第一个**未上线**的 bot 接入；
  抢不到的进程不接入 QQ、但每 5 秒重扫，别人退出后接管。一进程一把锁，绝不并发多接。
- **「不抢别人 reload 中临时释放的 bot」**：会话重建（`/reload`、`/new`、`/fork`、`/resume`）时，
  释放锁**之前**写 20 秒预约窗口，其他进程跳过该 bot；抢锁后还会二次读预约记录，
  撞上就让出（关掉竞态窗口）。新 runtime 用同一 pid 认回自己的 bot，静默不打扰。
- **身份可见**：接入日志带 bot 名称 / appId / cwd / pid；QQ 首条回执前加「（已接入 qqbot「work」）」；
  `/status` 首行显示 `bot: work (…0143) · cwd: …`。
- **换进程接管提示**：`~/.pi/agent/pi-qqbot-<appId>.owner.json` 记录上一位持有者的 pid 与工作目录，
  换进程时日志写新旧 pid/cwd，QQ 首条回执带「（qqbot「work」已由新实例接管 · 当前工作目录 …）」。
- `PI_QQBOT_ACCOUNT=<name|appId>` 钉选账号（调试/固定目录用），名字不存在则不接入并写日志。
- **抢占后先验凭据**：抢到锁立即换一次 `access_token`，失败就**放锁**并跳过该 bot（继续试下一个），
  避免「凭据写错的 bot 占着锁位但永远连不上」；全部不可用时不空转重扫。
- **修复** `AuthManager`：QQ 平台对无效凭据返回 HTTP 200 + `code 100016`，以前只拿空 token 去连网关，
  现在直接抛错（带 code/message），并在抢占阶段被发现。
- 新增文档 [docs/accounts.md](docs/accounts.md)；新增测试 `test/config.test.mjs`（9）、
  `test/lock.test.mjs`（8，真子进程 + 真 lockfile，含「同一工作目录也能各接一个」）、
  `test/accounts.test.mjs`（9，端到端抢占/提示/凭据无效降级）、`test/auth.test.mjs`（3）。

### Changed

- 日志按账号分文件：`~/.pi/agent/pi-qqbot-<name>.log`（同机多进程不再交错）；
  单 bot 旧格式仍写 `pi-qqbot.log`。
- `/status` 增加 bot 身份与工作目录行；`/help` 增加多 bot 说明。
- 配置加载改为 `loadAccounts()`（返回按顺序排好的账号列表），`loadConfig()` 保留为兼容包装。

### Compatibility

- **旧的单 bot 配置零改动可用**（等价于名为 `default` 的账号，行为与 1.5.0 一致）；
  `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` 仍只用于单 bot 场景。
- 同时写顶层 `appId` 与 `qqbots` → 报错不接入（歧义不猜）；单个账号凭据缺失/`appId` 重复/`name`
  重复 → 跳过该条并写日志，其余照常。
- **bot 与工作目录无绑定**：分配只看配置顺序与在线状态，与 cwd 无关——同一目录开多个 pi
  也照样一人接一个 bot。cwd 仅用于日志、接管提示与 `/status` 展示。
- 升级后建议重启（或 `/reload`）一次：新版本启动时才会按账号分文件写日志。

## [1.5.0] - 2026-10-25

### Added

- **暂停 / 恢复自动进度汇报（会话内有效）**：`/progress off`（别名 `/p pause`、`暂停`、`stop`、
  「暂停汇报」「关闭自动汇报」）停掉定时推送，`/progress on`（别名 `resume`、`start`、`恢复`、
  「恢复汇报」「继续汇报」）重新打开。
  - 手动暂停跨 run 保留（`agent_start` 不再顺手复位），只在 `session_start`（`/new`、`/reload`、重启）复位为默认开启。
  - 手动暂停期间，`/progress`、「进度」、「当前进度」、「现在进度」、「进展」**只回一次当前摘要**，
    不会偷偷把 15 s 定时器打开，回复末尾附「（自动汇报已暂停，发 /progress on 恢复）」提示。
  - 与原有的「配额静默」严格区分：配额静默是发送失败后的自动暂停，问一次进度即恢复；
    手动暂停只有 `on`/「恢复汇报」能解除。
  - `/progress <看不懂的参数>` 回用法提示，不再静默忽略。
- `/status` 新增 `自动汇报:` 一行，区分四种模式：`开启（每 Ns）` / `已暂停（本会话…）` /
  `推送失败已静默` / `未启用（配置 progress.enabled=false）`。
- 裸文本口令「当前进度」「现在进度」「目前进展」（可带子命令，如「进度 暂停」）也走进度查询。
- 测试：`test/progress.test.mjs` 新增 7 个用例（暂停/恢复即时生效、跨 run 保留、暂停后手动查看不解除、
  中文口令且不误伤任务句、空闲时问「当前进度」、`/status` 文案、未知子命令）。

### Changed

- `/progress`（无参数）在**手动暂停**状态下不再解除暂停（此前任何一次问询都会清掉暂停标志）。
- 「推送失败已静默」与「用户手动暂停」拆成两个独立状态（`progressPaused` / `progressMuted`），
  互不覆盖。
- README（英文）与 `docs/README.zh-CN.md` 的指令表、进度小节、`progress.enabled` 说明同步更新。

## [1.4.0] - 2026-10-24

### Added

- 任务运行期间按 `progress.intervalMs`（默认 15 s）推送进度摘要：轮次、工具调用次数与前三名、
  失败次数、最近完成的工具（含耗时）、正在跑的工具、token 用量。全部由本地事件拼装，
  不调用模型、不消耗 token。
- 全链路敏感信息脱敏（`redact.ts`）：进度摘要、审批提示、队列预览、日志落盘统一过一遍，
  覆盖 `Authorization` / QQ bot token / `sk-…` / `ghp_…` / `npm_…` / `AKIA…` / JWT / PEM /
  `token=` / `password=` / `--api-key` / URL `user:pass@` / 高熵串。
- `/progress`（别名 `/p`、「进度」）与忙碌时的「到哪了」「怎么样了」问询。
- 最终答案因配额发不出去时缓存，下条消息以「（上一条回复发送失败，补发如下）」补发。
- 配置 `progress.enabled` / `progress.intervalMs`（环境变量 `PI_QQBOT_PROGRESS_MS` 可覆盖）。

## [1.3.3] - 2026-10-24

### Fixed

- `/usage` 报告读回改为轮询等待：`appendEntry` 晚于命令 `await` 返回，导致偶发读不到刚写入的报告。

## [1.3.2] - 2026-10-24

### Fixed

- `/usage` 读回兜底：`getEntries` 尚未刷新时直接读会话文件尾部；`generatedAt` 兼容毫秒时间戳。

## [1.3.1] - 2026-10-24

### Fixed

- `/usage rate` 真正执行并读回配置文件确认，不再「口头成功」。

## [1.3.0] - 2026-10-24

### Added

- `/usage`、`/cost`（只往 `ctx.ui.*` 输出的扩展命令）桥接回 QQ，不再沉默。
- `/mcp`、`/llama` 这类需要主机 TUI 选择框/登录的命令改为明确回执说明。

## [1.2.1] - 2026-10-24

### Changed

- 日志时间戳改为本地时间并带 UTC 偏移（如 `[2026-10-24T07:39:09.762+08:00]`），与文件 mtime、
  进程启动时间直接对齐，不再需要心算时区。

## [1.2.0] - 2026-10-24

### Added

- 忙碌时收到的消息进入队列，当前任务 settle 后自动续跑；`/cancel` 永远不入队、立即生效。
- `/queue`（别名 `/q`）查看队列，`/queue clear`、`/queue drop <编号>` 管理队列。
- 配置 `queue.max`（0 = 关闭排队）、`queue.ack`。

## [1.1.0] - 2026-10-24

### Added

- `/tree`、`/fork`、`/resume` 的编号选择器接管：回一个最多 10 项的列表，只对发出者有效、10 分钟过期；
- `/clone` 支持。

## [1.0.0] - 2026-10-24

### Added

- 接管 pi 的斜杠命令（白名单 `commands.passthrough` / `allowReload` / `allowQuit` / `allowSession`）：
  `/reload`、`/new`、`/compact`、`/session`、`/name`、`/model`、`/thinking`、`/quit`，
  以及扩展命令、prompt 模板、`/skill:name` 的透传。
- 有任务在跑时，`/reload`、`/new`、`/compact`、`/quit`、`/tree`、`/fork`、`/clone`、`/resume` 拒绝执行。

## [0.3.0] - 2026-10-24

### Added

- `/cancel`（别名 `/stop`、`/abort`、「取消」「停止」「中止」「终止」「算了」）中断正在运行的任务：
  先终止待审批、清空队列，再 `ctx.abort()`，丢弃半截回复；8 秒看门狗兜底释放忙碌标记。

## [0.2.1] - 2026-10-24

### Changed

- 中文 README 移入 `docs/README.zh-CN.md`，修复 npm 页面默认 readme 被中文版顶掉。

## [0.2.0] - 2026-10-24

### Added

- 会话级「以后都同意」自动放行（`approve.remember`），含已在等待的那一条；
  「取消自动同意」「恢复审批」等**长得像取消**的说法仍走审批分支。
- 中英文双语 README。

## [0.1.0] - 2026-10-16

### Added

- 初始版本：把 Pi coding agent 接入 QQ 单聊（C2C），单会话 + `proper-lockfile` 单实例锁（宿主接管）、
  危险工具（`bash` / `powershell` / `write` / `edit` 及 `destructiveHint` 工具）执行前远程审批、
  长回复自动分段。
