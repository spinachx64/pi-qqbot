import { redactSecrets } from "./redact";
import type { QQMessage } from "./qq/gateway";

/**
 * QQ 侧任务队列。
 *
 * pi 的单会话是串行执行的：一轮 agent run 结束（agent_settled）后才可能开始下一轮。
 * 于是忙碌期间收到的消息不再丢弃/拒绝，而是排队；当前任务结束后由 index.ts 的
 * `drainQueue()` 逐条取出执行。
 *
 * 设计要点：
 * - 全局单队列（本扩展是单会话设计），每条任务记住自己的 openid，回复发给原主人。
 * - FIFO，编号单调递增不复用，方便用户用 `/queue drop <编号>` 定点删除。
 * - `/cancel` 不走队列（立即生效），并且会清空队列。
 */

export interface QueuedJob {
	/** Raw incoming message, processed after switching to its isolated session. */
	rawMessage?: QQMessage;
	/** 队列编号，从 1 开始单调递增 */
	id: number;
	/** 任务来自哪个 QQ 用户 */
	openid: string;
	/** 交给 pi 的原始文本（普通对话 / 斜杠命令 / 提示模板 / skill 命令） */
	text: string;
	/** 入队时间戳（毫秒） */
	enqueuedAt: number;
	/** 派发失败的重试次数，由 index.ts 维护 */
	attempts: number;
}

export type PushResult =
	| { ok: true; job: QueuedJob; ahead: number }
	| { ok: false; reason: "full" };

export const DEFAULT_QUEUE_MAX = 20;
/** 单条预览的最大字符数 */
const PREVIEW_MAX = 48;

export function previewText(text: string, max = PREVIEW_MAX): string {
	// 预览会回显到 QQ 和日志：先脱敏
	const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat || "(空消息)";
}

/** 距离入队多久：`12s 前` / `3m 前` / `1h 前` */
export function agoLabel(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds}s 前`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m 前`;
	return `${Math.floor(minutes / 60)}h 前`;
}

export class MessageQueue {
	private jobs: QueuedJob[] = [];
	private nextId = 1;
	private limit: number;

	/** `limit = 0` 表示关闭排队（忙碌时直接拒绝新消息） */
	constructor(limit = DEFAULT_QUEUE_MAX) {
		this.limit = Math.max(0, Math.floor(limit) || 0);
	}

	/** 按配置调整上限；已有的任务不会被丢弃 */
	setLimit(limit: number) {
		this.limit = Math.max(0, Math.floor(limit) || 0);
	}

	get size(): number {
		return this.jobs.length;
	}

	get max(): number {
		return this.limit;
	}

	/** 只读快照（保持插入顺序） */
	list(): readonly QueuedJob[] {
		return this.jobs;
	}

	push(openid: string, text: string): PushResult {
		if (this.limit === 0 || this.jobs.length >= this.limit) return { ok: false, reason: "full" };
		const job: QueuedJob = {
			id: this.nextId++,
			openid,
			text,
			enqueuedAt: Date.now(),
			attempts: 0,
		};
		this.jobs.push(job);
		return { ok: true, job, ahead: this.jobs.length - 1 };
	}

	/** 手动构造一条不入队的任务（直接执行 / 失败重试时用） */
	mint(openid: string, text: string): QueuedJob {
		return { id: 0, openid, text, enqueuedAt: Date.now(), attempts: 0 };
	}

	shift(): QueuedJob | undefined {
		return this.jobs.shift();
	}

	/** 派发失败时放回队首重试 */
	unshift(job: QueuedJob): void {
		this.jobs.unshift(job);
	}

	/** 按编号删除一条 */
	remove(id: number): QueuedJob | undefined {
		const index = this.jobs.findIndex((job) => job.id === id);
		if (index === -1) return undefined;
		return this.jobs.splice(index, 1)[0];
	}

	/** 清空并返回被清掉的任务 */
	clear(): QueuedJob[] {
		const dropped = this.jobs;
		this.jobs = [];
		return dropped;
	}
}
