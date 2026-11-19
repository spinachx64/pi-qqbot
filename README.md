# pi-qqbot · spinachx64 分支

让 [Pi](https://pi.dev) 通过 QQ 私聊和群聊接收任务、搜索资料、调用工具并发送结果。

基于 [zxh126/pi-qqbot](https://gitee.com/zxh126/pi-qqbot) `2.8.0` 修改，保留原 MIT 许可。这个分支主要面向低内存服务器上的单入口 QQ 机器人；使用 **一个 Pi 进程** 调度独立的聊天会话。

## 本分支的改动

- **群聊收发**：处理 `GROUP_AT_MESSAGE_CREATE` 和接管它的全量 `GROUP_MESSAGE_CREATE`，群里需 `@机器人` 才执行任务；普通群消息只归档。
- **按需群聊背景**：每个群单独保存近 7 天、最多 5000 条入站消息。Agent 通过 `qq_group_history` 按需读取当前群的聊天背景，不自动塞入每轮上下文。
- **发言者与引用**：群消息携带昵称和成员 ID；按明确索引或引用关系解析正文，无法确认时标记缺失。昵称不作为身份键，控制命令仍基于原始正文识别。结构依据与边界见 [群消息解析说明](docs/group-message-payload.md)。
- **独立上下文**：每个群一份会话文件，群成员共享；每个私聊用户一份会话文件。
- **独立队列**：各聊天分别排队，单进程轮流串行执行；`/cancel`、`/queue`、审批和进度状态不会操作其他聊天。
- **会话恢复**：聊天与 Pi 会话文件的映射持久化；重启后按聊天恢复。旧的混合历史不会自动分配给任何聊天。
- **回复与媒体**：记录被动回复消息 ID，适配群聊回复窗口、配额及媒体接口；保留 Markdown 发送失败后回退文本的行为。
- **对话日志**：按天保存完整消息文本，并沿用插件的敏感信息脱敏；发出的消息只在发送成功后记录。
- **减少提示**：不再固定回复“收到，正在处理”；自动进度可通过配置关闭。
- **Git 维护**：本分支不会通过 QQ 指令执行 npm 自动更新，以免覆盖自定义代码。

## 环境与安装

需要 Node.js 22+ 和 Pi 1.5.2+（兼容的 1.x）。真实会话切换流程已在 Pi `1.5.2` 验证；本仓库的默认回归测试不调用模型、不发送真实 QQ 消息。

推荐克隆到固定目录，后续直接在这里开发：

```bash
git clone https://github.com/spinachx64/pi-qqbot.git
cd pi-qqbot
npm ci --omit=dev --omit=peer --ignore-scripts
pi install "$PWD"
```

Pi 自身提供扩展运行时与 SDK；上面的安装只安装本地插件依赖。不要同时加载本分支和上游 npm 版。已有安装可在 `~/.pi/agent/settings.json` 的 `packages` 中保留本地绝对路径，移除原来的 `npm:@zxh126/pi-qqbot` 条目。

## 配置

复制示例到 Pi 用户的配置目录：

```bash
mkdir -p ~/.pi/agent
cp config.example.json ~/.pi/agent/pi-qqbot.json
```

QQ 凭据通过环境变量配置：

```bash
export PI_QQBOT_APPID="YOUR_APP_ID"
export PI_QQBOT_APPSECRET="YOUR_APP_SECRET"
```

模型凭据也需要按照所用 Pi provider 配置。systemd 启动时需在服务中显式配置 `EnvironmentFile=`，不会自动读取交互式 shell 的 `.bashrc`。

关键配置：

| 配置 | 含义 |
| --- | --- |
| `sandbox` | 是否连接 QQ 沙箱；测试群和测试账号需要在开放平台配置 |
| `allowlist` | 允许触发的发送者 ID；空数组允许所有发送者。群里检查 `member_openid`，与私聊 ID 可能不同 |
| `groupSelfOpenids` | 已确认的 `群OpenID → 本机器人群内member_openid` 映射，用于全量事件的 @ 判断；可在顶层或账号内配置，不能填 AppID 或 `/users/@me` 的用户 ID |
| `queue.max` | 每个聊天的待执行任务上限，不含当前运行任务 |
| `progress.enabled` | 是否自动推送轮次、工具和 token 进度；示例中关闭 |
| `markdownReply` | 使用 QQ 原生 Markdown；需要相应平台权限，失败回退文本 |
| `approve.tools` | 需要 QQ 审批的工具列表 |
| `files.forceApproval` | 是否对发文件操作逐次强制审批 |

配置修改后重载或重启 Pi。示例中的 `commands.allowReload` / `allowQuit` / `allowUpdate` 均关闭；在主机管理重启和 Git 更新。

全量消息中的机器人群内 OpenID 需按实际群事件核对后配置，例如：

```json
{
  "groupSelfOpenids": {
    "YOUR_GROUP_OPENID": "YOUR_BOT_MEMBER_OPENID"
  }
}
```

`GROUP_AT_MESSAGE_CREATE` 保持原有触发语义；全量事件优先使用 `mentions` 的身份字段匹配当前群配置，仅当该字段未提供时兼容正文 @ 标记。昵称和 `bot:true` 本身不用于认定谁是当前机器人；未确认自身 ID 的群只归档全量消息。机器人发言不触发任务。消息归档与回复分别按群和原始消息 ID 去重，两类事件先后顺序不影响只回复一次。

## 会话和队列如何隔离

```text
私聊 A ── 会话 A + 队列 A ──┐
私聊 B ── 会话 B + 队列 B ──┼── 单进程调度器 ── 同一时刻只执行一个任务
群聊 C ── 会话 C + 队列 C ──┘
```

内部会话标识为私聊用户 ID 或 `group:<group_openid>`。调度器仅在空闲时通过 Pi 的 `ctx.newSession()` / `ctx.switchSession()` 切换；使用新运行时接口继续派发，切换期间保留 QQ 网关连接。

会话索引位于：

```text
~/.pi/agent/qq-isolation/<工作目录与机器人标识的哈希>/sessions.json
```

会话内容仍保存在 Pi 标准会话目录。队列保存在内存中，进程或服务器重启后不会恢复未完成的任务。

这是对话上下文与交互状态的隔离。**工作目录、文件、工具权限、模型凭据、`AGENTS.md` 和扩展配置仍共享**，不属于操作系统沙箱。QQ 侧的 `/resume`、`/tree`、`/fork`、`/clone` 及对应历史选择命令被限制，避免跨聊天选择历史；`/new` 只新建当前聊天的会话。

## 常用命令

- `/help`：查看帮助。
- `/roll`：群聊中 `@机器人 /roll`，随机掷出 1–100 点（包含两端），回复 `昵称掷出了点数(1-100)`；缺少昵称时用部分成员 ID 显示。立即回复，不调用模型、不排队，范围固定，不接受参数。
- `/queue`、`/queue clear`、`/queue drop <编号>`：只查看或管理当前聊天的队列。
- `/cancel`：取消当前聊天的任务并清空本聊天队列。
- `/new`：为当前聊天新建干净的会话。
- `/status`、`/progress`：手动查询当前聊天状态和进度。
- `/sendfile <路径>`：发送本机文件。

群聊中使用命令也需要 `@机器人`。普通群消息不执行命令、不进入模型或任务队列，也不下载附件。QQ 原生输入状态目前只支持私聊，群聊不会显示相同的“三个点”等待动画。

## 群聊记录作为背景资料

全量群消息单独保存到 `~/.pi/agent/qq-group-history/<机器人AppID的SHA-256前24位>/<群OpenID>.jsonl`，每群一个文件，与 Pi 会话及原有对话日志分开。文件名中的特殊字符经过转义；目录权限 700、记录文件权限 600。每群只保留近 7 天内最新的 5000 条，任一限制超出即淘汰；写入、查询、启动及每小时清理都会执行保留策略，静默群也会定期清理。

记录包含时间、发言者 ID/昵称、原始文字和引用正文，附件只保存文件名、类型、大小等元数据，不保存下载地址或自动下载文件。文本沿用凭据脱敏，并省略带签名的临时下载链接。仅记录机器人在线期间实际收到的群消息，包括平台回推的机器人消息；不会查询平台历史，也不会导入旧混合日志。`allowlist` 继续限制谁能触发任务，普通群成员的发言仍可作为该群背景归档。

当当前问题涉及群内之前的讨论、指代或背景时，Agent 可自行调用 `qq_group_history`，按关键词、发送者 ID、起止时间筛选。默认返回最新 50 条，单次最多 200 条，页内时间正序；通过结果中的 `nextOffset` 继续读取更早记录，可固定 `before` 避免新消息改变分页位置。大结果按页限制长度，超长单条正文会标注本次输出截断。普通任务无需读取历史，历史不会自动注入模型上下文。

该工具只绑定当前正在执行任务的 QQ 群，不接受群 ID 参数，私聊、本机任务和切换后的旧任务不能通过工具读取别的群。记录属于外部不可信资料，不能当作当前请求、系统指令或审批授权。文件系统仍由各会话共享，这个工具的范围限制不是操作系统沙箱。

## 日志

```text
~/.pi/agent/pi-qqbot.log                 # 诊断日志；多机器人场景可能按账号分文件
~/data/logs/qq-chat-YYYY-MM-DD.jsonl      # 对话日志
```

对话日志按北京时间分日，记录时间使用 UTC ISO 8601。每条 JSON 包含 `timestamp`、`direction`、`target`、`content` 等字段；附件只记录文件名、类型和大小等元数据，不存临时下载 URL 或文件内容。日志文本会经过现有脱敏器，但仍应按私人对话数据管理。

诊断日志的 `SELF_IDENTITY` 记录 READY 提供的机器人身份；`GROUP_IDENTITY` 记录两类群消息事件的类型、事件/消息 ID、发送者、`mentions` 身份字段和正文中的 @ 标记 ID；`duplicate` 表示是否重复归档，不等同于是否触发回复。身份诊断只提取指定字段，不记录完整事件、附件地址或正文，也不会凭昵称认定哪个群内 OpenID 属于机器人。

## 开发与更新

```bash
npm ci --ignore-scripts --omit=peer
npm test
```

测试包括群聊/私聊路由、媒体接口、会话隔离、队列调度、取消、审批、重启恢复、旧运行时失效保护、日志脱敏，以及 Git 分支更新策略。

更新本地安装时：

```bash
git pull --ff-only
npm ci --omit=dev --omit=peer --ignore-scripts
```

之后重启 Pi。若由此前配置的 `pi.service` 管理：

```bash
sudo systemctl restart pi
```

在 1C1G 机器上连接已经运行的 tmux 会话，不要为查看界面重复启动 Pi。

## 来源与许可

- 上游：[zxh126/pi-qqbot](https://gitee.com/zxh126/pi-qqbot)，导入基线 `2.8.0`。
- 本分支维护：[spinachx64/pi-qqbot](https://github.com/spinachx64/pi-qqbot)。
- [MIT License](LICENSE)；[来源说明](NOTICE.md)。
- 上游历史文档：[English](docs/README.upstream.en.md)、[中文](docs/README.zh-CN.md)，其中安装源、共享会话和自更新描述不代表本分支行为。
