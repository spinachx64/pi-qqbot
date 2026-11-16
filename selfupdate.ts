/**
 * spinachx64 分支通过 Git 维护；检查和执行 npm 自更新时会返回维护说明。
 * 下方保留上游的更新编排接口，供测试与后续显式迁移使用。
 *
 * pi-qqbot「自我更新」：QQ 用户发「更新自己」/ `/update`，插件检查 npm 上的最新版，
 * 用 **pi 自己的机制**（`pi update npm:@zxh126/pi-qqbot`）更新磁盘上的安装目录，
 * 校验版本真的变了的之后，再走 `/qq reload` 重载扩展——不重启宿主进程。
 *
 * 为什么是确定性代码而不是丢给模型做：更新流程必须在「模型不可用」时也能跑，
 * 且涉及写安装目录，不能交给模型自由发挥。
 *
 * 纯逻辑（版本比较、输出解析、流程编排）都走注入，单测不联网、不真跑 pi update。
 */
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@spinachx64/pi-qqbot";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_CHECK_TIMEOUT_MS = 30_000;
export const UPDATE_TIMEOUT_MS = 300_000;

/** 包根目录（index.ts / selfupdate.ts 都在包根，package.json 是兄弟文件） */
export function packageRoot(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/** 当前安装的版本；读不到返回 null */
export function installedVersion(dir: string = packageRoot()): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

/** This maintained fork is updated through Git, never the upstream npm package. */
function gitManagedUpdateNotice(): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
		if (pkg.name === "@spinachx64/pi-qqbot") {
			return "当前为 spinachx64 自定义分支，请通过 https://github.com/spinachx64/pi-qqbot 更新（git pull --ff-only 后重启 Pi），不执行 npm 自动更新。";
		}
		return null;
	} catch {
		return "无法确认本地插件来源，已取消自动更新。请检查 Git 仓库与 package.json。";
	}
}

/** npm 输出里可能混着 warning，取第一个 semver */
export function parseVersionOutput(text: string): string | null {
	const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text ?? ""));
	return match ? match[1] : null;
}

/** a 更新返回正数；相等返回 0；兼容 prerelease（1.0.0-beta < 1.0.0） */
export function compareVersions(a: string, b: string): number {
	const parse = (version: string) => {
		const [core, pre] = String(version).split("-");
		return {
			nums: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
			pre: pre ?? null,
		};
	};
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index += 1) {
		const diff = (left.nums[index] ?? 0) - (right.nums[index] ?? 0);
		if (diff !== 0) return diff;
	}
	if (left.pre === null && right.pre === null) return 0;
	if (left.pre === null) return 1;
	if (right.pre === null) return -1;
	return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 命令执行（可注入；默认真跑）
// ---------------------------------------------------------------------------

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, timeoutMs: number) => Promise<CommandResult>;

/**
 * 默认执行器：child_process.exec（shell）。命令串全部来自本文件的常量，
 * 没有用户输入参与拼接，无注入面。Windows 上 pi/npm 都是 .cmd shim，必须走 shell。
 */
export const shellRunner: CommandRunner = (command, timeoutMs) =>
	new Promise((resolve) => {
		exec(
			command,
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code)
						: error
							? 1
							: 0;
				resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
	});

export interface VersionCheckResult {
	ok: boolean;
	version?: string;
	error?: string;
}

/** `npm view <pkg> version`：拿 registry 上的最新版本 */
export async function checkLatestVersion(
	runner: CommandRunner = shellRunner,
	registry: string = NPM_REGISTRY,
): Promise<VersionCheckResult> {
	const notice = gitManagedUpdateNotice();
	if (notice) return { ok: false, error: notice };
	try {
		const result = await runner(`npm view ${PACKAGE_NAME} version --registry=${registry}`, NPM_CHECK_TIMEOUT_MS);
		const version = parseVersionOutput(result.stdout);
		if (result.code !== 0 || !version) {
			return { ok: false, error: `npm view 失败（exit ${result.code}）${result.stderr ? `：${result.stderr.trim().slice(0, 160)}` : ""}` };
		}
		return { ok: true, version };
	} catch (error) {
		return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 160) };
	}
}

export interface UpdateResult {
	ok: boolean;
	code?: number;
	output?: string;
	error?: string;
}

/** `pi update npm:<pkg>`：pi 官方的扩展更新命令（就是用户手动发版验收用的那条） */
export async function applyUpdate(runner: CommandRunner = shellRunner): Promise<UpdateResult> {
	const notice = gitManagedUpdateNotice();
	if (notice) return { ok: false, error: notice };
	try {
		const result = await runner(`pi update npm:${PACKAGE_NAME}`, UPDATE_TIMEOUT_MS);
		if (result.code !== 0) {
			const detail = `${result.stderr || result.stdout}`.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300);
			return { ok: false, code: result.code, output: detail, error: `pi update 失败（exit ${result.code}）` };
		}
		if (/已是最新|already (?:at the )?(?:latest|up.to.date)|Skipping/i.test(result.stdout) && !/Updated|updated/i.test(result.stdout)) {
			return { ok: false, error: "pi update 认为已是最新（磁盘版本号可能和 registry 不一致），未做变更" };
		}
		return { ok: true, output: result.stdout.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300) };
	} catch (error) {
		return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 160) };
	}
}

// ---------------------------------------------------------------------------
// 流程编排（依赖注入：QQ 回执 / 更新器 / 重载都从外面给）
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
	/** 当前安装版本（通常 = installedVersion()） */
	currentVersion: string | null;
	/** 查 registry 最新版 */
	checkLatest(): Promise<VersionCheckResult>;
	/** 执行 pi update */
	applyUpdate(): Promise<UpdateResult>;
	/** 更新后磁盘上的版本（通常 = installedVersion()） */
	versionAfterUpdate(): string | null;
	/** 给 QQ 用户回话 */
	reply(text: string): Promise<unknown>;
	/** 重载扩展（对应 /qq reload） */
	reload(): Promise<void> | void;
}

export type SelfUpdateOutcome =
	| "already-latest"
	| "updated"
	| "check-failed"
	| "update-failed"
	| "version-mismatch";

export async function runSelfUpdate(deps: SelfUpdateDeps): Promise<SelfUpdateOutcome> {
	await deps.reply("正在检查 pi-qqbot 更新…");
	const latest = await deps.checkLatest();
	if (!latest.ok || !latest.version) {
		await deps.reply(`❌ 查询最新版本失败：${latest.error ?? "未知错误"}`);
		return "check-failed";
	}
	const current = deps.currentVersion ?? "0.0.0";
	if (compareVersions(latest.version, current) <= 0) {
		await deps.reply(`✅ 已是最新版本 v${current}，无需更新。`);
		return "already-latest";
	}
	await deps.reply(`发现新版本 v${current} → v${latest.version}，开始更新（pi update，最多等 5 分钟）…`);
	const updated = await deps.applyUpdate();
	if (!updated.ok) {
		await deps.reply(`❌ 更新失败：${updated.error ?? "未知错误"}${updated.output ? `\n${updated.output}` : ""}`);
		return "update-failed";
	}
	const after = deps.versionAfterUpdate();
	if (after !== latest.version) {
		await deps.reply(
			`⚠️ 更新命令执行完，但磁盘版本是 v${after ?? "?"}（预期 v${latest.version}）。先不重载，请人工确认安装目录。`,
		);
		return "version-mismatch";
	}
	await deps.reply(`✅ 已更新到 v${latest.version}，正在重载扩展（会话保留，模型上下文不受影响）…`);
	await deps.reload();
	return "updated";
}

// ---------------------------------------------------------------------------
// 自然语言意图
// ---------------------------------------------------------------------------

/** 「更新自己」「升级一下插件」这类口令；单说「更新」不认（太容易撞车） */
const RE_UPDATE_SELF = /^(?:帮我)?(?:更新|升级|自更|自我更)(?:新)?(?:一下)?(?:自己|本身|qqbot|pi-?qqbot|插件|扩展)?$/i;

export function isUpdateSelfIntent(text: string): boolean {
	const value = String(text ?? "").trim();
	if (!RE_UPDATE_SELF.test(value)) return false;
	// 「更新」「升级」单字不带宾语时不认，太容易撞车；但「自更新」「自我更新」本身带了宾语
	if (/^(?:帮我)?(?:更新|升级)(?:一下)?$/.test(value)) return false;
	return true;
}
