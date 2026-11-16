import type { QQBotConfig } from "./config";

/**
 * 「以下对话来自远程用户」提醒。
 *
 * pi 在锁屏/无人值守的机器上替 QQ 侧的远程用户干活：对方看不见屏幕，也没法点弹窗。
 * 所以在每个会话第一次真正把 QQ 消息交给 pi 跑起来时，把一段说明写进系统提示的
 * `qq-remote-context` section（排在用户消息之前、QQ 侧不可见），让它从一开始就按
 * 「远程 + 可能锁屏」的前提工作（默认离屏渲染，而不是截桌面）。
 *
 * 注入时机由 index.ts 的 before_agent_start 控制：只有本扩展派发的 QQ 消息真的开跑
 * 才注入；仅载入扩展、或本机 TUI 直接对话都不会触发。上下文压缩后由 session_compact 复位。
 */

export interface RemoteConfig {
	/** 每会话第一条消息注入一次提醒 */
	notice: boolean;
	/** 每次来自 QQ 的 run 在系统提示里追加几条规则 */
	guidelines: boolean;
	/** 追加在默认提醒末尾的自定义补充（留空 = 只用默认文案） */
	extra: string;
}

export const DEFAULT_REMOTE: RemoteConfig = {
	notice: true,
	guidelines: true,
	extra: "",
};

/** 说明放在系统提示的哪个 section 里（排查会话文件时靠这个 tag 认出来） */
export const REMOTE_NOTICE_SECTION = "qq-remote-context";

/** 「远程前提作废」更正用的 section tag */
export const LOCAL_HANDOFF_SECTION = "qq-local-handoff";

/** 配置里的 `remote` 可能缺字段（老配置、测试里手搓的 cfg），这里补齐默认值 */
export function resolveRemoteConfig(cfg: Partial<Pick<QQBotConfig, "remote">> | null | undefined): RemoteConfig {
	const raw = cfg?.remote ?? {};
	return {
		notice: raw.notice ?? DEFAULT_REMOTE.notice,
		guidelines: raw.guidelines ?? DEFAULT_REMOTE.guidelines,
		extra: String(raw.extra ?? DEFAULT_REMOTE.extra).trim(),
	};
}

/** 首条消息前的说明：说清来源、锁屏风险、离屏渲染要求 */
export function buildRemoteNotice(remote: RemoteConfig): string {
	const lines = [
		"[pi-qqbot 远程上下文 · 说明，不必回复本条]",
		"",
		"接下来的对话来自「远程 QQ 用户（可能来自私聊或群聊）」，不是本机终端用户。前提：",
		"",
		"1. 对方看不到本机屏幕、也收不到弹窗；回复应简明扼要。",
		"2. 本机可能锁屏或无人值守。默认不要用桌面截屏、屏幕 OCR、UI 自动化、键鼠模拟、带界面的浏览器" +
			"（例如 mcp__screenshot、mcp__winui 这类工具）：锁屏下它们只会拍到锁屏画面或直接失败。",
		"3. 需要图/界面效果时，按项目类型自行选择离屏渲染方案（headless 浏览器渲 HTML、SVG、matplotlib/Pillow 等），" +
			"生成 PNG 后用 qq_send_file 发到 QQ。不要为了“确认”先截桌面。",
		"4. 只有确实需要判断是否锁屏时，才允许截一次桌面看有没有内容；其余一律以离屏渲染为准。",
		"5. 需要人工介入（登录、验证码、实体操作）时直接说明并给替代方案；" +
			"危险工具会先发到 QQ 等审批，对方可能不在电脑旁。",
	];
	if (remote.extra) lines.push("", remote.extra);
	return lines.join("\n");
}

/** 本机接管后的更正：只在「上一轮来自 QQ」的第一次本机对话注入（只生效一轮） */
export function buildLocalHandoffNotice(): string {
	return [
		"现在是本机用户在终端直接对话（同一会话内接管），之前「远程 QQ 用户」的前提作废：",
		"可以正常截屏 / 看屏幕，回复详略按本机需求来，不需要用 qq_send_file 交付。",
	].join("\n");
}

/** 系统提示里追加的规则（比首条提醒更短，每次 QQ run 都带上） */
export function buildRemoteGuidelines(): string[] {
	return [
		"对话来自远程 QQ 用户：对方看不到本机屏幕，回复应简明扼要。",
		"本机可能锁屏：默认禁用桌面截屏/屏幕 OCR/UI 自动化/键鼠模拟/带界面浏览器；要图就离屏渲染，再用 qq_send_file 发送。",
		"需要本机人工操作时直接说明，不要等待或反复重试。",
	];
}
