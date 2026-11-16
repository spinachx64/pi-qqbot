/**
 * Slash-command routing for pi-qqbot.
 *
 * QQ messages that start with `/` are handled in this order:
 *
 *   1. **pi extension commands / prompt templates / skill commands** — anything the
 *      running pi instance reports in `pi.getCommands()` (source: extension | prompt |
 *      skill). These are dispatched verbatim with
 *      `pi.sendUserMessage(text, { expandPromptTemplates: true })`, the only path pi
 *      uses to execute extension commands from a message.
 *   2. **pi built-in commands we can take over** (`TAKEOVER`) — pi never dispatches
 *      built-ins from a message (only the TUI/RPC layer does), so these are
 *      re-implemented through the extension API. The command-only APIs
 *      (`reload`, `newSession`, `fork`, `navigateTree`, `switchSession`) need a fresh
 *      `ExtensionCommandContext`, so they run inside the `/qq` bridge command
 *      registered by this extension.
 *   3. **built-ins we cannot reach** (`HOST_ONLY`) — reply "run it on the host".
 *   4. **anything else** — treated as ordinary chat text (the caller forwards it).
 *
 * Messages starting with `!` / `!!` are not slash commands but they are handled here too,
 * for the same reason: pi only turns them into shell commands in the **TUI / RPC front end**
 * (`interactive-mode` checks `text.startsWith("!")`, RPC has a `bash` control command), and the
 * extension API exposes no equivalent (`pi.sendUserMessage()` does not dispatch them,
 * `pi.exec()` bypasses approval and session history). Forwarding `!ls` to the model would just
 * confuse it, so the bridge answers with an explicit "not supported in QQ" receipt.
 *
 * Selection-style commands (`/tree`, `/fork`, `/resume`) answer with a numbered list
 * and accept the number as the next message; the pending list lives in `BridgeStore`.
 *
 * Everything is opted in conservatively through `commands` in the config file.
 */

import fs from "node:fs";
import path from "node:path";

import { PI_AGENT_DIR } from "./constants";
 import { buildPickerKeyboard, type InlineKeyboard } from "./qq/keyboard";

export interface SlashCommandText {
	/** command name without the leading slash, lower-cased (`skill:name` keeps its colon) */
	name: string;
	/** raw text after the command name */
	args: string;
	/** the original message */
	raw: string;
}

const SLASH = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/;

export function parseSlash(text: string): SlashCommandText | null {
	const match = SLASH.exec(text.trim());
	if (!match) return null;
	return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim(), raw: text.trim() };
}

export interface BangCommand {
	/** `!` (run + show output to the model) or `!!` (run, keep output out of the context) */
	prefix: "!" | "!!";
	/** whatever followed the prefix */
	command: string;
}

/** `!` / `!!`，全角 `！` / `！！` 也认（中文输入法很容易打出全角） */
const BANG = /^([!！]{1,2})\s*([\s\S]*\S)\s*$/;

/**
 * 识别 pi 的 shell 快捷前缀。只有「前缀 + 非空命令」才算，单独一个 `!`、`!!!`、`你好!` 都退回普通文本，
 * 免得把情绪化感叹号当成命令吞掉。
 */
export function parseBangCommand(text: string): BangCommand | null {
	const match = BANG.exec(text.trim());
	if (!match) return null;
	const rest = match[2]!.trim();
	// `!!!ls` 这类：第三个别当成命令内容，整体退回普通文本
	if (/^[!！]/.test(rest)) return null;
	return { prefix: match[1]!.replace(/！/g, "!") as "!" | "!!", command: rest };
}

/** `!` / `!!` 的 QQ 侧回执：说清为什么不能执行、以及该怎么做 */
export function bangNotice(cmd: BangCommand): string {
	return [
		`QQ 侧不支持 ${cmd.prefix} 命令，这一条没有执行。`,
		`${cmd.prefix} 是主机 pi 里的 shell 快捷方式${cmd.prefix === "!!" ? "（`!!` 还会把输出排除出模型上下文）" : ""}，` +
			"只有 TUI / RPC 前端认识；扩展 API 没有等价能力，桥接不会假装执行一遍（也不会把这条丢给模型去猜）。",
		"想在本机跑命令：直接用中文说需求（例如「列一下当前目录里的仓库」），我会调 bash 工具执行，执行前在 QQ 里向你申请审批。",
	].join("\n");
}

export type BridgeSub =
	| "reload"
	| "new"
	| "compact"
	| "quit"
	| "session"
	| "name"
	| "model"
	| "thinking"
	| "tree"
	| "fork"
	| "clone"
	| "resume"
	| "sendfile";

interface Takeover {
	sub: string;
	/** the command tears down the current runtime/session: reply before dispatching */
	selfDestroying?: boolean;
	/** unsafe to run while a task is in progress */
	needsIdle?: boolean;
	needsArgs?: boolean;
	hint: string;
}

/**
 * pi built-ins that can be re-implemented with extension APIs.
 * `dist/core/slash-commands.d.ts` marks the full built-in list, but pi does not
 * export it, so this table is maintained here on purpose.
 */
export const TAKEOVER: Readonly<Record<string, Takeover>> = {
	reload: { sub: "reload", selfDestroying: true, needsIdle: true, hint: "重新加载扩展/技能/模板/主题" },
update: { sub: "update", needsIdle: true, hint: "在线更新 pi-qqbot 并重载（npm + pi update）" },
	new: { sub: "new", selfDestroying: true, needsIdle: true, hint: "开启新的 pi 会话" },
	compact: { sub: "compact", needsIdle: true, hint: "压缩上下文（可带自定义指令）" },
	quit: { sub: "quit", selfDestroying: true, needsIdle: true, hint: "退出主机上的 pi" },
	session: { sub: "session", hint: "查看当前会话信息与上下文用量" },
	name: { sub: "name", hint: "设置或查看会话名称" },
	model: { sub: "model", hint: "查看/切换模型（provider/model）" },
	thinking: { sub: "thinking", hint: "查看/切换思考等级" },
	tree: { sub: "list tree", needsIdle: true, hint: "在会话树上跳转（回编号选择）" },
	fork: { sub: "list fork", needsIdle: true, hint: "从某条历史用户消息分叉（回编号选择）" },
	resume: { sub: "list resume", needsIdle: true, hint: "切换到本项目的另一个会话（回编号选择）" },
	clone: { sub: "clone", selfDestroying: true, needsIdle: true, hint: "在当前叶子位置复制会话" },
	sendfile: { sub: "sendfile", needsArgs: true, hint: "把本机文件发送到你的 QQ" },
};

/**
 * `/qq <sub> [args]` → 对应的 TAKEOVER 条目。
 *
 * `/qq` 自己也是**扩展命令**，所以直接发 `/qq reload` 会先命中 passthrough 分支：既不查
 * `commands.allow*`，也不查 `needsIdle`（等于绕过 `/reload`、`/quit` 的门禁），回执还会
 * 显示成「已派发 /qq 给 pi。」把参数吞掉。路由前先用这张表把子命令翻回内置命令名，
 * 复用同一套判定。多词 sub（`list tree` / `list fork` / `list resume`）先整体匹配，再退回首词。
 */
export function bridgeGate(args: string): { name: string; takeover: Takeover } | undefined {
	const lower = args.trim().toLowerCase();
	if (!lower) return undefined;
	const entries = Object.entries(TAKEOVER) as [string, Takeover][];
	const exact = entries.find(([, item]) => item.sub.toLowerCase() === lower);
	if (exact) return { name: exact[0], takeover: exact[1] };
	const first = lower.split(/\s+/)[0]!;
	const byFirst = entries.find(([, item]) => item.sub.split(/\s+/)[0]!.toLowerCase() === first);
	return byFirst ? { name: byFirst[0], takeover: byFirst[1] } : undefined;
}

/** 命令被禁用时该提示改哪个配置项 */
export function gateConfigKey(name: string): string {
	if (name === "reload") return "allowReload";
	if (name === "quit") return "allowQuit";
	if (name === "update") return "allowUpdate";
	return "allowSession";
}

/**
 * `/qq <sub>` 里会**换掉运行时**的动作。
 *
 * pi 在它们返回后立刻把旧 `ExtensionCommandContext` 判为 stale：每个 guard getter /
 * 方法都会抛 `This extension ctx is stale after session replacement or reload`。
 * 所以调用方在这几个动作之后不能再碰 ctx（读 `ctx.model` 也算）。
 *
 * `/qq pick` 选 tree / fork / resume 时同样会换运行时，但运行时才知道选的是哪一类，
 * 调用方对它靠 `syncModelFromCtx()` 内部的 try/catch 兜底。
 */
export const REPLACES_RUNTIME: ReadonlySet<string> = new Set(["reload", "update", "new", "quit", "clone"]);

/** pi built-ins that the extension API cannot reach at all. */
export const HOST_ONLY: ReadonlySet<string> = new Set([
	"settings",
	"hotkeys",
	"changelog",
	"trust",
	"login",
	"logout",
	"scoped-models",
	"llama",
	"import",
	"export",
	"share",
	"bug",
	"copy",
	"privacy",
]);

export interface CommandConfig {
	/** forward pi extension commands / prompt templates / skill commands */
	passthrough: boolean;
	/** allow /reload (restarts this bot too) */
	allowReload: boolean;
	/** allow /quit (stops the host pi process) */
	allowQuit: boolean;
	/** allow /update (npm + pi update + reload：在线升级 pi-qqbot 自己) */
	allowUpdate: boolean;
	/** allow session-level commands: /new, /compact, /session, /name, /model, /thinking, /tree, /fork, /clone, /resume */
	allowSession: boolean;
}

export const DEFAULT_COMMANDS: CommandConfig = {
	passthrough: true,
	allowReload: false,
	allowQuit: false,
	allowUpdate: false,
	allowSession: true,
};

export interface RouteDeps {
	/** commands pi currently knows about (extension/prompt/skill) */
	listPiCommands(): readonly { name: string; source?: string }[];
	/**
	 * deliver a pi command through pi's own dispatcher.
	 * `runsTurn` marks commands that start an agent run (prompt templates, `/skill:name`):
	 * those are serialized through the bot's queue, everything else runs immediately.
	 * Returns "queued" when the bot deferred it, "rejected" when the queue was full.
	 */
	dispatch(text: string, options?: { runsTurn?: boolean }): DispatchResult;
	/** answer the QQ user */
	/** 回用户一条消息（返回值忽略，允许实现返回是否送达） */
	reply(text: string): Promise<unknown>;
	busy: boolean;
	cfg: CommandConfig;
	log(message: string, ...rest: unknown[]): void;
}

export type DispatchResult = "dispatched" | "queued" | "rejected";

/**
 * 输出只走 `ctx.ui.*`（TUI / RPC 通道）的扩展命令。
 *
 * 这类命令在 QQ 里发了不会有任何回复：它们的结果是通过 `ctx.ui.notify()` 渲染的，
 * 而本桥接只把 assistant 文本（`message_update.text_delta`）转发到 QQ。
 *
 * - 带 `bridge`：改派 `/qq <bridge> <args>`，由桥接命令重新执行原命令并读 session 里
 *   的 custom entry，自行渲染回 QQ（用户用法不变，仍发 `/usage today`）。
 * - 不带 `bridge`：需要主机 TUI 的交互（选择框/浏览器登录），直接回执说清楚，不能沉默。
 *
 * 必须在 passthrough **之前**判断：这些命令确实在 `pi.getCommands()` 里，
 * 一旦先走 passthrough 就会被派发到黑洞。
 */
export const UI_ONLY: Readonly<Record<string, { bridge?: string; hint: string }>> = {
	usage: { bridge: "usage", hint: "用量统计会改走 /qq usage 桥接" },
	cost: { bridge: "usage", hint: "用量统计会改走 /qq usage 桥接" },
	mcp: { hint: "MCP 管理需要主机 TUI 的选择框与浏览器登录" },
	llama: { hint: "本地 llama 管理需要主机 TUI" },
};

export type RouteResult = "dispatched" | "handled" | "text";

const allowed = (cfg: CommandConfig, name: string): boolean => {
	if (name === "reload") return cfg.allowReload;
	if (name === "quit") return cfg.allowQuit;
	if (name === "update") return cfg.allowUpdate;
	// 发文件不属于会话操作：由 files.enabled + QQ 审批把关
	if (name === "sendfile") return true;
	return cfg.allowSession;
};

/** 回执/日志里展示命令原文：太长就截断，别把 QQ 消息撑爆，也别只显示首段把参数吞掉 */
function previewCommand(raw: string, max = 80): string {
	return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** Route one slash message. Returns "text" when it should be treated as chat. */
export async function routeSlash(deps: RouteDeps, text: string): Promise<RouteResult> {
	// 0. `!` / `!!`：主机前端的 shell 快捷方式，扩展 API 够不到 → 明确回执，别当聊天丢给模型
	const bang = parseBangCommand(text);
	if (bang) {
		deps.log("[cmd] 收到不支持的 shell 前缀:", bang.prefix, bang.command.slice(0, 60));
		await deps.reply(bangNotice(bang));
		return "handled";
	}

	const parsed = parseSlash(text);
	if (!parsed) return "text";
	const { name } = parsed;

	// 0.5 `/qq …`：桥接命令自身是扩展命令，落到下面的 passthrough 会**绕开** `commands.allow*`
	// 与 `needsIdle`（默认配置下 QQ 侧发 `/qq quit` 就能关掉主机），且通用回执只显示 `/qq`。
	// 这里提前分流：按内置命令的门禁判定，自毁类**先回执再派发**（动作会换掉运行时）。
	if (name === "qq") {
		const shown = previewCommand(parsed.raw);
		const gate = bridgeGate(parsed.args);
		if (!gate) {
			deps.log("[cmd] 派发 /qq 桥接命令:", shown);
			deps.dispatch(parsed.raw);
			return "dispatched";
		}
		const builtin = gate.name;
		const takeover = gate.takeover;
		if (!allowed(deps.cfg, builtin)) {
			deps.log("[cmd] 拒绝 /qq 子命令:", shown, "配置 commands." + gateConfigKey(builtin));
			await deps.reply(`/${builtin} 在 QQ 侧被禁用（配置 commands.${gateConfigKey(builtin)}）。`);
			return "handled";
		}
		if (takeover.needsIdle && deps.busy) {
			await deps.reply(`当前有任务在跑，先发 /cancel 取消，再执行 /${builtin}。`);
			return "handled";
		}
		deps.log("[cmd] 派发 /qq 桥接命令:", shown, "gate=", builtin);
		if (takeover.selfDestroying) {
			await deps.reply(`已请求 /${builtin}（${takeover.hint}）…`);
		}
		deps.dispatch(parsed.raw);
		return "dispatched";
	}

	// 0. 输出只走 TUI 通道的扩展命令：桥接或明确回执（必须早于 passthrough）
	const uiOnly = UI_ONLY[name];
	if (uiOnly && deps.listPiCommands().some((c) => c.name.toLowerCase() === name)) {
		if (uiOnly.bridge) {
			const bridge = `/qq ${uiOnly.bridge}${parsed.args ? ` ${parsed.args}` : ""}`;
			deps.log("[cmd] 桥接 UI-only 命令:", parsed.raw.slice(0, 60), "->", bridge.slice(0, 60));
			deps.dispatch(bridge);
			return "dispatched";
		}
		await deps.reply(`/${name} ${uiOnly.hint}，QQ 侧无法执行。`);
		return "handled";
	}

	// 1. pi extension commands, prompt templates and skill commands
	if (deps.cfg.passthrough) {
		const known = deps.listPiCommands().find((c) => c.name.toLowerCase() === name);
		if (known) {
			// 提示模板与 /skill: 会开启一轮 agent run，交给队列串行；扩展命令自己管理 LLM 交互
			const runsTurn = known.source === "prompt" || known.source === "skill";
			deps.log("[cmd] 派发 pi 命令:", parsed.raw.slice(0, 80), "runsTurn=", runsTurn);
			const result = deps.dispatch(parsed.raw, { runsTurn });
			if (result === "queued") {
				await deps.reply(`已排队 /${name}：当前任务结束后执行（发 /queue 查看队列）。`);
			} else if (result === "rejected") {
				await deps.reply(`队列已满，/${name} 没有排上。发 /queue 查看队列，或 /cancel 清空后重发。`);
			} else {
				await deps.reply(`已派发 ${previewCommand(parsed.raw)} 给 pi。`);
			}
			return "dispatched";
		}
	}

	// 2. built-ins we can take over
	const takeover = TAKEOVER[name];
	if (takeover) {
		if (!allowed(deps.cfg, name)) {
			await deps.reply(`/${name} 在 QQ 侧被禁用（配置 commands.${gateConfigKey(name)}）。`);
			return "handled";
		}
		if (takeover.needsIdle && deps.busy) {
			await deps.reply(`当前有任务在跑，先发 /cancel 取消，再执行 /${name}。`);
			return "handled";
		}
		const bridge = `/qq ${takeover.sub}${parsed.args ? ` ${parsed.args}` : ""}`;
		deps.log("[cmd] 接管内置命令:", parsed.raw.slice(0, 80), "->", bridge.slice(0, 80));
		if (takeover.selfDestroying) {
			// the command tears the runtime down; answer before it lands
			await deps.reply(`已请求 /${name}（${takeover.hint}）…`);
			deps.dispatch(bridge);
			return "dispatched";
		}
		deps.dispatch(bridge);
		return "dispatched";
	}

	// 3. built-ins only the host TUI can run
	if (HOST_ONLY.has(name)) {
		await deps.reply(`/${name} 只能在主机上的 pi 里执行（扩展 API 没有对应能力）。`);
		return "handled";
	}

	// 4. not a command we know: ordinary text
	return "text";
}

const MAX_LIST = 12;

function formatTokens(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

// ---------------------------------------------------------------------------
// pickers (tree / fork / resume / model)
// ---------------------------------------------------------------------------

export type PickerKind = "tree" | "fork" | "resume" | "model";

export interface PickerItem {
	/** entry id (tree/fork) */
	id?: string;
	/** session file (resume) */
	path?: string;
	/** what the user sees next to the number */
	label: string;
}

export interface PickerState {
	kind: PickerKind;
	items: PickerItem[];
	/** only this QQ user may answer with a number */
	openid: string | null;
	createdAt: number;
}

/** Shared mutable state between the router (index.ts) and the bridge command. */
export interface BridgeStore {
	picker: PickerState | null;
	/** set by the router right before dispatching a `list` command */
	pickerOwner: string | null;
}

export const PICKER_TTL_MS = 10 * 60_000;
export const PICKER_MAX_ITEMS = 10;

const KIND_LABEL: Record<PickerKind, string> = {
	tree: "会话树节点",
	fork: "可分叉的用户消息",
	resume: "本项目的其他会话",
	model: "新接入服务的模型",
};

function previewText(content: unknown): string {
	const parts = Array.isArray(content) ? content : [];
	const text = parts
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 50 ? `${text.slice(0, 50)}…` : text || "(无文本)";
}

const stamp = (value: unknown): string => {
	const date = typeof value === "string" || typeof value === "number" ? new Date(value) : new Date();
	if (Number.isNaN(date.getTime())) return "?";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function branchItems(ctx: any): PickerItem[] {
	let branch: any[] = [];
	try {
		branch = ctx.sessionManager.getBranch() ?? [];
	} catch {
		branch = [];
	}
	return branch
		.filter((entry) => entry?.type === "message" && entry?.message?.role === "user")
		.slice(-PICKER_MAX_ITEMS)
		.map((entry) => ({
			id: entry.id,
			label: `${stamp(entry.timestamp)}  ${previewText(entry.message.content)}`,
		}));
}

function resumeItems(ctx: any): PickerItem[] {
	let dir: string | undefined;
	let current: string | undefined;
	try {
		dir = ctx.sessionManager.getSessionDir?.();
		current = ctx.sessionManager.getSessionFile?.();
	} catch {
		return [];
	}
	if (!dir) return [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	return names
		.map((name) => {
			const full = path.join(dir!, name);
			let mtime = 0;
			let size = 0;
			try {
				const stat = fs.statSync(full);
				mtime = stat.mtimeMs;
				size = stat.size;
			} catch {
				// unreadable: keep it out of the ranking
			}
			return { full, name, mtime, size };
		})
		.filter((row) => row.mtime > 0 && row.full !== current)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, PICKER_MAX_ITEMS)
		.map((row) => ({
			path: row.full,
			label: `${stamp(row.mtime)}  ${Math.max(1, Math.round(row.size / 1024))}KB  ${row.name.replace(/\.jsonl$/, "").slice(0, 44)}`,
		}));
}

function buildPickerItems(kind: PickerKind, ctx: any): PickerItem[] {
	if (kind === "resume") return resumeItems(ctx);
	return branchItems(ctx);
}

function formatPicker(picker: PickerState): string {
	const header = `选择${KIND_LABEL[picker.kind]}（${picker.items.length} 项）：`;
	const rows = picker.items.map((item, index) => `  ${index + 1}. ${item.label}`);
	return [
		header,
		...rows,
		`回复编号执行，或回复「取消」放弃（${Math.round(PICKER_TTL_MS / 60000)} 分钟内有效）。`,
	].join("\n");
}

/** Parse a bare "3" reply that answers the pending picker. */
export function parsePickIndex(text: string): number | null {
	const match = /^\s*(\d{1,3})\s*$/.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : null;
}

export function pickerExpired(picker: PickerState | null): boolean {
	return !picker || Date.now() - picker.createdAt > PICKER_TTL_MS;
}

/** pi-usage-report 写入 session 的 custom entry 类型（耦合点，约定值） */
const USAGE_ENTRY_TYPE = "usage-report";

/**
 * appendEntry 的写入比 `sendUserMessage` 的 resolve 晚（实测 promise 183ms 返回，
 * entry 在之后 ~100ms 才出现在 getEntries 里），所以必须轮询而不是只读一次。
 */
const USAGE_WAIT_TIMEOUT_MS = 2000;
const USAGE_POLL_INTERVAL_MS = 100;

/** pi-usage-report 的配置/汇率缓存（读回来确认：命令真的生效了，而不是口头应下） */
const USAGE_SETTINGS_FILE = "pi-usage-report.json";
const USAGE_RATE_FILE = "pi-usage-report-rate.json";

const USAGE_HELP = [
	"/usage（默认 today）",
	"/usage today | yesterday | week | lastweek | month | lastmonth | all",
	"/usage 7d | 12h | 2w | 3m | 10天        滚动窗口",
	"/usage 2026-09-01..2026-09-30       本地日期区间（含首尾）",
	"/usage 今天 | 昨天 | 本周 | 上周 | 本月 | 上月 | 全部",
	"/usage rate <值> | rate auto        固定 USD→本币汇率，或恢复自动（会真的写配置）",
].join("\n");

function readAgentJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(path.join(PI_AGENT_DIR, file), "utf8"));
	} catch {
		return undefined;
	}
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", JPY: "¥", GBP: "£", HKD: "HK$" };

/** 复刻 pi-usage-report 的 readSettings 优先级：fixed(usdRate) > 缓存的发布汇率 > 无 */
function usageMoney(): { code: string; symbol: string; rate: number | null; source: string } {
	const raw = readAgentJson(USAGE_SETTINGS_FILE) ?? {};
	const code = String(raw.currency ?? "CNY").toUpperCase();
	const symbol = typeof raw.symbol === "string" ? raw.symbol : (CURRENCY_SYMBOLS[code] ?? code);
	const pinned = typeof raw.usdRate === "number" && raw.usdRate > 0 ? raw.usdRate : undefined;
	const fixed = raw.rateMode === "auto" ? undefined : pinned;
	if (fixed !== undefined) return { code, symbol, rate: fixed, source: "fixed，/usage rate 手动固定" };
	const cache = readAgentJson(USAGE_RATE_FILE);
	if (cache && cache.code === code && typeof cache.rate === "number" && cache.rate > 0) {
		const ageMinutes = Math.max(0, Math.round((Date.now() - Number(cache.fetchedAt ?? 0)) / 60000));
		return { code, symbol, rate: cache.rate, source: `cache，${ageMinutes} 分钟前抓取` };
	}
	return { code, symbol, rate: null, source: "无，可用 /usage rate <值>" };
}

function moneyText(money: { code: string; rate: number | null; source: string }): string {
	return money.rate === null
		? `USD/${money.code}：无可用汇率（${money.source}）`
		: `USD/${money.code} = ${money.rate}（${money.source}）`;
}

function sessionEntries(ctx: any): any[] {
	try {
		return ctx?.sessionManager?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

function sessionFile(ctx: any): string | undefined {
	try {
		return ctx?.sessionManager?.getSessionFile?.() ?? undefined;
	} catch {
		return undefined;
	}
}

/** 兼容三种时间形态：毫秒数字（pi.appendEntry 实际写的就是它）/ ISO 字符串 / Date */
function entryTime(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "string" && value) return Date.parse(value);
	return NaN;
}

/**
 * 从会话文件尾部找最近一条 usage-report（generatedAt 不早于 since）。
 *
 * 为什么需要这条路：appendEntry 是**另一个扩展**写的，命令上下文里的
 * `sessionManager.getEntries()` 不一定即时反映（实测 `/usage today` 已经写入了
 * 会话文件，但 getEntries 看不到新增项）。数据库不会骗人，文件会。
 */
function readUsageEntryFromFile(file: string | undefined, since: number): any | undefined {
	if (!file) return undefined;
	try {
		const size = fs.statSync(file).size;
		const chunk = Math.min(size, 512 * 1024);
		if (chunk <= 0) return undefined;
		const fd = fs.openSync(file, "r");
		let text = "";
		try {
			const buf = Buffer.alloc(chunk);
			fs.readSync(fd, buf, 0, chunk, size - chunk);
			text = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line.startsWith("{")) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isUsageEntry(entry)) continue;
			const when = entryTime(entry?.data?.generatedAt ?? entry?.timestamp);
			return Number.isFinite(when) && when >= since ? entry : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

const intText = (value: unknown): string =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";

function localStamp(value: unknown): string {
	if (typeof value !== "string") return "?";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "?";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const isUsageEntry = (entry: any): boolean =>
	entry?.type === "custom" && entry?.customType === USAGE_ENTRY_TYPE;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 等本次 /usage 写的报告出现：每 100ms 查一次 getEntries（最多 2s），
 * 全程未命中再试一次会话文件（custom entry 可能很晚才落盘）。
 */
async function waitForUsageEntry(
	ctx: any,
	opts: { before: Set<unknown>; since: number; file?: string },
): Promise<any | undefined> {
	const deadline = Date.now() + USAGE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const fresh = [...sessionEntries(ctx)].reverse().find((entry: any) => isUsageEntry(entry) && !opts.before.has(entry?.id));
		if (fresh) return fresh;
		await sleep(USAGE_POLL_INTERVAL_MS);
	}
	return readUsageEntryFromFile(opts.file, opts.since);
}

/** 把 pi-usage-report 的 ReportData 渲染成 QQ 可读的纯文本 */
function formatUsage(data: any): string {
	if (!data?.totals) return "用量报告为空。";
	const t = data.totals;
	const money = data.money ?? {};
	const usd = Number(t.costUsd ?? 0);
	const rate = typeof money.rate === "number" ? money.rate : null;
	const symbol = money.symbol ?? "$";
	const costText = rate !== null ? `${symbol}${(usd * rate).toFixed(2)}（USD ${usd.toFixed(4)}，汇率 ${rate}）` : `USD ${usd.toFixed(4)}（无汇率）`;
	const totalTokens = Number(t.totalTokens ?? 0);
	const cachePct = totalTokens > 0 ? ((Number(t.cacheRead ?? 0) / totalTokens) * 100).toFixed(1) : "0.0";
	const lines = [
		`用量统计：${data.rangeLabel ?? "?"}   ${localStamp(data.from)} → ${localStamp(data.to)}`,
		`请求 ${intText(t.requests)} 次   合计 ${formatTokens(totalTokens)} tokens   费用 ${costText}`,
		`输入 ${intText(t.input)}   输出 ${intText(t.output)}   缓存读 ${intText(t.cacheRead)}（${cachePct}%）`,
		`缓存写 ${intText(t.cacheWrite)}   推理 ${intText(t.reasoning)}`,
	];
	const models: any[] = Array.isArray(data.byModel) ? data.byModel : [];
	if (models.length > 0) {
		lines.push("按模型：");
		for (const row of models.slice(0, 5)) {
			const bucket = row?.bucket ?? {};
			const rowUsd = Number(bucket.costUsd ?? 0);
			const rowCost = rate !== null ? `${symbol}${(rowUsd * rate).toFixed(2)}` : `USD ${rowUsd.toFixed(4)}`;
			lines.push(
				`  ${row?.model ?? "unknown"}  ${intText(bucket.requests)} 次  ${formatTokens(Number(bucket.totalTokens ?? 0))} tokens  ${rowCost}`,
			);
		}
	}
	const sessions: any[] = Array.isArray(data.bySession) ? data.bySession : [];
	if (sessions.length > 1) lines.push(`会话数：${sessions.length} 个`);
	if (t.unpriced) lines.push(`注：${intText(t.unpriced)} 次请求没有计价。`);
	return lines.join("\n");
}

/**
 * Body of the `/qq` bridge command: pi hands it a fresh `ExtensionCommandContext`,
 * which is the only place `reload()`, `newSession()`, `fork()`, `navigateTree()` and
 * `switchSession()` are legal.
 *
 * Session-replacing actions (`reload`, `new`, `tree`/`fork`/`resume` picks, `clone`)
 * tear this runtime down; the caller answers the QQ user before dispatching them.
 */
export async function runBridge(
	sub: string,
	arg: string,
	ctx: any,
	pi: any,
	reply: (text: string, keyboard?: InlineKeyboard) => void,
	store?: BridgeStore,
): Promise<void> {
	const level = String(sub ?? "").toLowerCase();
	const first = arg.split(/\s+/)[0]?.toLowerCase() ?? "";

	switch (level) {
		case "reload": {
			await ctx.reload();
			return;
		}
		case "update": {
			// 完整流程在 selfupdate.ts：检查 npm → pi update → 校验版本 → ctx.reload()
			const { runSelfUpdate, installedVersion, checkLatestVersion, applyUpdate } = await import("./selfupdate");
			await runSelfUpdate({
				currentVersion: installedVersion(),
				checkLatest: () => checkLatestVersion(),
				applyUpdate: () => applyUpdate(),
				versionAfterUpdate: () => installedVersion(),
				reply: (text) => Promise.resolve(reply(text)),
				reload: () => ctx.reload(),
			});
			return;
		}
		case "new": {
			await ctx.newSession();
			return;
		}
		case "quit": {
			reply("正在退出主机上的 pi…");
			ctx.shutdown();
			return;
		}
		case "compact": {
			reply(arg ? `开始压缩上下文（指令：${arg.slice(0, 80)}）…` : "开始压缩上下文…");
			ctx.compact({
				customInstructions: arg || undefined,
				onComplete: () => reply("上下文压缩完成。"),
				onError: (error: Error) => reply(`上下文压缩失败：${String(error?.message ?? error).slice(0, 200)}`),
			});
			return;
		}
		case "list": {
			const kind = first as PickerKind;
			if (kind !== "tree" && kind !== "fork" && kind !== "resume") {
				reply(`未知列表类型：${first || "(空)"}`);
				return;
			}
			const items = buildPickerItems(kind, ctx);
			if (items.length === 0) {
				reply(`没有可用的${KIND_LABEL[kind]}。`);
				return;
			}
			const picker: PickerState = { kind, items, openid: store?.pickerOwner ?? null, createdAt: Date.now() };

			reply(formatPicker(picker));
			return;
		}
		case "pick": {
			const index = Number.parseInt(first, 10);
			const picker = store?.picker ?? null;
			if (!picker || !Number.isFinite(index)) {
				reply("选择列表已失效，请重新发送命令。");
				return;
			}
			const item = picker.items[index - 1];
			if (!item) {
				reply(`编号 ${first} 超出范围（1-${picker.items.length}）。`);
				return;
			}
			if (store) store.picker = null;
			// 欠费接手：清单是「provider/model」，选了就切过去
			if (picker.kind === "model") {
				const [provider, ...rest] = String(item.id ?? "").split("/");
				const modelId = rest.join("/");
				const found = provider && modelId ? ctx.modelRegistry?.find?.(provider, modelId) : undefined;
				if (!found) {
					reply(`模型 ${item.id ?? "?"} 已不在目录里（models.json 可能改过），发 /model 重新看看。`);
					return;
				}
				const ok = await pi.setModel(found);
				reply(
					ok
						? `已切换到 ${provider}/${modelId}，直接发问题就行。`
						: `切换到 ${provider}/${modelId} 失败（这个服务没有凭据？）`,
				);
				return;
			}
			if (picker.kind === "tree") {
				reply(`正在跳转到第 ${index} 个节点…`);
				await ctx.navigateTree(item.id);
				return;
			}
			if (picker.kind === "fork") {
				reply(`正在从第 ${index} 条消息分叉…`);
				await ctx.fork(item.id);
				return;
			}
			reply(`正在切换会话：${item.label.slice(0, 44)}…`);
			await ctx.switchSession(item.path);
			return;
		}
		case "clone": {
			let leaf: string | null = null;
			try {
				leaf = ctx.sessionManager.getLeafId?.() ?? null;
			} catch {
				leaf = null;
			}
			if (!leaf) {
				reply("当前会话还没有可复制的位置（先发一条消息）。");
				return;
			}
			reply("正在当前叶子位置复制会话…");
			await ctx.fork(leaf, { position: "at" });
			return;
		}
		case "usage": {
			// /qq usage [...]：重跑原 /usage 命令，再从 session 里读回它写的 custom entry
			const rest = arg.slice(first.length).trim();

			// help：不执行命令（它在 TUI 打文本），直接回本地帮助
			if (first === "help" || first === "?") {
				reply(USAGE_HELP);
				return;
			}

			const commands = (pi?.getCommands?.() ?? []) as { name: string }[];
			const hasUsage = commands.some((c) => ["usage", "cost"].includes(String(c.name).toLowerCase()));
			if (!hasUsage) {
				reply("主机上没有 /usage 命令（需要安装 pi-usage-report），无法统计。");
				return;
			}

			// rate：会写配置/联网刷新汇率，必须真的执行，再读回状态确认（不能只回一句“TUI 可见”）
			if (first === "rate") {
				if (!rest) {
					reply(moneyText(usageMoney()));
					return;
				}
				const rateCommand = `/usage rate ${rest}`;
				try {
					await pi.sendUserMessage(rateCommand, { expandPromptTemplates: true });
				} catch (error) {
					reply(`执行 ${rateCommand} 失败：${String((error as any)?.message ?? error).slice(0, 200)}`);
					return;
				}
				const after = usageMoney();
				reply(
					`已执行 ${rateCommand}\n${moneyText(after)}\n（下一步 /usage today 的 ¥/USD 换算就用它；无效值会被忽略）`,
				);
				return;
			}

			const command = `/usage${arg ? ` ${arg}` : ""}`;
			const since = Date.now();
			const before = new Set(sessionEntries(ctx).map((entry: any) => entry?.id));
			const file = sessionFile(ctx);
			reply(`正在统计用量（${command}）…`);
			try {
				await pi.sendUserMessage(command, { expandPromptTemplates: true });
			} catch (error) {
				reply(`统计失败：${String((error as any)?.message ?? error).slice(0, 200)}`);
				return;
			}
			// 先轮询 getEntries 的增量（appendEntry 晚于 await 返回），超时再退回读会话文件
			const entry = await waitForUsageEntry(ctx, { before, since, file });
			if (!entry) {
				reply("没拿到用量报告：/usage 已执行但找不到报告数据（可重试一次；若反复出现请把 pi-qqbot.log 尾部发我）。");
				return;
			}
			reply(formatUsage(entry.data));
			return;
		}
		case "session": {
			const sm = ctx.sessionManager;
			const usage = ctx.getContextUsage?.();
			const model = ctx.model;
			const entries = (() => {
				try {
					return sm.getEntries().length;
				} catch {
					return "?";
				}
			})();
			reply(
				[
					`会话：${sm.getSessionName?.() || "(未命名)"}`,
					`id：${sm.getSessionId?.() ?? "?"}`,
					`cwd：${sm.getCwd?.() ?? ctx.cwd ?? "?"}`,
					`模型：${model ? `${model.provider}/${model.id}` : "(未设置)"}  思考：${ctx.thinkingLevel ?? "?"}`,
					`条目：${entries}   上下文：${
						usage && usage.tokens !== undefined
							? `${formatTokens(usage.tokens)}${usage.percent !== undefined ? ` (${Math.round(usage.percent)}%)` : ""}`
							: "未知"
					}`,
				].join("\n"),
			);
			return;
		}
		case "name": {
			if (!arg) {
				reply(`当前会话名：${ctx.sessionManager.getSessionName?.() || "(未命名)"}`);
				return;
			}
			pi.setSessionName(arg);
			reply(`会话名已设为：${arg}`);
			return;
		}
		case "model": {
			const registry = ctx.modelRegistry;
			const available = registry?.getAvailable?.() ?? [];
			const current = ctx.model;
			if (!arg) {
				const names = available.slice(0, MAX_LIST).map((m: any) => `${m.provider}/${m.id}`);
				reply(
					[
						`当前模型：${current ? `${current.provider}/${current.id}` : "(未设置)"}`,
						available.length > 0
							? `可选（${available.length}）：${names.join(", ")}${available.length > MAX_LIST ? " …" : ""}`
							: "没有可用模型",
					].join("\n"),
				);
				return;
			}
			const wanted = arg.toLowerCase();
			const found = available.find((m: any) => `${m.provider}/${m.id}`.toLowerCase() === wanted)
				?? available.find((m: any) => String(m.id).toLowerCase() === wanted);
			if (!found) {
				reply(`找不到模型 ${arg}。发 /model 查看可用列表。`);
				return;
			}
			const ok = await pi.setModel(found);
			reply(ok ? `模型已切换为 ${found.provider}/${found.id}` : `切换到 ${found.provider}/${found.id} 失败（缺少凭据？）`);
			return;
		}
		case "thinking": {
			if (!arg) {
				reply(`当前思考等级：${pi.getThinkingLevel()}`);
				return;
			}
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			const wanted = arg.toLowerCase();
			if (!levels.includes(wanted)) {
				reply(`思考等级只能是：${levels.join(" / ")}`);
				return;
			}
			pi.setThinkingLevel(wanted);
			reply(`思考等级已设为 ${wanted}`);
			return;
		}
		default: {
			reply(`未知的桥接命令：/qq ${arg ? `${level} ${arg}` : level}`);
		}
	}
}
