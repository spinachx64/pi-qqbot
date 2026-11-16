> Historical upstream documentation for @zxh126/pi-qqbot 2.8.0. Fork behavior and installation: [current README](../README.md).

# pi-qqbot

Bridge the **[Pi](https://pi.dev) coding agent** into QQ private (C2C) chats: send a message from QQ and let the agent work on the machine where pi runs — with remote approval before it executes dangerous tools.

**English** | [简体中文](https://gitee.com/zxh126/pi-qqbot/blob/main/docs/README.zh-CN.md)

> **Single-session design (v1):** every QQ user shares one pi session. Multi-user / multi-session support is planned on top of the pi SDK.

## Features

| Feature | Description |
|---|---|
| **Chat-driven agent** | QQ private messages are fed into the current pi session; the assistant's answer is sent back to QQ (long replies are split automatically). |
| **Message queue** | While a task is running, further QQ messages are **queued** instead of rejected; each one starts automatically as soon as the current run settles. `/cancel` is the exception — it acts immediately and clears the queue. |
| **Remote approval** | Before pi runs `bash` / `powershell` / `write` / `edit` — or any tool annotated `destructiveHint` — the bot asks in QQ first. With `markdownReply: true` the card carries inline buttons; text replies work either way. |
| **Remote-context notice** | The first QQ message of a session is really handed to pi (loading the extension or chatting locally in the TUI adds nothing), then the bot tells it the conversation comes from a remote QQ user and that the machine may be locked: desktop screenshots / screen OCR / UI automation / headed browsers are off by default, images must be rendered off-screen and sent with `qq_send_file`. Re-injected after context compaction. |
| **Session-scoped "always allow"** | Tap 🚀 以后都同意 on the approval card (or reply 「以后都同意」) and every approval request in the **current session** is auto-approved, including the one already waiting. |
| **Single-instance lock** | Only one pi process hosts the QQ gateway; the others stand by and take over automatically when the host exits. |
| **Cancel a running task** | Send `/cancel` (or 「取消」/「停止」) and the current run is aborted immediately — the QQ reply, the pending tool calls, the half-written answer and the pending queue are all cleaned up. |
| **Slash-command routing** | QQ messages starting with `/` are routed: pi extension commands, prompt templates and `/skill:name` are dispatched to pi; a set of pi built-ins (`/reload`, `/new`, `/compact`, `/session`, `/name`, `/model`, `/thinking`, `/quit`) is taken over; host-only commands are answered instead of being fed to the model. |
| **Progress reports** | While a run is in progress the bot posts a short progress summary (turns, tool calls, the tool currently running, tokens) every `progress.intervalMs` (default **15 s**). Ask at any time with `/progress` (aliases `/p`, 「进度」). `/progress off` pauses the automatic reports for the rest of the session, `/progress on` brings them back. If a report cannot be delivered the automatic reports stay quiet until you ask again. |
| **Secret redaction** | Anything leaving the machine is scrubbed first — progress reports, approval prompts, queue previews and the log file: `Authorization` headers (incl. QQ bot tokens), `sk-…` / `ghp_…` / `npm_…` / `AKIA…` / JWTs / PEM blocks, `token=` / `password=` / `--api-key` values, URL `user:pass@`, and long high-entropy strings. |
| **Billing / auth rescue** | When the provider answers 402 (out of credit), 401 (bad key) or a quota error, the bot does not go silent: it replies in Chinese **naming the model that failed**, quotes the provider's own message, and offers three ways out — send a new API key, send `endpoint + key` to register another service, or `/model` to switch. Plain keys never reach the log. |
| **Register an endpoint from QQ** | Send `https://api.example.com/v1 <key>` and the bot probes `/models` (falling back to `/v1/models`), filters non-chat ids, writes the provider into `models.json` and registers it in the running process, then sends a **numbered list with context sizes** so you can pick with a single number. Model metadata (`contextWindow`, `maxTokens`, `input`, `thinkingLevelMap`, `compat`) is borrowed from pi's built-in catalog when the same model id is already known there. |
| **Self-update from QQ** | Send `/update` (or 「更新自己」) and the bot checks npm, runs **`pi update npm:@zxh126/pi-qqbot`**, verifies the on-disk version really changed, then reloads itself through `/qq reload` — no host restart. Off by default (`commands.allowUpdate`). |
| **Multi-bot on one machine** | Put several QQ bots in one config (`qqbots: [...]`, see [docs/accounts.md](./docs/accounts.md)). Each pi process, in config order, claims the first bot that is not online yet and then verifies its credentials (a wrong secret releases the lock instead of squatting the slot); a process that finds every bot taken stays idle and rescans every 5 s, taking over as soon as one goes offline. A bot whose owner is merely reloading is never snatched (a 20 s reservation is left behind). The bot name is logged, shown in `/status` and prepended to the first QQ reply; taking over from another process also tells you the new working directory. |
| **Images & files** | Anything you attach in QQ is downloaded to a temp file and handed to pi as a marked line — `图片路径 <path>` for images, `语音路径` / `视频路径` / `文档路径` / `压缩包路径` / `文件路径` for the rest — and QQ gets a receipt with the counts and paths. pi's `read` tool can open the image, `bash` can process the file. |
| **Send files to your QQ** | Ask the agent to send a file from the machine (`把 D:\docs\report.pdf 发给我`) or run `/sendfile <path>`; the bot uploads it in 5 MB chunks (QQ rich media) and sends it as an image / video / voice / file card. Images (png/jpg), videos (mp4) and voice (silk) render natively; everything else arrives as a downloadable file card. Approval behavior follows `files.forceApproval` (off by default — see below). |
| **Built-in commands** | `/status`, `/queue`, `/progress` (+ `/progress off` / `on`), `/reset`, `/cancel`, `/sendfile`, `/update`, `/help`. |
| **`!` / `!!` are answered, not executed** | pi's shell shortcuts only exist inside its TUI / RPC front end, and the extension API exposes no equivalent — so the bot replies with an explanation instead of forwarding `!ls` to the model. Ask in plain language and the agent runs it through the `bash` tool, with a QQ approval first. |

## Install

```bash
# from npm
pi install npm:@zxh126/pi-qqbot

# or from a local checkout (dependencies are needed here)
npm install
pi install ./pi-qqbot
```

Then create `~/.pi/agent/pi-qqbot.json`:

```json
{
  "appId": "YOUR_APP_ID",
  "appSecret": "YOUR_APP_SECRET",
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

| Field | Default | Description |
|---|---|---|
| `appId` / `appSecret` | required | Credentials of your QQ Open Platform bot |
| `sandbox` | `false` | Set `true` while the bot is not yet published (sandbox environment) |
| `allowlist` | `[]` | openid allowlist; empty means no restriction |
| `markdownReply` | `false` | Reply with QQ markdown messages (msg_type=2) so GFM tables render; approval and selection lists then carry inline buttons (custom keyboards need platform enablement). Needs the bot's markdown permission; falls back to plain text on send failure |
| `streaming` | `false` | Reserved, streaming is not enabled in v1 |
| `approve.tools` | `["bash","powershell","write","edit"]` | Tools that require approval; tools annotated `destructiveHint` are always gated too |
| `approve.remember` | `true` | Remember the decision per tool inside the session (no more prompts for that tool) |
| `commands` | see below | Slash-command routing gates: `passthrough`, `allowReload`, `allowQuit`, `allowUpdate`, `allowSession` |
| `progress.enabled` | `true` | Post periodic progress reports while a task is running (read at session start — restart or `/new` after changing; at runtime use `/progress off`) |
| `progress.intervalMs` | `15000` | Interval of those reports (env override: `PI_QQBOT_PROGRESS_MS`) |
| `queue.max` | `20` | How many messages may wait while a task runs; `0` disables queueing (busy messages are refused as before) |
| `queue.ack` | `true` | Reply to QQ when a queued [message](#queueing-while-busy) starts (the "queued" ack is always sent) |
| `attachments.enabled` | `true` | Download attachments to temp files and pass their paths to pi; `false` = answer with an "ignored" notice and process the text only |
| `attachments.dir` | `""` | Where to save them; empty = `<system temp>/pi-qqbot/<bot>` (Windows: `%LOCALAPPDATA%\Temp\pi-qqbot\…`) |
| `attachments.maxBytes` | `26214400` | Per-attachment size limit (25 MB); larger ones are reported as failed, not downloaded |
| `attachments.maxPerMessage` | `10` | How many attachments of one message are processed |
| `attachments.retentionHours` | `24` | Files older than this are swept at session start |
| `attachments.maxFiles` | `200` | Keep at most this many files in the directory (oldest are deleted) |
| `files.enabled` | `true` | Allow sending local files to QQ (both the tool and `/sendfile`); `false` refuses |
| `files.maxBytes` | `31457280` | Per-file limit for sending (30 MB; QQ hard limit is 200 MB) |
| `files.forceApproval` | `false` | Hard-gate agent-initiated file sends: `true` = every `qq_send_file` is confirmed on its own, ignoring 「以后都同意」 and remembered decisions; `false` = normal approval rules (only gated when listed in `approve.tools`, then auto-allow / remember apply) |
| `remote.notice` | `true` | Inject a one-time "this is a remote QQ user" note before the first message handed to pi in a session (QQ-side invisible; re-injected after compaction) |
| `remote.guidelines` | `true` | Also append three short rules to the system prompt of every run started from QQ (remote user, locked screen → off-screen rendering, ask instead of waiting) |
| `remote.extra` | `""` | Extra text appended to the end of the built-in notice |

Credentials can also come from the `PI_QQBOT_APPID` / `PI_QQBOT_APPSECRET` environment variables (single-bot setup only).
The pre-2.8 names `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` still work as deprecated aliases (the `PI_`-prefixed ones win when both are set);
pi-qqbot's own variable namespace is `PI_QQBOT_*` so it can never pick up a variable meant for another QQ bot bridge.

### Several bots (2.0)

```jsonc
{
  "qqbots": [
    { "name": "work", "appId": "1903340143", "appSecret": "…", "sandbox": true },
    { "name": "home", "appId": "1020123456", "appSecret": "…" }
  ],
  "queue": { "max": 20, "ack": true }   // still the global defaults, per-bot overrides allowed
}
```

Every pi process claims the first bot (in config order) that is not online; spare processes stand by and rescan
every 5 s. After claiming, the credentials are verified by fetching an `access_token`: a bot with a wrong
`appId`/`appSecret` releases its lock and is skipped instead of squatting the slot. `PI_QQBOT_ACCOUNT=<name|appId>`
pins one bot instead of auto-claiming. Full details: [docs/accounts.md](./docs/accounts.md).

## Usage

Start pi, then message the bot in QQ; pi handles it and replies.

| Command | Description |
|---|---|
| `/reset` | Clear the reply buffer, approval memory and session-wide auto-approve (**does not** switch sessions — send `/new` for that) |
| `/status` | Show the bot this process serves (name + working directory), busy/idle state, origin of the last turn (QQ / local TUI), queue length, auto-approve state, pending approval count and the progress-report mode |
| `/queue` | Show the queue (aliases: `/q`); `/queue clear` empties it, `/queue drop <id>` removes one entry |
| `/progress` | **Show the current progress summary immediately** (aliases: `/p`, 「进度」, 「当前进度」, 「进展」; plain-text questions like 「到哪了」「怎么样了」 work while busy). While you paused reports yourself it only replies once — use `/progress on` to resume; while reports are merely quota-quiet, asking resumes them |
| `/progress off` | **Pause automatic progress reports for the rest of the session** (aliases: `pause`, `stop`, `暂停`, 「暂停汇报」, 「关闭汇报」). Manual `/progress` still works, it just no longer resumes the timer |
| `/progress on` | **Resume automatic progress reports** (aliases: `resume`, `start`, `恢复`, 「恢复汇报」, 「继续汇报」) |
| `/cancel` | **Interrupt the task that is running right now** and empty the queue (aliases: `/stop`, `/abort`, 「取消」, 「停止」, 「中止」, 「终止」, 「算了」, 「停」, 「停下」, 「停一下」, 「别跑了」). Note: a bare 「停」 interrupts the *task*; to silence progress reports say 「别汇报了」/「闭嘴」 or `/progress off` |
| `/sendfile <path>` | **Send a file from this machine to your QQ** (e.g. `/sendfile D:\docs\a.pdf`); QQ gets an image / video / voice / file card. Requires QQ-side approval when the agent initiates it |
| `/help` | Show help |

### Images and files from QQ

Send a picture (or a document, an archive, a voice/video message) and the bot downloads it to a temp file,
then hands pi a line with the path:

```
图片路径 C:\Users\you\AppData\Local\Temp\pi-qqbot\bot-340143\2026-02-11\msg-abc-1-103045.jpg
```

| Attachment | Line sent to pi |
|---|---|
| image | `图片路径 <path>` |
| voice / audio | `语音路径 <path>` |
| video | `视频路径 <path>` |
| document (pdf, office, text, code… ) | `文档路径 <path>` |
| archive (zip, rar, 7z, tar…) | `压缩包路径 <path>` |
| anything else | `文件路径 <path>` |

Your own text is kept as the first line, so `看下这个` + an image becomes
`看下这个\n图片路径 C:\…\a.jpg` — one pi turn, paths included. QQ also gets a receipt such as
`已收到 2 个附件（图片 ×1、文档 ×1），已存为临时文件并交给 pi：` followed by the paths; failed downloads are
listed with the reason and the text is still delivered.

Notes:

- QQ's download URLs carry a short-lived `rkey`, so files are fetched the moment the message arrives.
- A message that has attachments **bypasses** slash commands, approval parsing and the numbered picker — it is
  always treated as ordinary content for pi (an attached `/status` is not executed).
- Files are deleted by the `attachments.retentionHours` / `attachments.maxFiles` sweep at session start, so a
  path handed to pi stays readable for the rest of the session (and usually a day).
- On file names: only `[0-9a-zA-Z._-]` are kept, prefixed with the QQ message id.

### Sending files to QQ

Two ways to push a file from the machine to your chat:

| Trigger | How |
|---|---|
| Natural language | `把 D:\docs\报告.pdf 发给我` — the agent calls the `qq_send_file` tool with the path |
| Slash command | `/sendfile D:\docs\报告.pdf` (also `/sendfile "D:\my files\a.zip"`; no agent run needed) |

**Approval depends on `files.forceApproval`** (default `false`, read per send):

- `true` — hard gate: `qq_send_file` is approved no matter what `approve.tools` says, and it ignores both
  the session-wide 「以后都同意」 and remembered decisions — each upload is confirmed on its own
  (sending a file is data leaving the machine). The prompt says so explicitly:
  `[审批 #1] 发送文件到 QQ: D:\docs\a.pdf` + 「需单独确认」.
- `false` (default) — normal approval rules: agent-initiated sends are only gated when `qq_send_file` is
  listed in `approve.tools` (or annotated `destructiveHint`); auto-allow and remembered decisions then apply
  as with any other tool. With the stock config, file sends go out without asking.
- `/sendfile` typed directly in QQ is never gated — you typed the path yourself.

How it is delivered (QQ rich media, chunked upload):

| File | Delivered as |
|---|---|
| `.png` / `.jpg` / `.jpeg` | inline image |
| `.mp4` | inline video |
| `.silk` | voice bubble |
| anything else (pdf, zip, mp3, epub, exe…) | downloadable file card |

Notes:

- The file is uploaded in chunks (`upload_prepare` → `PUT` → `upload_part_finish` → merge) — the only path that works
  for local files, since URL upload needs a public URL and the one-shot binary upload caps at 5 MB.
- Passive reply is used (`srv_send_msg: false` + `msg_type: 7` with `msg_id`/`msg_seq`), so it does not burn the active-message quota.
- Limits on QQ's side: 200 MB hard cap and a **daily total file quota** (`40093002`); the bot turns both into readable replies.
- The reply also tells you what was sent: `已发送「报告.pdf」（2.31 MB，文件卡片）`.

### Remote-context notice

pi runs on the machine, you are in QQ — and that machine may be locked. So the first time a QQ message of a session is
actually handed to pi, the bot adds a short note to the **system prompt** (a `qq-remote-context` section, so it sits
before the user message and QQ never sees it) that says:

- the user is remote: no screen, no dialogs, keep replies concise;
- desktop screenshots, screen OCR, UI automation, keyboard/mouse simulation and headed browsers are off by default
  (`mcp__screenshot`, `mcp__winui` are named explicitly) — on a locked machine they only capture the lock screen or fail;
- when an image is needed, render it off-screen (headless browser over HTML, SVG, matplotlib/Pillow, …) and send the PNG
  with `qq_send_file` instead of trying to capture the desktop;
- capturing the desktop once is allowed only to check whether the machine is locked; everything else stays off-screen.

Timing matters: the note is only added from `before_agent_start` for a run this extension dispatched, so merely loading
the extension — or chatting with pi directly in the TUI on the host — sends nothing. It appears once per session (again
after context compaction; `remote.extra` appends your own lines). With `remote.guidelines` the same expectations are
condensed into three bullets that ride along in the system prompt of every run that came from QQ, so they survive
summarisation. Set `remote.notice: false` / `remote.guidelines: false` to turn either part off.

If you take over the same session from the host — turn N from QQ, turn N+1 typed in the TUI — the next local run gets a
one-time `qq-local-handoff` section instead: the remote/locked-screen premise is void (screenshots are fine, no
`qq_send_file` needed). Detection uses the `input` event (`source: "interactive"`; the bot's own `sendUserMessage` is
`"extension"`, so it never misfires), it only fires once per hand-off, and it is skipped while a QQ run is still
streaming (no new run starts then). `/status` shows `来源: QQ（远程）` or `来源: 本机（TUI）`.

### Slash commands from QQ

Any message that starts with `/` is routed before it can become a chat prompt:

| # | Kind | Behaviour |
|---|---|---|
| 0 | extension commands whose output only goes to `ctx.ui.*` (`/usage`, `/cost`, `/mcp`, `/llama`) | `/usage` and `/cost` are **bridged** (see below) so the report comes back to QQ; `/mcp` and `/llama` need host-TUI dialogs and are answered with an explanation instead of being silently swallowed |
| 1 | pi **extension commands**, prompt templates, `/skill:name` | dispatched to pi with `expandPromptTemplates: true`, so things like `/usage`, `/cost` or your own commands work from QQ |
| 2 | pi built-ins this bridge can take over | re-implemented through the extension API (table below) |
| 3 | pi built-ins that only exist in the TUI | answered with "run it on the host", never sent to the model |
| 4 | everything else (`/tmp 里有什么`, `/etc 看看` …) | ordinary chat |

| QQ command | What happens | Gate |
|---|---|---|
| `/reload` | reloads extensions / skills / templates / themes — **the bot restarts too** and reconnects the gateway | `commands.allowReload` (default **false**) |
| `/new` | real new pi session (`ctx.newSession()`) | `commands.allowSession` |
| `/compact [instructions]` | compacts the context | `commands.allowSession` |
| `/session` | session id / cwd / model / thinking level / context usage | `commands.allowSession` |
| `/name [name]` | get or set the session name | `commands.allowSession` |
| `/model [provider/model]` | list available models or switch | `commands.allowSession` |
| `/thinking [level]` | get or set the thinking level | `commands.allowSession` |
| `/tree` | list branch points (numbered), answer with a number or tap the button to jump there | `commands.allowSession` |
| `/fork` | list earlier user messages (numbered), answer with a number or tap the button to fork from it | `commands.allowSession` |
| `/clone` | duplicate the current session at its current leaf | `commands.allowSession` |
| `/resume` | list the project's other sessions (numbered), answer with a number or tap the button to switch | `commands.allowSession` |
| `/quit` | shuts the host pi down | `commands.allowQuit` (default **false**) |
| `/update` | updates pi-qqbot from npm (`pi update`) and reloads itself — see [Self-update](#self-update-from-qq) | `commands.allowUpdate` (default **false**) |

Host-only (answered, never forwarded to the model): `/settings`, `/hotkeys`, `/changelog`,
`/trust`, `/login`, `/logout`, `/scoped-models`, `/llama`, `/import`, `/export`, `/share`, `/bug`,
`/copy`, `/privacy`.

Messages that start with `!` or `!!` (full-width `！` / `！！` included) are **not** shell commands here.
Those prefixes are expanded only by pi's TUI / RPC front end (`!` runs the command and lets the model see
the output, `!!` keeps it out of the context), and the extension API has no equivalent — `pi.sendUserMessage()`
does not dispatch them, and `pi.exec()` bypasses approval and session history. So `!ls` gets a receipt saying it
was **not executed**; it is never forwarded to the model as prose either. To run something, just ask in words
— the agent then calls the `bash` tool and asks in QQ before it runs. A lone `!`, `!!!`, or an exclamation
mark at the end of a sentence is still ordinary chat.

### TUI-only commands come back to QQ

Some extension commands never print into the conversation — they call `ctx.ui.notify()` (and
`pi.appendEntry()`), which only renders on the host TUI/RPC front end. In QQ that showed up as
"dispatched, then silence". The bridge closes that hole:

| Command | What happens |
|---|---|
| `/usage [range]`, `/cost [range]` | re-dispatched as `/qq usage <range>`: the bridge runs the original `/usage` command, then **polls** for the fresh `customType: "usage-report"` entry for up to 2 s (the append lands ~100 ms *after* `sendUserMessage()` resolves, so a single read always misses it), falling back to the tail of the session file, and renders it as text (requests, tokens, cache ratio, cost, per-model). **Usage unchanged** — keep sending `/usage today`. |
| `/usage rate <value>`, `/usage rate auto` | really executed (they write `~/.pi/agent/pi-usage-report.json` / refresh the cached rate); the bridge then reads those files back and reports the resulting rate, so an invalid value shows up as "unchanged" |
| `/mcp`, `/llama` | answered: they need host-TUI selection dialogs / browser login, so nothing is dispatched |

A bare `/usage rate` and `/usage help` are answered locally, without running the command. Coupling with
[`pi-usage-report`](https://gitee.com/zxh126/pi-usage-report) is limited to the `usage-report` entry type
plus the two files it keeps in `~/.pi/agent/`.

Guards:

- `/reload`, `/new`, `/compact`, `/quit`, `/tree`, `/fork`, `/clone` and `/resume` refuse to run while a task
  is in progress — send `/cancel` first.
- Prompt templates and `/skill:name` start an agent run, so while a task is in progress they are
  **queued** like ordinary messages (see [Queueing while busy](#queueing-while-busy)). Extension commands
  that manage their own LLM interaction still run immediately.
- Selection commands (`/tree`, `/fork`, `/resume`) answer with a numbered list of at most 10 entries (with tap-to-select buttons when `markdownReply` is on), scoped to
  the user who asked and valid for 10 minutes. The next bare number from that user executes the choice; anything
  else (or 「取消」) abandons it. A number without a pending list is ordinary chat.
- `/reload` is off by default: it restarts the bot, and if the new code fails to load the bot stays
  down until someone fixes it on the host. Turn it on with `commands.allowReload: true`.
- Sending the bridge command yourself (`/qq reload`, `/qq quit`, `/qq new`, `/qq list fork`, …) hits the
  **same** gates: the sub-command is mapped back to its built-in name first, so `commands.allowReload` /
  `allowQuit` / `allowUpdate` / `allowSession` and the busy check all apply. Routing it as a plain
  extension command would have bypassed every gate — with `allowQuit: false`, `/qq quit` could shut the
  host pi down. Destructive sub-commands (`reload`, `new`, `quit`, `clone`) answer *before* they are
  dispatched, because they replace the runtime they would answer through.
- Dispatch receipts echo the **whole** command (`已派发 /deploy prod 给 pi。`) instead of only the first
  word, truncated at 80 characters with `…`. Previously `/qq reload` was answered with
  `已派发 /qq 给 pi。`, which looked like the argument had been dropped.
- Why the indirection: pi only dispatches **extension** commands from a message
  (`prompt()` → `_tryExecuteExtensionCommand`), and `reload()` / `newSession()` are command-context
  APIs. So this extension registers `/qq` and forwards `/reload` → `/qq reload`. Built-in names are
  hard-coded here because pi does not export its built-in list; any unknown `/word` falls back to
  plain text.
- The bridged command never touches the command ctx after a session replacement: `reload` / `update` / `new` /
  `clone` / `quit` (and the `tree` / `fork` / `resume` picks) invalidate it, and pi then throws
  `This extension ctx is stale after session replacement or reload` on **any** property access. The model
  cache sync is skipped in those cases instead (`REPLACES_RUNTIME` + a guarded read).

### Queueing while busy

pi's session runs one agent run at a time, so the bot serializes QQ input itself:

```text
you: 帮我把测试跑一遍
bot: 收到，正在处理
you: 顺便看看 README 有没有错别字
bot: 已排队 #1，当前任务结束后自动执行。发 /queue 查看队列，/cancel 可中止当前任务并清空队列。
you: /queue
bot: 当前任务：处理中（发 /cancel 可中断）
     队列：1 条（上限 20）
       1. #1 · 12s 前 · 顺便看看 README 有没有错别字
     发 /queue clear 清空，/queue drop <编号> 删除一条。
bot: （第一轮结束后）开始执行队列 #1
```

Semantics:

- Every message that would start a run — plain chat, prompt templates, `/skill:name` — is queued while a
  task is running, in arrival order (FIFO). Replies go to the QQ user who sent that message.
- The next entry starts when pi has **settled** (`agent_settled`, no automatic continuation left), so a
  retry, a compaction retry or a follow-up turn is never cut in half.
- The queue holds at most `queue.max` entries; beyond that the message is refused with a notice. `queue.max: 0`
  restores the old "上一条消息还在处理中" behaviour.
- If handing a message to pi fails (pi was still finishing the previous run), it is put back at the head of
  the queue and retried — messages are not lost. A run that already started is never retried, so a failure
  inside a run cannot execute the same message twice.
- Control commands are **not** queued: approvals, `/status`, `/queue`, `/reset`, `/help`, the pi built-ins
  and `/cancel` all act immediately.
- `/cancel` empties the queue as well, because "cancel" means "stop doing all of this". Use `/queue drop <id>`
  to remove a single entry instead.

### Progress reports

While a run is in progress, a summary is pushed to QQ every `progress.intervalMs` (15 s by default):

```
[进度 02:15] · 第 3 轮 · 工具 6 次（bash 4 / read 2）· 失败 1
最近: bash "npm test" · 6.2s
正在: 分析测试输出… · 12.3k tok
```

- Built purely from local event data (`tool_execution_*`, `turn_end`, `message_end`, `message_update`)
  — **no model call, no tokens spent**.
- Tool arguments are redacted and truncated, so a command carrying a token never reaches QQ in clear.
- **Quota-aware**: one QQ message buys only 4 passive replies, so a long run will eventually run out.
  The first failed send stops automatic reports for that run (no retry spam); send `/progress`
  (or 「进度」) and they resume.
- **Manual pause / resume**: `/progress off` (or 「暂停汇报」) silences the reports for the rest of the
  session — it survives `agent_settled` and the next run, and asking for `/progress` no longer turns it
  back on. `/progress on` (or 「恢复汇报」) resumes. A new session (`/new`, restart) starts enabled again.
  `/status` shows which of the five modes you are in (on / paused-by-you / quota-quiet / held-during-approval / disabled).
- **Approvals stay visible**: while a tool approval is waiting for your reply, automatic reports are held back — otherwise
  a 15 s progress line would keep pushing the prompt off your screen. They resume on the next interval after you answer
  (or the approval times out). Asking for `/progress` yourself still works.
- **The final answer is protected**: if it cannot be delivered (quota), it is cached and re-sent with a
  `（上一条回复发送失败，补发如下）` prefix as soon as you send the next message.
- Timer is cleared on `agent_settled` / `/cancel` / session shutdown.
- Set `progress.enabled: false` to turn the whole thing off (across sessions; read at session start).

#### Colloquial shortcuts (Chinese, matched only as a whole message)

| Intent | Say any of |
|---|---|
| Pause automatic reports | 「暂停汇报进度」「暂停进度汇报」「别汇报了」「别说了」「闭嘴」「安静」「打住」「停止汇报」, or `/progress off` |
| Resume them | 「恢复汇报」「恢复汇报进度」「接着说」「说下去」, or `/progress on` |
| Ask once | 「汇报一下当前进度」「看一下进度」「说说进度」「进度如何」「进度怎么样」, or `/progress` |
| Interrupt the task | 「停」「停下」「停一下」「停停」「停止」「取消」「别跑了」, or `/cancel` |

A bare 「停」 interrupts the **task**; only phrases carrying a report noun (「停止汇报」) or an explicit
silence word (「别说了」「闭嘴」) pause the reports. Sentences like 「帮我加个进度条」 are still forwarded to pi.

### Cancelling a run

Long tasks started from QQ (installs, builds, a runaway agent loop) can be interrupted without going
back to the machine:

```
you: /cancel
bot: 已取消当前任务，并终止了 1 个待审批请求，队列中的 2 条已清空。可以发送新消息继续。
```

What it does, in order: terminate every pending approval request, empty the queue, call `ctx.abort()` on
the current run (the same path as pressing Escape in the TUI), drop the partially streamed answer so it is
not sent to QQ, keep the busy flag until pi reports `agent_settled` (so messages arriving during the abort
are queued instead of racing it), and reply with a confirmation. If `agent_settled` never arrives, an
8-second watchdog releases the busy flag and continues the queue. Replies that only *look* like cancelling
— 「取消自动同意」, 「恢复审批」 — still go to the approval handler, so the auto-approve switch keeps working
as before.

Anything else is forwarded to pi as a user message.

### When the model runs out of credit

A provider error used to look like silence in QQ: pi records `stopReason: "error"` plus the provider's
message on the assistant message and produces no text at all, so there was nothing to forward. Now the
failure is classified (`billing` / `auth` / `permission` / `rate` / `other`) and reported:

```
❌ 当前模型的余额/额度不足，暂时无法继续对话
当前模型：deepseek/deepseek-flash
服务端原文：402: {"message":"Insufficient Balance (request_id: …)", …}

恢复方式（直接回消息即可，key 我不会写进日志）—
1. 有新 key：只发 key（任意前缀都行，比如 sk-… / ark-… / AIza…，带引号也认）→ 我更新当前模型所属服务的 key
2. 换服务商：发「https://api.xxx.com/v1 <你的 key>」→ 我拉它的模型列表，再把编号发给你挑
3. 先换现成模型：发 /model 看列表，或 /model provider/id 直接切
```

The reply names the model that actually failed, and the recovery path needs no working model — that is the
whole point, since the agent itself is unusable at that moment.

**Send a new key** — after a 402/401, a message that is just a key (`sk-…`, `ark-…`, `AIza…`, a plain hex
key, even a dummy `ollama` when it comes with an endpoint) is taken as a credential, not as chat:

| You send | What the bot does |
|---|---|
| `sk-…` / `ark-…` / `AIza…` / any single token (also `"quoted"`) | writes it into `~/.pi/agent/auth.json` for the provider that just failed, then **verifies it with `GET <baseUrl>/models`** and replies with a masked fragment and the probe result |
| `key <secret>` | same, and it also works when the model is *not* failing (explicit prefix) |
| `https://api.example.com/v1 <key>` | probes `/models` (falls back to `/v1`), writes the provider into `models.json`, registers it in the running process, then sends a numbered model list |
| `endpoint <url> <key> models m1,m2` | same, for services without a `/models` endpoint |

Details that matter:

- A bare token is only treated as a key **while a 402/401 is still the last thing that happened** — otherwise a random
  pasted string would be swallowed instead of reaching the model. The explicit `key …` form is always accepted.
- Keys are never written to the log or echoed back; replies show `sk-ab…cd`, and `redactSecrets()` runs over everything
  that leaves the machine.
- `auth.json` is written with pi's own lockfile and an atomic rename, so pi picks the new key up on the next request
  (verified: an invalid key on disk + a write during `before_agent_start` → the same process succeeds without a restart).
- `models.json` is written in pi's documented format, so the provider survives restarts; `pi.registerProvider()` makes it
  usable immediately in the running process.
- Model metadata for a newly registered endpoint is borrowed from pi's built-in catalog when the same model id exists
  there (e.g. `glm-5.3` → `contextWindow: 1e6`, `maxTokens: 131072`, `compat.thinkingFormat: "zai"`). Unknown ids fall
  back to conservative defaults (`128k` / `16k`) and the reply says so.
- Non-chat ids (`embedding`, `rerank`, `tts`, `cogview`, …) are filtered out; at most 40 models are registered and the
  first 10 are offered as numbers.

### Self-update from QQ

```
you: /update          (or 「更新自己」)
bot: 正在检查 pi-qqbot 更新…
bot: 发现新版本 v2.3.0 → v2.4.0，开始更新（pi update，最多等 5 分钟）…
bot: ✅ 已更新到 v2.4.0，正在重载扩展（会话保留，模型上下文不受影响）…
```

This is pi's own update path, not a re-implementation: `npm view @zxh126/pi-qqbot version` to learn the latest,
`pi update npm:@zxh126/pi-qqbot` (the same command the release checklist uses) to install it, then `/qq reload`
(`ctx.reload()`). Guard rails:

- `commands.allowUpdate` defaults to **false** — enable it in `pi-qqbot.json` if you want QQ to be able to update itself.
- Refuses while a task is running (`needsIdle`), like `/reload` and `/new`.
- **Version verification gate**: after `pi update`, the on-disk `package.json` version must equal the registry version.
  If it does not (npm version already bumped locally, `pi update` deciding "already latest", …) the bot reports it and
  **does not reload**.
- A failing `npm view` or `pi update` leaves the bot untouched; the error is echoed to QQ.
- The installation directory is shared: other pi processes still running the old code keep running it until they reload.
- Natural-language triggers are narrow on purpose — 「更新自己」「升级一下插件」「自更新」 yes, a bare 「更新」 no.

## Remote approval

```text
[审批 #1] bash: rm -rf node_modules
回复「同意 1」批准，「拒绝 1」拒绝，「停止」终止本轮。
要本会话内全部放行，回复「以后都同意」（可用「取消自动同意」关闭）。
```

With `markdownReply: true` the card carries ✅ 允许一次 / ❌ 拒绝 / 🚀 以后都同意 buttons — tapping one
is the same as replying. Strict tools (`qq_send_file`) show only the first two buttons. Text replies keep
working either way.

Reply vocabulary (approval keywords are Chinese, with English aliases; the card buttons are the faster path when they are shown):

| Intent | Reply |
|---|---|
| Approve one request | `同意 1` / `allow 1` — a bare `同意` / `allow` applies to the oldest pending request |
| Reject one request | `拒绝 1` / `deny 1` — a bare `拒绝` / `deny` applies to the oldest pending request |
| Abort the pending requests *and* the running task | `停止` / `/cancel` |
| Allow everything in this session | `以后都同意`, `一直同意`, `全部放行`, `别再问了`, `always allow` |
| Back to per-request approval | `取消自动同意`, `恢复审批`, `以后都不同意` |

Semantics:

- **Session scope only.** The auto-approve switch lives in memory and lasts until `/new`, a new pi session, or one of the "back to per-request approval" replies. Nothing is persisted, nothing survives a restart.
- The switch is an **explicit user instruction**, so it is **not** affected by `approve.remember`.
- `approve.remember: true` additionally remembers the decision **per tool** for the session: after approving `bash` once, later `bash` calls are not asked again (`/new` clears it).
- Requests time out after **10 minutes** and are rejected with a notification. A timeout is **not** remembered as a rejection — the tool is asked again next time.
- Approval text that arrives while no request is pending is forwarded to pi as a normal message.

## Single-instance lock

The QQ gateway keeps only one active connection per bot. The extension uses a `proper-lockfile` lock at `~/.pi/agent/pi-qqbot-<appId>.lock`:

- the process that acquires the lock becomes the host and connects to QQ;
- other processes stand by, retry every 5 seconds, and claim **any** bot of the list that is free;
- when the host exits or crashes (30 second heartbeat timeout), a standby process takes over;
- a host that is only rebuilding its session (`/reload`, `/new`, `/fork`, `/resume`) writes a 20 second reservation next to the lock, so nobody else grabs its bot in the gap;
- the last owner (pid + working directory) is kept in `~/.pi/agent/pi-qqbot-<appId>.owner.json` and is used to tell you that a **new process** took over, and from which directory.

## Prerequisites

1. Create a bot on the [QQ Open Platform](https://q.qq.com/) and copy its **AppID** / **AppSecret**.
2. Before the bot is published, configure a **sandbox C2C account** and set `sandbox` to `true`.
3. In production, add the server's public egress IP to the bot's allowlist.

## Logs

Debug logs are written to `~/.pi/agent/pi-qqbot-<name>.log` (one file per bot, so several pi processes on the same machine never interleave). A single-bot v1 config keeps writing `pi-qqbot.log`. Each line starts with a **local** timestamp that carries the UTC offset, e.g. `[2026-10-24T07:39:09.762+08:00]`, so it lines up with file mtimes and process start times without mental arithmetic.

## Changelog

See [CHANGELOG.en.md](./CHANGELOG.en.md) — every release with what changed and why. (中文：[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)) The progress-report
pause/resume (`/progress off` / `on`) landed in **1.5.0**; multi-bot auto-claiming in **2.0.0**;
receiving QQ images/files (saved to temp files and handed to pi as `图片路径 <path>`) in **2.1.0**;
sending local files to QQ (`qq_send_file` / `/sendfile`, chunked rich-media upload) in **2.2.0**.

## License

MIT
