import { MAX_REPLIES_PER_MSG_ID } from "../constants";
import type { InlineKeyboard } from "./keyboard";
import { isGroupTarget, passiveWindowMs, targetPath } from "./target";
import { logConversation } from "../logger";

export interface QQApiOptions {
  restBase: string;
  getToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export interface SendOptions {
  msgId?: string;
  format?: "text" | "markdown";
  /** 内联键盘：仅随 markdown 消息发送（官方要求），text 格式或回退时自动丢弃 */
  keyboard?: InlineKeyboard;
}

export interface MediaSendOptions {
  msgId?: string;
}

export class QQApi {
  private queue: Promise<void> = Promise.resolve();
  private seqCounters = new Map<string, number>();
  private passiveRefs = new Map<string, { msgId: string; receivedAt: number }>();

  rememberMessage(target: string, msgId: string, receivedAt = Date.now()): void {
    if (!msgId) return;
    this.passiveRefs.set(target, { msgId, receivedAt });
    if (this.passiveRefs.size > 500) this.passiveRefs.delete(this.passiveRefs.keys().next().value!);
  }

  remainingReplies(target: string): number {
    const ref = this.passiveRefs.get(target);
    if (!ref || Date.now() - ref.receivedAt >= passiveWindowMs(target)) return 0;
    return Math.max(0, MAX_REPLIES_PER_MSG_ID - (this.seqCounters.get(ref.msgId) ?? 0));
  }

  private messageId(target: string, explicit?: string): string | undefined {
    if (explicit) return explicit;
    const ref = this.passiveRefs.get(target);
    return ref && Date.now() - ref.receivedAt < passiveWindowMs(target) ? ref.msgId : undefined;
  }

  constructor(private opts: QQApiOptions) {}

  sendC2C(openid: string, content: string, options: SendOptions = {}): Promise<void> {
    const task = this.queue.then(async () => {
      await this.doSend(openid, content, options);
      logConversation("out", openid, content);
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** 发富媒体（msg_type=7）：fileInfo 来自 `/v2/users/{openid}/files` 的上传结果 */
  sendC2CMedia(openid: string, fileInfo: string, options: MediaSendOptions = {}): Promise<void> {
    const task = this.queue.then(async () => {
      await this.doMedia(openid, fileInfo, options);
      logConversation("out", openid, "[富媒体消息]", { media: true });
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private nextSeq(msgId?: string): number | undefined {
    if (!msgId) return undefined;
    const used = this.seqCounters.get(msgId) ?? 0;
    if (used >= MAX_REPLIES_PER_MSG_ID) return undefined;
    const seq = used + 1;
    this.seqCounters.set(msgId, seq);
    if (this.seqCounters.size > 500) this.seqCounters.clear();
    return seq;
  }

  private async postWithRetry(openid: string, body: any): Promise<void> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const token = await this.opts.getToken();
      const res = await fetchFn(`${this.opts.restBase}${targetPath(openid)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`QQ send (${isGroupTarget(openid) ? "group" : "c2c"}) failed: HTTP ${res.status} ${await res.text()}`);
      return;
    }
  }

  private async doMedia(openid: string, fileInfo: string, options: MediaSendOptions): Promise<void> {
    let msgId = this.messageId(openid, options.msgId);
    if (isGroupTarget(openid) && !msgId) throw new Error("群聊被动回复窗口已过期，需在群里重新 @机器人");
    let seq: number | undefined;
    if (msgId) {
      seq = this.nextSeq(msgId);
      if (seq === undefined) {
        if (isGroupTarget(openid)) throw new Error("群聊被动回复次数已用尽，需在群里重新 @机器人");
        msgId = undefined; // Keep legacy C2C behavior.
      }
    }
    const body: any = { msg_type: 7, media: { file_info: fileInfo } };
    if (msgId && seq !== undefined) {
      body.msg_id = msgId;
      body.msg_seq = seq;
    }
    await this.postWithRetry(openid, body);
  }

  /** 回应按钮互动（INTERACTION_CREATE）：平台要求 5 秒内 ACK，否则客户端一直 loading */
  async acknowledgeInteraction(interactionId: string, code: number): Promise<void> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const token = await this.opts.getToken();
    const res = await fetchFn(`${this.opts.restBase}/interactions/${interactionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`acknowledgeInteraction failed: HTTP ${res.status} ${await res.text()}`);
  }

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const format = options.format ?? "text";
    let msgId = this.messageId(openid, options.msgId);
    if (isGroupTarget(openid) && !msgId) throw new Error("群聊被动回复窗口已过期，需在群里重新 @机器人");
    let seq: number | undefined;
    if (msgId) {
      seq = this.nextSeq(msgId);
      if (seq === undefined) {
        if (isGroupTarget(openid)) throw new Error("群聊被动回复次数已用尽，需在群里重新 @机器人");
        msgId = undefined; // Keep legacy C2C behavior.
      }
    }
    const makeBody = (fmt: "text" | "markdown") => {
      const body: any = fmt === "markdown" ? { msg_type: 2, markdown: { content } } : { msg_type: 0, content };
      if (msgId && seq !== undefined) {
        body.msg_id = msgId;
        body.msg_seq = seq;
      }
      // 键盘只随 markdown 发送；回退 text 时自然不带（fmt === "text" 不挂）
      if (fmt === "markdown" && options.keyboard) body.keyboard = options.keyboard;
      return body;
    };
    try {
      await this.postWithRetry(openid, makeBody(format));
    } catch (e) {
      if (format === "markdown") {
        await this.postWithRetry(openid, makeBody("text"));
        return;
      }
      throw e;
    }
  }
}
