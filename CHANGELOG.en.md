# Changelog

All notable changes to pi-qqbot are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

> Chinese changelog: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

## [2.8.0] - 2026-11-07

### Changed

- **Credential env vars now use the plugin's own `PI_QQBOT_` prefix**: `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` →
  `PI_QQBOT_APPID` / `PI_QQBOT_APPSECRET` (the other own variables, `PI_QQBOT_ACCOUNT` and
  `PI_QQBOT_PROGRESS_MS`, already used that prefix). No variable name is shared with another QQ bridge any
  more, so setting one environment value can no longer feed two tools at once. `QQ_BOT_*` stays as a
  **deprecated alias** (only consulted when the matching `PI_QQBOT_*` is unset) and will be removed in a
  later major version.

### Compatibility

- Upgrading needs no change: scripts that only set `QQ_BOT_APPID/SECRET` keep working. When both forms are
  set the `PI_QQBOT_*` one wins, so delete the old names to prove the new ones really apply.

### Tests

- `test/config.test.mjs`: `clearEnv()` now clears all four names; new case "legacy alias works and
  `PI_QQBOT_*` wins"; the existing "v1 via env only" case reads the new names. 12/12 pass.

## [2.7.0] - 2026-11-07

### Changed

- **Outbound-file approval is now configurable**: new `files.forceApproval` (default `false`, per-account
  overridable). `true` keeps the old hard gate — every agent-initiated `qq_send_file` is confirmed on its own,
  ignoring the session-wide 「以后都同意」 and remembered decisions, with the strict 「需单独确认」 prompt.
  `false` (the new default) routes file sends through the normal approval rules: gated only when `qq_send_file`
  is listed in `approve.tools` (or annotated `destructiveHint`), and then auto-allow / remember apply as with
  any other tool. `/sendfile` typed directly in QQ is still never gated.
- `/help` and the `qq_send_file` tool description no longer claim approval is unconditional.

### Compatibility

- **Behavior change on upgrade**: with the stock config, agent-initiated file sends no longer ask in QQ.
  To keep approval with less friction, add `"qq_send_file"` to `approve.tools`; to keep the strict
  every-time gate, set `files.forceApproval: true`.

### Tests

- `test/queue.test.mjs`: the forced-approval case now runs with `files.forceApproval: true`; a new case covers
  the default (no `files` key at all → silent pass; listed in `approve.tools` → asked once, decision remembered,
  later sends pass without asking).
- `test/config.test.mjs`: new case for the `files.forceApproval` default / global / per-account override.

## [2.6.2] - 2026-11-01

### Fixed

- **`/qq …` bypassed the command gates**: `/qq` is itself an extension command, so sending `/qq reload`,
  `/qq quit` or `/qq new` landed in the passthrough branch of `routeSlash`, which checks neither
  `commands.allowReload` / `allowQuit` / `allowUpdate` / `allowSession` nor the busy state (`needsIdle`).
  With the defaults (`allowQuit: false`) `/qq quit` from QQ could shut the host pi down. `/qq` is now routed
  *before* passthrough: `bridgeGate()` maps the sub-command back to its built-in name (multi-word sub-commands
  `list tree` / `list fork` / `list resume` are matched as a whole first) and reuses the same
  `allowed()` / `needsIdle` checks.
- **Dispatch receipts swallowed the argument**: `/qq reload` used to be answered with
  `已派发 /qq 给 pi。` — `parseSlash` only takes the first word as the command name, so it looked like `reload`
  had been ignored. Receipts and logs now echo the whole command (truncated at 80 characters with `…`).

### Changed

- Destructive bridge sub-commands (`reload` / `new` / `quit` / `clone`) now answer **before** they are
  dispatched, so the receipt cannot lose the race against `ctx.reload()` / `newSession()`.
- `/qq sendfile …`, `/qq usage …`, `/qq pick …` and unknown sub-commands no longer get an extra generic
  receipt (the bridge answers for itself), which removes one useless message.
- Cleaned up a leftover `+` line in `slash.ts` from an older hand-patched edit
  (`+reply(formatPicker(picker))` — harmless but dirty).

### Compatibility

- `/reload`, `/new`, `/quit`, `/compact` and friends behave exactly as before; only `/qq <sub>` is now
  held to the same gates.
- No config change required: deployments with `allowReload: true` keep working, and `/qq quit` is answered
  with a refusal when `allowQuit` is false (the default).

### Tests

- New `test/qq-bridge-gate.test.mjs` (21 assertions): sub-command mapping, three gate refusals, busy
  refusal, receipt-before-dispatch ordering, multi-word sub-commands, receipt truncation, `/reload` regression.
- Full suite: 274 assertions across 22 test files pass; `tsc --noEmit --strict` is clean for the changed
  `slash.ts`.

## [2.6.1] - 2026-11-01

### Changed

- **Per-language changelogs**: the Chinese changelog is renamed to `CHANGELOG.zh-CN.md` and this English
  `CHANGELOG.en.md` is added. `README.md` links to `CHANGELOG.en.md`, `docs/README.zh-CN.md` links to
  `CHANGELOG.zh-CN.md`.

## [2.6.0] - 2026-11-01

### Added

- **Inline buttons for approvals and single-choice lists**: approval cards carry ✅ 允许一次 / ❌ 拒绝 /
  🚀 以后都同意 buttons (strict tools show only the first two); the `/tree`, `/fork`, `/resume` and
  model-selection lists carry option buttons (2 columns, at most 5 rows, labels truncated at 10 characters
  while the full list stays in the message body). Buttons are attached only to markdown replies
  (`markdownReply=true`).
- **`INTERACTION_CREATE` event pipeline**: the gateway subscribes to intent `1<<26` and dispatches
  interaction events; `QQApi.acknowledgeInteraction` replies with `PUT /interactions/{id}` inside the
  5-second window (matched → ACK 0; expired / unauthorized / out-of-range → ACK 3, duplicate operation).
- **`qq/keyboard.ts`**: keyboard construction plus `button_data` encode/decode, routed by the top-level
  `t` discriminator (`approval` / `pick`).

### Changed

- `QQApi.sendC2C`'s `SendOptions.keyboard` is only sent with markdown messages; when a markdown send
  fails and falls back to plain text, the keyboard is dropped automatically.
- `replyTo` / `bridgeReply` gain an optional `keyboard` passthrough. Picker-button clicks reuse the
  "reply with a number" `/qq pick` dispatch path; approval-button clicks reuse `Approver.confirm` /
  `allowAll`. Text replies (同意/拒绝 N, numbers) all remain as fallbacks.

### Compatibility

- With `markdownReply=false` the behaviour is exactly as before (no keyboard, plain-text replies).
- Custom buttons require the "invited" enablement on the QQ Open Platform; if it is not granted, the
  buttons do not render and numbered/text replies are unaffected.

## [2.5.0] - 2026-11-01

### Added

- **`markdownReply` takes effect**: set `true` and all replies go through QQ markdown messages
  (`msg_type=2`); GFM tables and code blocks are rendered by the QQ client. Previously this config was
  parsed but never consumed. On send failure (e.g. no markdown permission) `qq/api.ts` automatically
  falls back to plain text — safe by design.
- **`util/chunk.ts` splitter keeps tables intact**: `splitText` preserves GFM tables as whole blocks
  (table rows are buffered and flushed as a block when a non-table line appears) and never splits at
  code-fence boundaries; long replies no longer show tables cut in half.

### Changed

- The reply format is driven by `state.cfg.markdownReply`: `replyTo`'s `format` defaults to `auto` and
  applies to final answers, error notices, approval prompts and every receipt; an explicit `"text"`
  still forces plain text.

### Compatibility

- `markdownReply` still defaults to `false`; behaviour is unchanged when it is disabled.

## [2.4.1] - 2026-11-01

### Added

- **`!` / `!!` get an explicit receipt instead of being silently dropped**: these prefixes (full-width
  `！` / `！！` included) are shell shortcuts only in pi's host TUI / RPC front ends (`interactive-mode`'s
  `text.startsWith("!")`, the RPC `bash` control command); the extension API has no equivalent
  (`pi.sendUserMessage()` does not dispatch them, `pi.exec()` bypasses approval and session history).
  `routeSlash()` now intercepts them first and replies explaining why they cannot run and what to do
  instead (describe the task in words; it then goes through the `bash` tool with a QQ approval first).
  Neither executed nor forwarded to the model as chat.
- **`/help` gains a line**: `!` / `!!` are not supported.

### Changed

- **Detection deliberately tightened**: a bang command requires "prefix + non-empty command" (a bare
  `!`, `!!`, `!!!`, `/xxx`, or a sentence-final exclamation such as `你好!` stays ordinary chat), so
  emotional exclamation marks are not swallowed.

### Fixed

- **`/qq reload` no longer errors with `This extension ctx is stale after session replacement or reload`**
  (same for the numbered picks of `/new`, `/clone`, `/resume`, `/fork`, `/tree`): after `runBridge()`
  the handler still called `syncModelFromCtx()` to read `ctx.model`, while `reload()` / `newSession()` /
  `fork()` / `switchSession()` / `navigateTree()` make pi turn every guard getter of the old
  `ExtensionCommandContext` into a throw (`runner.js`'s `createCommandContext` keeps lazy descriptors on
  purpose). Now a `REPLACES_RUNTIME` set (`reload` / `update` / `new` / `quit` / `clone`) skips the ctx
  teardown entirely when the runtime was replaced; `syncModelFromCtx()` itself is fault-tolerant (it
  backs the picks of tree/fork/resume, whose branches only the runtime knows); and after a bridge error
  the code stops touching ctx. Regression test `test/bridge-stale-ctx.test.mjs` reproduces the original
  stack (`syncModelFromCtx` ← `handler`) with a fake ctx whose every getter throws: 3 cases failed
  before the fix, all 5 pass after.

### Compatibility

- Pure additions: slash-command routing, approval, queue, progress and credential intake are unaffected.
- One behaviour change: `!xxx` / `!!xxx` used to be forwarded to the model as ordinary text; they are
  now answered without execution. If you relied on sending `!xxx` to make the model call `bash` itself,
  describe the task normally instead.
- Messages with attachments still bypass all command routing (including bang detection), as before.
- `/reload`, `/update`, `/new`, `/clone` still do what they did (the session is really replaced or
  reloaded); they just no longer report an extra error.
- Tests: new `test/bang-notice.test.mjs` (6 cases) and `test/bridge-stale-ctx.test.mjs` (5 cases); all
  19 test files green under `npm test`.
- Painless upgrade: config format, command names, approval and queue semantics unchanged; `!` / `!!`
  were already "not executed" — only the silence became an explicit receipt.

## [2.4.0] - 2026-11-01

### Added

- **No more silence when the model runs out of credit or its key is invalid**: on a provider error pi
  only leaves `stopReason: "error"` + `errorMessage` on the assistant message and produces **no body
  text**, so QQ used to see just "no reaction". Now `message_end` classifies the error (`billing` /
  `auth` / `permission` / `rate` / `other`) and `agent_settled` replies with the **current model**
  (`provider/model`), the server's original message and three recovery paths. 401 / 402 / `1311 plan
  not open` all take the "recoverable" branch; errors with body text, user-cancelled runs and 500-class
  errors behave as before.
- **Remote key replacement**: after running out of credit, sending a bare key (`sk-…` / `ark-…` / `AIza…`
  / hex / base64 / local-service placeholders like `ollama`, quoted or backticked also accepted) writes
  it into the failing provider in `~/.pi/agent/auth.json` and really probes it once with
  `GET <baseUrl>/models`, replying with a masked fragment and the probe result. **No `sk-` prefix is
  assumed**: the only criteria are "non-empty + printable ASCII + no whitespace"; a bare string (the
  whole message is the key) additionally requires length ≥ 12 with digits / uppercase / separators, so
  ordinary text like `configuration.ts` is not swallowed.
- **Onboarding a new endpoint from QQ**: send `https://host/v1 <key>` or `endpoint <url> <key> models a,b`
  → probes `/models` (falls back to `/v1` without a version suffix; 401/403 immediately marks the key
  invalid) → filters out non-chat ids (`embedding` / `rerank` / speech / image generation) → writes
  `models.json` + `pi.registerProvider()` (usable in the running process immediately) → sends a
  **numbered list with context sizes**; replying with a number calls `pi.setModel()` (reuses the
  existing picker, valid 10 minutes). The provider id is auto-derived as `qq-<host>`, numbered on
  collision.
- **Model parameters align with the built-in catalog**: `/models` usually returns only ids, so
  `borrowModelMeta()` borrows `contextWindow` / `maxTokens` / `reasoning` / `input` / `thinkingLevelMap` /
  `cost` / `compat` / `inputLimits` from `modelRegistry.getAll()` (built-in catalog + configured
  providers) by model id, ordered "same host > same-vendor domain family > `openai-completions`".
  Conservative defaults (128k / 16k) apply only when nothing can be borrowed, and the receipt says how
  many were filled in and how many are defaults.
- **Self-update from QQ**: `/update` (or 「更新自己」「升级一下插件」「自更新」) → `npm view` for the
  latest version → **`pi update npm:@zxh126/pi-qqbot`** → **version-verification gate** (the on-disk
  `package.json` must equal the registry version, otherwise it only reports and does not reload) →
  `/qq reload` (`ctx.reload()`). Natural-language triggers are deliberately narrow — a bare 「更新」
  is not recognised.

### Changed

- **Config `commands.allowUpdate`** (default `false`, in the style of `allowReload` / `allowQuit`):
  gates `/update` and 「更新自己」; a top-level default plus per-bot override.
- **`PickerKind` gains `model`**: numbered selection supports "models of a newly onboarded service";
  picking one calls `pi.setModel()` directly; when the model is no longer in the catalog it says so
  instead of silently proceeding, prompting a fresh `/model`.
- **Error notices and logs**: `errorMessage` is uniformly run through `redactSecrets()` + whitespace
  collapse + 600-char clip; the error class and current model are written to `pi-qqbot.log`
  (`[reply] 本轮模型接口报错: <class> <provider/model> <original>`), inspectable afterwards.

### Compatibility

- Pure additions: without `commands.allowUpdate` nothing changes; outside the billing/auth-failure state
  a bare key is not treated as a credential (the explicit `key …` form excepted).
- Requires pi to provide `message_end`'s `stopReason` / `errorMessage`, `pi.registerProvider()` and
  `pi.setModel()` (all present in pi 1.4.x).
- Disk writes touch only pi's own `auth.json` / `models.json`, using pi's own `proper-lockfile` +
  atomic rename; `models.json` only adds or edits its own provider, never touching others.
- The install directory is shared: `/update` only updates the disk; other pi processes still running
  old code must reload or restart on their own.

### Tests

- **14 suites / 191 cases** all green (`npm test`).
- New `test/billing.test.mjs` (26): error classification, Chinese copy, `parseCredentialMessage` forms,
  `looksLikeSecret` (including non-`sk-` prefixes, explicit/bare tightness), `stripWrapping`,
  `normalizeBaseUrl` / `extractModelIds`, `probeEndpoint` (success / `/v1` fallback / immediate 401 /
  network error), `providerIdForEndpoint`, `borrowModelMeta`, `filterChatModelIds`, `modelLabel`,
  `updateProviderKey` / `upsertEndpointProvider` persistence.
- New `test/credential-intake.test.mjs` (11): drives the real `handleMessage` — bare key while broke,
  no swallow when not broke, explicit prefix, endpoint registration + numbered list, metadata
  borrowing, probe 401, resend with `models`, numbered pick `setModel`, non-`sk` key, quoted key.
- New `test/selfupdate.test.mjs` (13): version comparison (incl. prerelease), npm output parsing, five
  flow outcomes (latest / updated / check failure / update failure / version mismatch),
  `isUpdateSelfIntent`, `/update` gating.
- New `test/error-notice.test.mjs` (8): 402 / 401 / 500 / with body / cancelled / cleared after a good
  run / credential gate / redaction.

## [2.3.0] - 2026-10-31

### Added

- **Remote-context notice**: in `before_agent_start` it first checks "was this turn dispatched by this
  extension as a QQ message", and only then writes a notice into the system prompt's
  `qq-remote-context` section (before the user message, invisible on both QQ and the TUI): the
  conversation comes from a remote QQ user who cannot see the local screen or dialogs; desktop
  screenshots / screen OCR / UI automation / keyboard-mouse simulation / headed browsers are **off by
  default** (`mcp__screenshot`, `mcp__winui` named explicitly) — render images off-screen to PNG and
  send them back with `qq_send_file`; capturing the desktop once is allowed only to check whether the
  machine is locked. Merely loading the extension or chatting in the local TUI injects nothing — it
  must wait for the first QQ message to actually start a run.
- **System-prompt rules**: every run **from QQ** appends three short rules (remote user / locked screen
  → off-screen rendering / say so plainly when human help is needed) so they survive compaction of a
  long session; no stacking within one turn, and local TUI runs get nothing.
- **Re-injection after compaction**: `session_compact` clears the "noticed" flag so the next message
  injects the notice again.
- **Config `remote`**: `notice` (default `true`, once per session), `guidelines` (default `true`),
  `extra` (appended to the notice, empty by default); a top-level default plus per-bot override.
- **Local hand-off correction**: when, within one session, the previous turn came from QQ and the next
  is typed directly in the local TUI, that local turn injects a one-time `qq-local-handoff` section
  ("remote QQ user" premise void: screenshots are fine, no `qq_send_file` needed); consecutive local
  turns do not repeat it. Detected via the `input` event's `source=interactive` (this extension's
  `sendUserMessage` is `extension`, so it never misfires); interjecting mid-run of a QQ turn does not
  count as a hand-off (no new run). `/status` gains `来源: QQ（远程）/ 本机（TUI）`.

### Fixed

- **No automatic progress while an approval is pending**: when a tool approval waits for the user,
  automatic progress pushes are held back (otherwise one line every 15 s would push the approval
  prompt off-screen); they resume on the next interval after the approval is handled (or times out).
  Asking `/progress` yourself still works; `/status` shows 「等审批期间暂缓」. The in-session manual
  pause (`/progress off`) and quota-silence semantics are unchanged.

### Tests

- New `test/remote-notice.test.mjs` (defaults / copy elements / `extra` append / system-rule length).
- `test/config.test.mjs` gains `remote` global-default + per-account override cases.
- `test/accounts.test.mjs` gains 3 cases: **local TUI chat injects nothing**, only the first QQ
  message's run injects and once per session, re-injection after compaction; `remote.notice=false`
  disables only the notice and `remote.extra` appends; `remote.guidelines=false` disables only the
  rules, and repeated triggers within one turn do not stack.
- `test/progress.test.mjs` gains cases: no push while an approval is pending, `/status` shows the hold,
  asking for progress still answers once, pushes resume after the approval is handled.
- `test/accounts.test.mjs` gains 2 more cases: the local hand-off corrects exactly once (`/status`
  shows the origin); the pending hand-off is overwritten by a new QQ turn, and an `extension`-source
  input is not a hand-off.
- `test/remote-notice.test.mjs` gains `qq-local-handoff` tag and copy assertions.

## [2.2.1] - 2026-02-11

### Fixed

- **Copy text was treated as a command**: when a user quoted the whole approval prompt back (or
  discussed it in a sentence like 「你这句话里说『取消自动同意』」), the old **unanchored** regex
  matched 「取消自动同意」 / 「以后都同意」 inside the sentence and acted on it (the log even showed
  a reply of 「当前没有开启自动同意」). `parseReply` now strips whitespace and punctuation and does
  **whole-sentence matching** with a length cap (≤ 12 chars); quoted prompts, long sentences and
  exclamations are never parsed — they go to pi as ordinary chat.
- **The approval prompt was too wordy**: compressed from 3 lines (with 「停止」/「以后都同意」/
  「取消自动同意」) to 2 lines: `[审批 #N] <summary>` + `回「同意 N」或「拒绝 N」；想全部放行回
  「以后都同意」。`; tools that must be confirmed every time (file sending) use the strict copy
  (no 「以后都同意」).

### Tests

- New `test/approver.test.mjs` (6 cases: approve/reject variants, stop / always-allow / revoke-always,
  quoted prompt not parsed, mid-sentence keywords not parsed, 「停止汇报」 not a command, overlong
  sentence not parsed, prompt ≤ 2 lines).
- `test/queue.test.mjs` syncs the strict-copy assertions (19 cases).

## [2.2.0] - 2026-02-11

### Added

- **Sending local files to QQ**: new tool `qq_send_file(path, name?)` and command `/sendfile <path>`.
  Uploads through the official rich-media API in chunks (`upload_prepare` → chunked `PUT` →
  `upload_part_finish` → merge for `file_info`), then sends with `msg_type=7` + `media.file_info` as a
  **passive reply** (`srv_send_msg:false`, no active-quota burn). Local files have no public URL and
  the one-shot binary upload caps at 5 MB, so everything goes through chunking, no relay dependency.
- **`file_type` mapping**: png/jpg/jpeg → image (1), mp4 → video (2), silk → voice (3), everything
  else → file (4); otherwise QQ answers `850019`. Images/videos/voice display inline; other formats
  arrive as a downloadable file card.
- **Outbound files are force-gated (asked every time)**: `qq_send_file` is added to
  `FORCE_APPROVAL_TOOLS` — a QQ approval is mandatory no matter what `approve.tools` says, and it
  **skips the session-wide 「以后都同意」 and remembered decisions**; each file is confirmed on its
  own and is never written into remember. The prompt shows the file path and display name, with
  「需单独确认」.
- **Config `files`**: `enabled` (default true), `maxBytes` (default 30 MB; QQ hard cap 200 MB),
  overridable per bot.
- **Error-code translation**: `850031` too large, `850019` format unsupported, `40093002` daily
  capacity reached, `850027` timeout, `850018` muted/rate-limited, `40093001` transfer failed — all
  turned into Chinese receipts.

### Changed

- `qq/api.ts`: new `sendC2CMedia(openid, fileInfo, { msgId })`, reusing the existing send queue and
  `msg_seq` counting.
- `slash.ts`: new takable command `sendfile` (not gated by `commands.allowSession`; guarded by
  `files.enabled` + approval).
- `index.ts`: `State` records `restBase`; `/help` gains the `/sendfile` entry.
- `package.json`: new peer dependency `typebox` (tool-parameter schema; aliased by the pi runtime).

### Tests

- New `test/upload.test.mjs` (9 cases: `file_type` mapping, md5/sha1/md5_10m, the full chunked
  pipeline with byte reassembly, image type, chunk retry, local validation (missing / directory /
  empty / over limit), merge without `file_info`, error-code translation, `sendC2CMedia`'s
  `msg_type=7` body).
- Added to `npm test`; the whole suite went 130 → 140 cases green (queue 18 → 19, with the new
  "file sends are always approved" case).

## [2.1.0] - 2026-02-11

### Added

- **Receiving QQ attachments (images / voice / video / documents / archives / plain files)**: incoming
  attachments are downloaded to temp files immediately and their paths are handed to pi as marker
  lines — images as `图片路径 <path>`, the rest by type as `语音路径` / `视频路径` / `文档路径` /
  `压缩包路径` / `文件路径`. The original text stays on the first line, in the same turn as the
  paths; pi's `read` tool can open the image directly and `bash` can process the files. (Before
  2.1.0 only images were kept and never saved to disk; a pure-image message delivered an empty
  string to pi.)
- **QQ receipt**: after saving, the bot replies 「已收到 N 个附件（图片 ×1、文档 ×1），已存为临时文件
  并交给 pi：」 followed by each path; failed downloads are listed with the reason, and the text part
  still runs.
- **Automatic temp-file cleanup**: the save directory is split by date
  (`<system temp>/pi-qqbot/<bot>/<YYYY-MM-DD>/`) and swept at session start according to
  `attachments.retentionHours` (default 24 h) and `attachments.maxFiles` (default 200); `<date>`
  subdirectories not created by this extension are never touched.
- **Config `attachments`**: `enabled` / `dir` / `maxBytes` / `maxPerMessage` / `retentionHours` /
  `maxFiles`, overridable per bot in `qqbots[]` like `queue` / `progress`. With `enabled: false` it
  replies with an ignore notice and processes text only.
- **New `attachment.ts`**: six-type detection, filename sanitising (only `[0-9a-zA-Z._-]` kept),
  concurrent downloads (default 3), 25 MB per-attachment cap, 30 s download timeout, one retry with
  credentials on 401/403, a failed attachment never blocks the others.

### Changed

- `qq/gateway.ts`: `QQMessage.attachments` becomes `{ url, contentType, filename?, size? }[]` and
  **no longer drops non-image attachments**; when a voice message body only has `voice_wav_url`, that
  is used as the download URL.
- The gateway log no longer prints the whole JSON packet (it carries the short-lived `rkey`
  credential); it logs openid / content summary / attachment count / source host instead.
- `handleMessage()`: messages with attachments **bypass** slash commands, approval parsing, numbered
  selection and built-in commands — always ordinary content (still queued when busy).

### Tests

- New `test/attachment.test.mjs` (12 cases: six-type detection, extension rules, saved content, over
  limit, 401 retry, partial failure, per-message cap, receipt copy, directory cleanup).
- `test/queue.test.mjs` 12 → 18 cases (pure-image dispatch, text+document line joining, busy queueing,
  `enabled=false` ignore notice, `/status` bypass, failed download still delivers the text).

## [2.0.1] - 2026-10-25

### Fixed

- **Word order: 「暂停汇报进度」 was not recognised** and leaked to the model as ordinary chat. Both
  orders — 「暂停**进度汇报**」 and 「暂停**汇报进度**」 — are now recognised; trailing particles
  like 「别汇报了**吧**」 are also caught.

### Changed

- **Colloquial mute words expanded**: 「别汇报了」「别说了」「别讲了」「别推了」「别发了」「别报了」
  「闭嘴」「安静」「打住」「甭」 etc. are equivalent to `/progress off` (resume with 「恢复汇报」 /
  「接着说」).
- **「停」 now interrupts the task** (per user feedback): `停`/`停下`/`停一下`/`停停`/`停掉`/`别跑了`
  join `RE_CANCEL` and are fully equivalent to `/cancel`; only noun-carrying phrases like 「停止汇报」
  or pure shut-up words mute the reports.
- **Asking for progress is a command**: 「汇报一下当前进度」「看一下进度」「说说进度」「进度如何」
  「进度怎么样」 are no longer forwarded to pi as chat; while busy they answer once with a summary
  without queueing, while idle they answer 「当前没有正在运行的任务」.
- `/help` distinguishes the two meanings: to stop only the pushes use `/progress off` / 「别汇报了」 /
  「闭嘴」; 「停」 interrupts the task.
- Both READMEs gain the colloquial-shortcut table (intent → things to say).

### Tests

- `test/progress.test.mjs` 16 → 22 cases (new/rewritten: both word orders, colloquial mute words,
  「停/停下/停一下/停止/取消」 all interrupt, 「停止汇报」 still mutes, three poses of asking for
  progress, no false positives).

## [2.0.0] - 2026-10-25

### Added

- **Multiple QQ bots (one config, one machine, several pi processes)**: the config takes
  `qqbots: [...]` with multiple `appId` / `appSecret` pairs, supporting `name` and per-account
  overrides of `sandbox` / `allowlist` / `queue` / `progress` / `approve` / `commands` (unwritten keys
  inherit the global defaults, merged per key).
- **Automatic claiming**: every pi process, on start (`session_start`), claims the first **offline**
  bot in config order; processes that cannot claim stay off QQ but rescan every 5 seconds and take
  over when someone exits. One lock per process — never concurrent double-connection.
- **"Never steal a bot temporarily released by a reload"**: on session rebuild (`/reload`, `/new`,
  `/fork`, `/resume`) a 20-second reservation is written **before** releasing the lock, so other
  processes skip that bot; after claiming, the reservation record is re-read and yielded on collision
  (closing the race window). The new runtime reclaims its own bot with the same pid, silently.
- **Visible identity**: the claim log carries bot name / appId / cwd / pid; the first QQ receipt is
  prefixed with 「（已接入 qqbot「work」）」; `/status`'s first line shows `bot: work (…0143) · cwd: …`.
- **Takeover notices**: `~/.pi/agent/pi-qqbot-<appId>.owner.json` records the previous holder's pid and
  working directory; on takeover the log writes the old and new pid/cwd and the first QQ receipt
  carries 「（qqbot「work」已由新实例接管 · 当前工作目录 …）」.
- `PI_QQBOT_ACCOUNT=<name|appId>` pins an account (for debugging or a fixed directory); an unknown
  name means no connection, with a log line.
- **Credentials are verified right after claiming**: the claim immediately exchanges an
  `access_token`; on failure it **releases the lock** and skips that bot (trying the next one), so a
  bot with a wrong secret can no longer hold the slot while never connecting; when nothing works it
  stops rescanning pointlessly.
- **Fix** `AuthManager`: the QQ platform answers invalid credentials with HTTP 200 + `code 100016`;
  the old code went on to connect the gateway with an empty token. It now throws immediately (with
  code/message) and is caught during claiming.
- New doc [docs/accounts.md](docs/accounts.md); new tests `test/config.test.mjs` (9),
  `test/lock.test.mjs` (8, real subprocesses + real lockfile, including "two processes in the same
  working directory each get one bot"), `test/accounts.test.mjs` (9, end-to-end claiming / notices /
  invalid-credential degradation), `test/auth.test.mjs` (3).

### Changed

- Logs are per account: `~/.pi/agent/pi-qqbot-<name>.log` (several processes on one machine no longer
  interleave); the single-bot v1 format still writes `pi-qqbot.log`.
- `/status` gains the bot identity and working-directory lines; `/help` gains the multi-bot note.
- Config loading becomes `loadAccounts()` (returns the account list in order); `loadConfig()` stays as
  a compatibility wrapper.

### Compatibility

- **Old single-bot configs work unchanged** (equivalent to an account named `default`, behaving like
  1.5.0); `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` still apply to the single-bot scenario only.
- Writing both the top-level `appId` and `qqbots` → error, no connection (ambiguity is not guessed);
  an account with missing credentials / duplicate `appId` / duplicate `name` is skipped with a log
  line, the rest work normally.
- **A bot is not bound to a working directory**: allocation depends only on config order and online
  state, not on cwd — several pi processes in the same directory each get their own bot. cwd is only
  used for logs, takeover notices and `/status`.
- Recommended: restart (or `/reload`) once after the upgrade — per-account log files only appear on a
  fresh start.

## [1.5.0] - 2026-10-25

### Added

- **Pause / resume automatic progress reports (per session)**: `/progress off` (aliases `/p pause`,
  `暂停`, `stop`, 「暂停汇报」「关闭自动汇报」) stops the timer; `/progress on` (aliases `resume`,
  `start`, `恢复`, 「恢复汇报」「继续汇报」) turns it back on.
  - The manual pause survives runs (`agent_start` no longer resets it) and only resets to enabled on
    `session_start` (`/new`, `/reload`, restart).
  - While manually paused, `/progress`, 「进度」, 「当前进度」, 「现在进度」, 「进展」 **answer once
    with the current summary** without secretly re-opening the 15 s timer, and the reply ends with
    「（自动汇报已暂停，发 /progress on 恢复）」.
  - Strictly separate from the existing "quota silence": quota silence is the automatic pause after a
    failed send, cleared by asking once; the manual pause is cleared only by `on` / 「恢复汇报」.
  - `/progress <gibberish>` answers with usage instead of being silently ignored.
- `/status` gains an `自动汇报:` line distinguishing four modes: `开启（每 Ns）` / `已暂停（本会话…）`
  / `推送失败已静默` / `未启用（配置 progress.enabled=false）`.
- Bare-text queries 「当前进度」「现在进度」「目前进展」 (sub-commands allowed, e.g. 「进度 暂停」)
  also route to the progress query.
- Tests: `test/progress.test.mjs` gains 7 cases (pause/resume immediate effect, survives runs, asking
  while paused does not unpause, Chinese commands without false positives, idle 「当前进度」,
  `/status` copy, unknown subcommand).

### Changed

- `/progress` (no argument) no longer clears the pause while manually paused (previously any query
  wiped the pause flag).
- "Failed-send silence" and "user pause" are two separate states (`progressPaused` / `progressMuted`)
  that no longer overwrite each other.
- README (English) and `docs/README.zh-CN.md` command table, progress section and `progress.enabled`
  notes updated in sync.

## [1.4.0] - 2026-10-24

### Added

- While a task runs, a progress summary is pushed every `progress.intervalMs` (default 15 s): turns,
  tool-call count with the top three tools, failure count, the most recently finished tool (with
  duration), the tool currently running, and token usage. Built purely from local events — no model
  call, no tokens spent.
- End-to-end secret redaction (`redact.ts`): progress summaries, approval prompts, queue previews and
  log writes all pass through one scrubber covering `Authorization` / QQ bot tokens / `sk-…` /
  `ghp_…` / `npm_…` / `AKIA…` / JWT / PEM / `token=` / `password=` / `--api-key` / URL `user:pass@` /
  high-entropy strings.
- `/progress` (aliases `/p`, 「进度」) and the busy-time queries 「到哪了」 / 「怎么样了」.
- A final answer that cannot be delivered (quota) is cached and re-sent with
  「（上一条回复发送失败，补发如下）」 on the next message.
- Config `progress.enabled` / `progress.intervalMs` (env override `PI_QQBOT_PROGRESS_MS`).

## [1.3.3] - 2026-10-24

### Fixed

- The `/usage` report read-back now polls: `appendEntry` lands after the command's `await` returns,
  which occasionally missed the freshly written report.

## [1.3.2] - 2026-10-24

### Fixed

- `/usage` read-back fallback: when `getEntries` has not refreshed yet, read the tail of the session
  file directly; `generatedAt` tolerates millisecond timestamps.

## [1.3.1] - 2026-10-24

### Fixed

- `/usage rate` now really executes and reads the config file back to confirm, instead of claiming
  success in words only.

## [1.3.0] - 2026-10-24

### Added

- `/usage`, `/cost` (extension commands that only print to `ctx.ui.*`) are bridged back to QQ instead
  of being silent.
- `/mcp`, `/llama` — commands that need host-TUI selection dialogs or login — answer with an explicit
  explanation instead.

## [1.2.1] - 2026-10-24

### Changed

- Log timestamps use local time with a UTC offset (e.g. `[2026-10-24T07:39:09.762+08:00]`), aligning
  directly with file mtimes and process start times — no timezone arithmetic needed.

## [1.2.0] - 2026-10-24

### Added

- Messages arriving while busy go into a queue and resume automatically after the current task
  settles; `/cancel` is never queued and takes effect immediately.
- `/queue` (alias `/q`) to view the queue; `/queue clear`, `/queue drop <编号>` to manage it.
- Config `queue.max` (0 = queueing off) and `queue.ack`.

## [1.1.0] - 2026-10-24

### Added

- Numbered-selection takeover for `/tree`, `/fork`, `/resume`: replies with a list of at most 10
  entries, valid only for the asking user, expiring in 10 minutes.
- `/clone` support.

## [1.0.0] - 2026-10-24

### Added

- Takes over pi's slash commands (allowlist `commands.passthrough` / `allowReload` / `allowQuit` /
  `allowSession`): `/reload`, `/new`, `/compact`, `/session`, `/name`, `/model`, `/thinking`,
  `/quit`, plus passthrough of extension commands, prompt templates and `/skill:name`.
- While a task is running, `/reload`, `/new`, `/compact`, `/quit`, `/tree`, `/fork`, `/clone`,
  `/resume` refuse to execute.

## [0.3.0] - 2026-10-24

### Added

- `/cancel` (aliases `/stop`, `/abort`, 「取消」「停止」「中止」「终止」「算了」) interrupts the
  running task: first terminates pending approvals and empties the queue, then `ctx.abort()` and
  drops the half-written reply; an 8-second watchdog releases the busy flag as a fallback.

## [0.2.1] - 2026-10-24

### Changed

- The Chinese README moves into `docs/README.zh-CN.md`, fixing the npm page defaulting to the Chinese
  readme.

## [0.2.0] - 2026-10-24

### Added

- Session-level "always allow" (`approve.remember`), including the request already waiting;
  phrases that only look like cancelling — 「取消自动同意」「恢复审批」 — still go through the
  approval branch.
- Bilingual README (Chinese and English).

## [0.1.0] - 2026-10-16

### Added

- Initial release: bridges the Pi coding agent into QQ private chats (C2C), single session +
  `proper-lockfile` single-instance lock (host takeover), remote approval before dangerous tools
  (`bash` / `powershell` / `write` / `edit` and `destructiveHint` tools) run, automatic segmentation
  of long replies.
