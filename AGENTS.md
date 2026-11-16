# Repository guide

This is the maintained spinachx64 fork of pi-qqbot, imported from upstream 2.8.0 and validated with Pi 1.5.2. Keep the upstream MIT notice and attribution.

## Development

- Node.js 22+; install with `npm ci --ignore-scripts --omit=peer`.
- Run `npm test` before committing functional changes. Tests use temporary HOME directories and mocked QQ/model interfaces; do not make live network calls from the default test suite.
- Pi loads the TypeScript entry directly; no build step is required. The Pi runtime supplies its SDK through extension-loader aliases. Test aliases use `test/pi-api-stub.mjs`.
- `index.ts` contains extension lifecycle and commands; `isolation.ts` owns conversation scheduling and persisted routing; `qq/` contains gateway, message and media APIs.

## Invariants

- Use one Pi process and one active model run. Each group shares one conversation, and each private user has a separate conversation.
- Keep task queues, cancellation, approval memory, progress and pickers conversation-local. Never deliver an answer or file to a different target.
- Internal dispatch commands must use `expandPromptTemplates: true`, without `deliverAs`, so they do not become model prompts.
- Session replacement invalidates old Pi/context objects. Continue through the newly bound API or the fresh `withSession` context; preserve the gateway and other conversations' pending work.
- Do not adopt the old mixed history for a new isolated conversation. Failed switches must not execute a message in another conversation.
- Conversation isolation does not isolate the filesystem, credentials or tools. Keep that limit explicit in docs.
- Keep the fixed “收到，正在处理” receipt disabled. Preserve configurable progress and Markdown behavior.
- Group passive replies have a shorter window than private replies; preserve message IDs and reserve capacity for final answers.
- Keep this fork Git-managed. Do not restore upstream npm self-update behavior without an explicit migration design.

## Files and provenance

- Commit source, tests, documentation and the dependency lockfile.
- Never commit live config, `.env`, keys, conversation logs, session files, backups, `node_modules` or local caches. Use placeholders in examples.
- Update README/CHANGELOG for user-visible behavior changes. Historical upstream docs are references, not the current behavior specification.
