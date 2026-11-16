/**
 * 欠费/鉴权失败的识别，以及「远程换 key / 换 endpoint」的凭据接手逻辑。
 *
 * 为什么需要：provider 返回非 2xx 时 pi 不产生任何 text_delta，只在 assistant 消息上留下
 * `stopReason=error` + `errorMessage`。QQ 用户看到的是「没反应」，而真正要做的动作
 * （充值、换 key、换个服务商）全都发生在远端，因此桥接必须：
 *   1. 把「哪家、哪个模型、服务端原话」用中文讲清楚；
 *   2. 允许用户直接发一个新 key，或发 endpoint + key，由桥接写进 pi 的 auth.json /
 *      models.json，并**真的探测一次**，再把可选模型列表发给用户挑。
 *
 * 约定：
 *   - 明文 key 只在内存里出现，日志/回执一律走 `maskSecret()`；
 *   - 落盘只碰 pi 自己的 `auth.json` / `models.json`，用 pi 同款 proper-lockfile 锁；
 *   - 纯逻辑（分类、解析、文案、探测、id 生成）都导出，单测可直接跑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

// ---------------------------------------------------------------------------
// 1. 错误分类与文案
// ---------------------------------------------------------------------------

export type ProviderErrorKind = "billing" | "auth" | "permission" | "rate" | "other";

const BILLING_PATTERNS: readonly RegExp[] = [
	/insufficient[_\s-]?(?:balance|quota|credit|funds)/i,
	/exceeded your current quota/i,
	/payment[_\s-]?required/i,
	/\bbilling\b/i,
	/余额|额度|欠费|充值|欠款/,
];

const AUTH_PATTERNS: readonly RegExp[] = [
	/invalid[_\s-]?api[_\s-]?key/i,
	/authentication[_\s-]?fail/i,
	/\bunauthorized\b/i,
	/\bapi key\b[^\n]{0,60}\binvalid\b/i,
	/\b401\b/,
];

const RATE_PATTERNS: readonly RegExp[] = [/rate[_\s-]?limit/i, /\b429\b/, /too many requests/i];

/** 套餐没开 / 没有该模型权限（如 GLM 的 1311「当前订阅套餐暂未开放XXX权限」） */
const PERMISSION_PATTERNS: readonly RegExp[] = [
	/\b1311\b/,
	/权限/,
	/未开放|未开通/,
	/insufficient[_\s-]?permission/i,
	/permission[_\s-]?denied/i,
	/not[^\n]{0,30}(?:available|enabled)[^\n]{0,30}(?:plan|subscription|account|product)/i,
];

/** 把 `errorMessage` 归类；billing / permission 优先（402 里常同时带 invalid_request_error） */
export function classifyProviderError(text: string): ProviderErrorKind {
	const value = String(text ?? "");
	if (BILLING_PATTERNS.some((re) => re.test(value))) return "billing";
	if (PERMISSION_PATTERNS.some((re) => re.test(value))) return "permission";
	if (AUTH_PATTERNS.some((re) => re.test(value))) return "auth";
	if (RATE_PATTERNS.some((re) => re.test(value))) return "rate";
	return "other";
}

export function kindLabel(kind: ProviderErrorKind): string {
	switch (kind) {
		case "billing":
			return "余额/额度不足";
		case "auth":
			return "凭据无效或已失效";
		case "permission":
			return "套餐没开这个模型";
		case "rate":
			return "被限流";
		default:
			return "接口报错";
	}
}

export interface ErrorContext {
	kind: ProviderErrorKind;
	/** `provider/model`，未知时给 "(未知模型)" */
	model?: string | null;
	/** 已脱敏 + 压过空白 + 截断的服务端原文 */
	detail: string;
}

/** 与服务端不通用的简短回执（非欠费类也用它） */
export function errorNotice(ctx: ErrorContext): string {
	const model = ctx.model?.trim() || "(未知模型)";
	return [`❌ 模型接口报错（${kindLabel(ctx.kind)}）`, `当前模型：${model}`, `服务端原文：${ctx.detail}`].join("\n");
}

/** 欠费/鉴权类的回执：带「怎么恢复」的三条路，用户直接回消息即可 */
export function billingNotice(ctx: ErrorContext): string {
	const model = ctx.model?.trim() || "(未知模型)";
	const head =
		ctx.kind === "auth"
			? "❌ 当前模型的凭据不可用（key 失效、被禁用或填错）"
			: ctx.kind === "permission"
				? "❌ 当前模型对你的账号不可用（套餐没开或没有该模型权限）"
				: "❌ 当前模型的余额/额度不足，暂时无法继续对话";
	return [
		head,
		`当前模型：${model}`,
		`服务端原文：${ctx.detail}`,
		"",
		"恢复方式（直接回消息即可，key 我不会写进日志）—",
		"1. 有新 key：只发 key（任意前缀都行，比如 sk-… / ark-… / AIza…，带引号也认）→ 我更新当前模型所属服务的 key",
		"2. 换服务商：发「https://api.xxx.com/v1 <你的 key>」→ 我拉它的模型列表，再把编号发给你挑",
		"3. 先换现成模型：发 /model 看列表，或 /model provider/id 直接切",
	].join("\n");
}

/** 编号列表最多列几个（与 slash.ts 的 PICKER_MAX_ITEMS 对齐） */
export const MODEL_PICK_LIMIT = 10;

/** 新 endpoint 注册后的模型选择回执（配合 `/qq pick <n>`） */
export function formatModelPicker(
	providerId: string,
	baseUrl: string,
	models: readonly ResolvedModelConfig[],
	borrowed = 0,
): string {
	const shown = models.slice(0, MODEL_PICK_LIMIT);
	const lines = [
		`✅ 已接入新服务：${providerId}（${normalizeBaseUrl(baseUrl)}）`,
		`可选模型（${models.length} 个${models.length > shown.length ? `，先列前 ${shown.length} 个` : ""}）：`,
		...shown.map((model, index) => {
			const meta = { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
			return `  ${index + 1}. ${modelLabel(model.id, meta)}`;
		}),
	];
	if (borrowed > 0) {
		lines.push(`（其中 ${borrowed} 个模型的上下文/输出上限是从 pi 内置目录里同 id 模型补全的）`);
	} else {
		lines.push("（没找到同 id 的内置模型，上下文/输出上限用了保守默认值，需要精确值可以改 models.json）");
	}
	lines.push(`回复编号切换到该模型；回复「取消」放弃（10 分钟内有效）。`);
	lines.push(`需要的话也可以直接发 /model 看全部已配置模型。`);
	return lines.join("\n");
}

/** registerProvider / models.json 用的模型配置（未知服务商只能先给保守默认值） */
export interface ResolvedModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	inputLimits?: Record<string, unknown>;
}

export function providerModelConfig(id: string, meta?: ModelMeta | null): ResolvedModelConfig {
	const config: ResolvedModelConfig = {
		id,
		name: id,
		reasoning: meta?.reasoning ?? false,
		input: meta?.input ?? ["text"],
		cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: meta?.contextWindow ?? 128_000,
		maxTokens: meta?.maxTokens ?? 16_384,
	};
	if (meta?.thinkingLevelMap) config.thinkingLevelMap = meta.thinkingLevelMap;
	if (meta?.compat) config.compat = meta.compat;
	if (meta?.inputLimits) config.inputLimits = meta.inputLimits;
	return config;
}

/** 从现有模型目录里能借来的元数据 */
export interface ModelMeta {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	thinkingLevelMap?: Record<string, unknown>;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
	inputLimits?: Record<string, unknown>;
}

const hostOf = (url: unknown): string => {
	try {
		return new URL(String(url)).host.toLowerCase();
	} catch {
		return "";
	}
};

/**
 * 按模型 id 从 pi 已有目录（内置 catalog + 已配置 provider）里借元数据。
 *
 * 背景（来自另一个 pi 的实践）：服务的 `/models` 往往只给 id，不给上下文窗/输出上限；
 * 而 pi 内置目录里已经有同一模型（如 glm-5.3 在 `zai` / `zai-coding-cn` 下）的
 * contextWindow / maxTokens / input / thinkingLevelMap / compat，直接拿就行。
 * 优先选 host 相同的那个（同一厂商的另一端点），其次 `openai-completions`。
 */
export function borrowModelMeta(
	id: string,
	catalog: readonly any[],
	baseUrl?: string,
): ModelMeta | null {
	const targetHost = hostOf(normalizeBaseUrl(baseUrl ?? ""));
	const candidates = catalog.filter((model) => model && String(model.id) === id);
	if (candidates.length === 0) return null;
	// 同一 host 打过包的另一端点最可信；其次 OpenAI 兼容；最后随便挑一个
	const family = targetHost ? targetHost.split(".").slice(-2).join(".") : "";
	const ranked = [...candidates].sort((a, b) => {
		const score = (model: any) => {
			const host = hostOf(model.baseUrl);
			let value = 0;
			if (host && targetHost && host === targetHost) value += 4;
			else if (family && host.endsWith(family)) value += 3;
			if (model.api === "openai-completions") value += 1;
			return value;
		};
		return score(b) - score(a);
	});
	const best = ranked[0];
	const meta: ModelMeta = {};
	if (typeof best.contextWindow === "number") meta.contextWindow = best.contextWindow;
	if (typeof best.maxTokens === "number") meta.maxTokens = best.maxTokens;
	if (typeof best.reasoning === "boolean") meta.reasoning = best.reasoning;
	if (Array.isArray(best.input)) meta.input = best.input;
	if (best.thinkingLevelMap) meta.thinkingLevelMap = best.thinkingLevelMap;
	if (best.cost) meta.cost = best.cost;
	if (best.compat) meta.compat = best.compat;
	if (best.inputLimits) meta.inputLimits = best.inputLimits;
	return Object.keys(meta).length > 0 ? meta : null;
}

/** 过滤掉 `/models` 里跟对话无关的 id（embedding / rerank / 语音 / 生图等） */
const NON_CHAT_ID =
	/(embed|rerank|tts|whisper|moderation|cogview|dall-?e|stable-?diffusion|text-to-image|image-gen|asr|ocr-only)/i;

export function filterChatModelIds(ids: readonly string[]): string[] {
	return ids.filter((id) => typeof id === "string" && id.length > 0 && !NON_CHAT_ID.test(id));
}

/** 模型名字后面附上上下文大小，方便用户在 QQ 里一眼看出差别 */
export function modelLabel(id: string, meta?: ModelMeta | null): string {
	const ctx = meta?.contextWindow;
	if (typeof ctx !== "number" || ctx <= 0) return id;
	const human = ctx >= 1_000_000 ? `${Math.round(ctx / 100_000) / 10}M` : `${Math.round(ctx / 1000)}K`;
	return `${id}（${human} 上下文）`;
}

// ---------------------------------------------------------------------------
// 2. 用户消息解析（新 key / endpoint + key）
// ---------------------------------------------------------------------------

export type CredentialIntake = (
	| { kind: "key"; key: string }
	| { kind: "endpoint"; baseUrl: string; key: string; models: string[] }
) & {
	/** 用户写了显式前缀（`key …` / `endpoint …`）；否则是裸 key，只在欠费上下文里认 */
	explicit: boolean;
};

const PREFIX_ENDPOINT = /^(?:\/)?(?:endpoint|baseurl|base[_-]?url|url|接口|端点)\s*[:：]?\s+/i;
const PREFIX_KEY = /^(?:\/)?(?:key|apikey|api[_-]?key|密钥|新key)\s*[:：]?\s+/i;
const PREFIX_MODELS = /^(?:models?|模型|模型id)\s*[:：]?\s*/i;

/**
 * 去掉用户粘上来时可能带的包裹符号：`"…"` `'…'` `` `…` `` `“…”` `<…>` `【…】`。
 * 手机输入法很常见，不该因此认不出 key。
 */
export function stripWrapping(value: string): string {
	let text = String(value ?? "").trim();
	const pairs: [string, string][] = [
		['"', '"'],
		["'", "'"],
		["`", "`"],
		["“", "”"],
		["‘", "’"],
		["<", ">"],
		["【", "】"],
	];
	let changed = true;
	while (changed && text.length > 1) {
		changed = false;
		for (const [open, close] of pairs) {
			if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
				text = text.slice(open.length, text.length - close.length).trim();
				changed = true;
			}
		}
	}
	return text;
}

/**
 * 像不像一个 API key。
 *
 * **不假设任何前缀**：key 可能是 `sk-…`、`ark-…`、`AIza…`、纯十六进制、带 `+/=` 的 base64、
 * 甚至是 `ollama` 这种本地服务的占位字符串。判据只有三条：非空、可打印 ASCII、无空白。
 *
 * `bare` 模式用于「用户没写任何前缀，整条消息就是一串字符」的情形（欠费时直接贴 key）：
 * 这时额外收紧一点（长度 ≥ 12 且不能是纯小写单词），避免把 `configuration.ts`
 * 这类正常正文当成 key 吞掉；带前缀（`key …` / `endpoint … …`）时不做这些限制。
 */
export function looksLikeSecret(value: string, options: { bare?: boolean } = {}): boolean {
	const text = stripWrapping(value);
	if (text.length < 4 || text.length > 400) return false;
	if (/\s/.test(text)) return false;
	// 可打印 ASCII（不含引号以外的奇怪控制字符）；非 ASCII 的 key 不存在，而中文正文必须排除
	if (!/^[\x21-\x7e]+$/.test(text)) return false;
	if (looksLikeEndpoint(text)) return false;
	if (!options.bare) return true;
	if (text.length < 12) return false;
	if (/\//.test(text)) return false; // 裸串里的路径别当 key（`docs/setup` 这类）
	// 需要一点熵：有数字、有大写或分隔符；纯小写单词（config、readme）不算
	return /[0-9]/.test(text) || /[A-Z]/.test(text) || /[-_+=:~]/.test(text);
}

export function looksLikeEndpoint(value: string): boolean {
	return /^https?:\/\/[^\s/]+/i.test(String(value ?? "").trim());
}

/** `sk-abcd1234…` → 只留头尾，给回执与日志用 */
export function maskSecret(value: string): string {
	const text = String(value ?? "").trim();
	if (text.length <= 10) return text ? `${text.slice(0, 2)}***` : "";
	return `${text.slice(0, 5)}…${text.slice(-4)}`;
}

function parseModelIds(tokens: string[]): string[] {
	if (tokens.length === 0) return [];
	const joined = tokens.join(" ").replace(PREFIX_MODELS, "");
	return joined
		.split(/[,，、\s]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * 认三类写法（其余一律当普通对话，避免误吞用户正文）：
 *   `<任意一串字符>`                          → 更新当前 provider 的 key（不要求任何前缀）
 *   `key <任意一串字符>` / `key: …`           → 同上（显式前缀，欠费之外也认）
 *   `https://host/v1 <你的 key> [models a,b]`  → 注册新 provider 并拉模型列表
 *   `endpoint https://host/v1 <你的 key> ...`  → 同上（显式前缀）
 */
export function parseCredentialMessage(text: string): CredentialIntake | null {
	const raw = String(text ?? "").trim();
	if (!raw || raw.length > 2000) return null;

	const endpointForced = PREFIX_ENDPOINT.test(raw);
	const keyForced = !endpointForced && PREFIX_KEY.test(raw);
	const body = endpointForced ? raw.replace(PREFIX_ENDPOINT, "") : keyForced ? raw.replace(PREFIX_KEY, "") : raw;
	const tokens = body.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;

	if (looksLikeEndpoint(tokens[0])) {
		const baseUrl = tokens[0];
		const key = stripWrapping(tokens[1] ?? "");
		// 跟在 URL 后面的 key 已经算显式：不按裸串收紧（允许 `ollama` 这种占位 key）
		if (!looksLikeSecret(key)) return null;
		return { kind: "endpoint", baseUrl, key, models: parseModelIds(tokens.slice(2)), explicit: endpointForced };
	}

	const candidate = tokens.length === 1 ? stripWrapping(tokens[0]) : keyForced ? stripWrapping(body) : "";
	if (candidate && looksLikeSecret(candidate, { bare: !keyForced })) return { kind: "key", key: candidate, explicit: keyForced };
	return null;
}

// ---------------------------------------------------------------------------
// 3. endpoint 探测（顺手验证 key）
// ---------------------------------------------------------------------------

export interface ProbeResult {
	ok: boolean;
	/** 从 /models 里取到的模型 id（去重、排序） */
	ids: string[];
	/** 真正命中的地址 */
	url?: string;
	status?: number;
	error?: string;
}

/** 去掉尾斜杠与 `/chat/completions` 结尾，得到 provider 的 baseUrl */
export function normalizeBaseUrl(value: string): string {
	return String(value ?? "")
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/chat\/completions$/i, "")
		.replace(/\/completions$/i, "");
}

export function extractModelIds(body: unknown): string[] {
	const ids: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value) ids.push(value);
		else if (value && typeof value === "object" && typeof (value as any).id === "string") ids.push((value as any).id);
	};
	const root = body as any;
	const data = root?.data ?? root?.models ?? root;
	if (Array.isArray(data)) data.forEach(push);
	else if (data && typeof data === "object") Object.keys(data).forEach(push);
	return [...new Set(ids)].sort();
}

/**
 * `GET <base>/models`（base 不带版本号时再试一次 `/v1`）。
 * 401/403 视为「key 无效」立刻返回；其他失败继续试下一个候选地址。
 */
export async function probeEndpoint(
	baseUrl: string,
	key: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs = 15000,
): Promise<ProbeResult> {
	const base = normalizeBaseUrl(baseUrl);
	const bases = /\/v\d+$/i.test(base) ? [base] : [base, `${base}/v1`];
	let last: ProbeResult = { ok: false, ids: [], error: "没有可用地址" };
	for (const candidate of bases) {
		const url = `${candidate}/models`;
		try {
			const response = await fetchFn(url, {
				method: "GET",
				headers: { authorization: `Bearer ${key}`, accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status === 401 || response.status === 403) {
				return { ok: false, ids: [], url, status: response.status, error: `key 无效或无权访问（HTTP ${response.status}）` };
			}
			if (!response.ok) {
				last = { ok: false, ids: [], url, status: response.status, error: `HTTP ${response.status}` };
				continue;
			}
			const body = await response.json().catch(() => null);
			return { ok: true, ids: extractModelIds(body), url, status: response.status };
		} catch (error) {
			last = { ok: false, ids: [], url, error: String((error as any)?.message ?? error).slice(0, 160) };
		}
	}
	return last;
}

/** 由 endpoint 生成稳定的 provider id（`qq-<host>`，撞名时加序号） */
export function providerIdForEndpoint(baseUrl: string, taken: readonly string[] = []): string {
	let host = "endpoint";
	try {
		host = new URL(normalizeBaseUrl(baseUrl)).host || "endpoint";
	} catch {
		// 非法 URL：交给调用方提前拒绝，这里只保证 id 合法
	}
	const slug =
		host
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "endpoint";
	const base = `qq-${slug}`;
	if (!taken.includes(base)) return base;
	for (let index = 2; index < 100; index += 1) {
		const candidate = `${base}-${index}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// 4. 落盘：auth.json（换 key）/ models.json（新 endpoint）
// ---------------------------------------------------------------------------

export function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
	return path.join(os.homedir(), ".pi", "agent");
}

export const authFilePath = () => path.join(agentDir(), "auth.json");
export const modelsFilePath = () => path.join(agentDir(), "models.json");

function readJson(file: string): any {
	try {
		const text = fs.readFileSync(file, "utf8");
		if (!text.trim()) return {};
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return {};
	}
}

/** 原子写：同目录临时文件 + rename，避免 pi 读到半个文件 */
function writeJsonAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** 与 pi 同款锁（realpath:false），拿不到锁就退化成「原子写」，不让换 key 卡死 */
async function withLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{}\n", { encoding: "utf8", mode: 0o600 });
	}
	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(file, { realpath: false, retries: 3, stale: 15000 });
	} catch {
		release = null;
	}
	try {
		return await fn();
	} finally {
		await release?.().catch(() => {});
	}
}

export interface WriteResult {
	ok: boolean;
	path: string;
	error?: string;
}

/** 把 key 写进 auth.json 的 `{ "<provider>": { type: "api_key", key } }` */
export async function updateProviderKey(provider: string, key: string): Promise<WriteResult> {
	const file = authFilePath();
	try {
		await withLock(file, () => {
			const data = readJson(file);
			const previous = data[provider];
			data[provider] = { ...(previous && typeof previous === "object" ? previous : {}), type: "api_key", key };
			writeJsonAtomic(file, data);
		});
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, path: file, error: String((error as any)?.message ?? error).slice(0, 200) };
	}
}

export interface EndpointProviderInput {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api?: string;
	/** 完整的模型配置项（含从内置目录借来的 contextWindow / compat 等） */
	models: ResolvedModelConfig[];
	name?: string;
}

/** 在 models.json 里写入/覆盖一个 provider（models 全量替换，其它 provider 保持不动） */
export async function upsertEndpointProvider(input: EndpointProviderInput): Promise<WriteResult> {
	const file = modelsFilePath();
	try {
		await withLock(file, () => {
			const data = readJson(file);
			const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
			providers[input.providerId] = {
				name: input.name ?? `QQ 接入 (${input.providerId})`,
				baseUrl: normalizeBaseUrl(input.baseUrl),
				api: input.api ?? "openai-completions",
				apiKey: input.apiKey,
				models: input.models.map((model) => ({ ...model })),
			};
			writeJsonAtomic(file, {
				$schema: "https://pi.dev/schemas/models.schema.json",
				...data,
				providers,
			});
		});
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, path: file, error: String((error as any)?.message ?? error).slice(0, 200) };
	}
}

/** models.json 里已经存在的 provider id（用于生成不撞名的 id） */
export function existingProviderIds(): string[] {
	const data = readJson(modelsFilePath());
	const providers = data?.providers;
	return providers && typeof providers === "object" ? Object.keys(providers) : [];
}
