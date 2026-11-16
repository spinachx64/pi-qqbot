import WebSocket from "ws";
import { GATEWAY_PATH } from "../constants";
import { log } from "../logger";
import { groupTarget } from "./target";
import { parseQuote, type ParsedQuote } from "./quote";

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Identity diagnostics are deliberately projected: no raw payloads or URLs. */
function identityFields(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: Record<string, string | boolean> = {};
  for (const key of ["id", "openid", "member_openid", "user_openid", "username"]) {
    if (typeof raw[key] === "string") result[key] = raw[key].slice(0, 256);
  }
  if (typeof raw.bot === "boolean") result.bot = raw.bot;
  return result;
}

function logGroupIdentity(eventType: string, eventId: unknown, d: any, duplicate: boolean): void {
  const field = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : undefined;
  const mentions = Array.isArray(d.mentions) ? d.mentions : [];
  const content = typeof d.content === "string" ? d.content : "";
  const atIds = new Set<string>();
  // Extract only ID-shaped tokens, never the surrounding text or signed URLs.
  const markers = /<@!?([A-Za-z0-9_-]{1,128})>|<qqbot-at-user\s+id=["']([A-Za-z0-9_-]{1,128})["']\s*\/?\s*>/g;
  for (const match of content.matchAll(markers)) {
    atIds.add(match[1] ?? match[2]);
    if (atIds.size >= 100) break;
  }
  log("[gateway] GROUP_IDENTITY", {
    eventType, eventId: field(eventId), messageId: field(d.id), msgId: field(d.msg_id),
    groupOpenid: field(d.group_openid), author: identityFields(d.author),
    mentionsPresent: Array.isArray(d.mentions), mentionCount: mentions.length,
    mentions: mentions.slice(0, 100).map((mention: any) => ({
      ...identityFields(mention),
      ...(mention?.user && typeof mention.user === "object" ? { user: identityFields(mention.user) } : {}),
    })),
    atIds: [...atIds], duplicate,
  });
}

export interface QQAttachment {
  /** 签名下载地址（带 rkey，有效期很短，收到就要下） */
  url: string;
  /** content_type：image/*、audio/*、video/*、file…；缺省时按扩展名推断 */
  contentType: string;
  filename?: string;
  size?: number;
}

/** ParsedQuote also carries quotedAttachments, separate from current attachments. */
export interface QQMessage extends ParsedQuote {
  /** Original full-event text, retained for archival before removing our @ tag. */
  rawContent?: string;
  eventType?: string;
  isAtBot?: boolean;
  senderIsBot?: boolean;
  /** Conversation target: a user openid, or group:<group_openid>. */
  openid: string;
  senderOpenid?: string;
  senderName?: string;
  memberRole?: string;
  /** Internal receipt metadata retained while waiting for the shared executor. */
  receivedAt?: number;
  isolationLogged?: boolean;
  groupOpenid?: string;
  content: string;
  msgId: string;
  timestamp: number;
  attachments: QQAttachment[];
}

/** 按钮点击回调（INTERACTION_CREATE）*/
 export interface QQInteractionEvent {
  id?: string;
  scene?: string;
  user_openid?: string;
  group_openid?: string;
  group_member_openid?: string;
  data?: { resolved?: { button_data?: string; button_id?: string } };
 }

 export interface QQGatewayOptions {
  getGatewayUrl: () => Promise<string>;
  getToken: () => Promise<string>;
  intents: number;
  connected: () => void;
  disconnected: () => void;
  message: (msg: QQMessage) => Promise<void> | void;
  /** Observe group traffic without passing passive messages to Pi. */
  groupMessage?: (msg: QQMessage) => Promise<void> | void;
  groupSelfOpenids?: Record<string, string>;
  interaction: (event: QQInteractionEvent) => void | Promise<void>;
  reconnectBaseMs?: number;
  maxSeen?: number;
}

export class QQGateway {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private resumeAttempted = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private selfId: string | undefined;

  constructor(private opts: QQGatewayOptions) {}

  private isDuplicate(key: string): boolean {
    if (!key) return false;
    if (this.seenIds.has(key)) return true;
    this.seenIds.add(key);
    this.seenOrder.push(key);
    const cap = this.opts.maxSeen ?? 1000;
    if (this.seenOrder.length > cap) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return false;
  }

  start() {
    this.stopped = false;
    this.connect().catch(() => this.scheduleReconnect());
  }

  stop() {
    this.stopped = true;
    this.cleanup();
  }

  private cleanup() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.resumeAttempted) {
      this.resumeAttempted = false;
      this.sessionId = null;
      this.lastSeq = null;
    }
    const base = this.opts.reconnectBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** this.reconnectAttempt, 60_000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async connect() {
    log("[gateway] 开始连接...");
    const url = await this.opts.getGatewayUrl();
    log("[gateway] 网关地址:", url);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => log("[gateway] WebSocket 已连接，等待 HELLO..."));
    ws.on("message", (raw: any) => {
      let pkt: any;
      try {
        pkt = JSON.parse(raw.toString());
      } catch (e) {
        log("[gateway] 丢弃非 JSON 网关帧:", String(e).slice(0, 120));
        return;
      }
      this.handlePacket(pkt);
    });
    ws.on("close", (code: number) => {
      log("[gateway] WebSocket 关闭 code=", code);
      this.opts.disconnected();
      this.scheduleReconnect();
    });
    ws.on("error", (e: any) => {
      log("[gateway] WebSocket 错误:", String(e?.message ?? e));
      ws.terminate();
    });
  }

  private handlePacket(pkt: any) {
    switch (pkt.op) {
      case OP_HELLO: {
        const interval = pkt.d.heartbeat_interval;
        this.startHeartbeat(interval);
        if (this.sessionId !== null && this.lastSeq !== null) {
          this.resumeAttempted = true;
          void this.sendResume().catch(() => this.ws?.terminate());
        } else {
          this.resumeAttempted = false;
          void this.sendIdentify().catch(() => this.ws?.terminate());
        }
        break;
      }
      case OP_HEARTBEAT_ACK:
        break;
      case OP_DISPATCH: {
        this.lastSeq = pkt.s ?? this.lastSeq;
        const d = pkt.d ?? {};
        const t = pkt.t ?? "";
        if (t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE") {
          this.handleGroupPacket(t, d, pkt.id);
          break;
        }
        // interaction 有 5 秒 ACK 要求：平台重投时也必须再回应，不能按消息去重
        const duplicate = t !== "INTERACTION_CREATE" && this.isDuplicate(pkt.id ?? String(d.msg_id ?? d.id ?? ""));
        if (duplicate) return;
        this.handleDispatch(t, d);
        break;
      }
    }
  }

  private handleGroupPacket(t: string, d: any, eventId: unknown): void {
    const group = typeof d.group_openid === "string" ? d.group_openid : "";
    const messageId = String(d.id ?? d.msg_id ?? "");
    const id = messageId || (typeof eventId === "string" ? eventId : "");
    const duplicate = id ? this.isDuplicate(`observed:${group}:${id}`) : false;
    logGroupIdentity(t, eventId, d, duplicate);
    const ownIds = new Set([this.selfId, this.opts.groupSelfOpenids?.[group]].filter((id): id is string => !!id));
    const rawContent = typeof d.content === "string" ? d.content : "";
    const hasOwnMention = Array.isArray(d.mentions)
      ? d.mentions.some((m: any) => [m?.member_openid, m?.openid, m?.id, m?.user?.id].some(id => ownIds.has(id)))
      : [...rawContent.matchAll(/<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user\s+id=["']([A-Za-z0-9_-]+)["']\s*\/?\s*>/g)]
        .some(match => ownIds.has(match[1] ?? match[2]));
    const senderId = d.author?.member_openid;
    const senderIsBot = d.author?.bot === true || ownIds.has(senderId);
    const isAtBot = t === "GROUP_AT_MESSAGE_CREATE" || hasOwnMention;
    // Remove only our verified @ markers so /queue, approvals, etc. retain the
    // same body semantics as GROUP_AT pushes. Other members' mentions survive.
    const content = rawContent.replace(/<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user\s+id=["']([A-Za-z0-9_-]+)["']\s*\/?\s*>/g,
      (marker, id, xmlId) => ownIds.has(id ?? xmlId) ? "" : marker);
    const msg = this.parseMessage(t, { ...d, content });
    if (!msg) return;
    Object.assign(msg, { rawContent, eventType: t, isAtBot, senderIsBot });
    const trigger = !senderIsBot && isAtBot && (!id || !this.isDuplicate(`triggered:${group}:${id}`));
    const deliver = () => {
      if (!trigger) return;
      try {
        Promise.resolve(this.opts.message(msg)).catch(() => log("[gateway] 群消息派发失败"));
      } catch { log("[gateway] 群消息派发失败"); }
    };
    if (!duplicate && this.opts.groupMessage) {
      // Archive first so a newly started run can query the current message too.
      try {
        Promise.resolve(this.opts.groupMessage(msg)).then(deliver, () => {
          log("[group-history] 归档失败；继续处理当前 @ 消息"); deliver();
        });
      } catch { log("[group-history] 归档失败；继续处理当前 @ 消息"); deliver(); }
    } else deliver();
  }

  private async sendIdentify() {
    const token = await this.opts.getToken();
    log("[gateway] 发送 identify...");
    this.ws?.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.opts.intents, shard: [0, 1] },
      }),
    );
  }

  private async sendResume() {
    const token = await this.opts.getToken();
    this.ws?.send(
      JSON.stringify({
        op: OP_RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      }),
    );
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
    }, intervalMs);
  }

  private handleDispatch(t: string, d: any) {
    if (t === "READY") {
      this.sessionId = String(d.session_id);
      this.resumeAttempted = false;
      this.reconnectAttempt = 0;
      this.selfId = typeof d.user?.id === "string" ? d.user.id : undefined;
      log("[gateway] ✅ READY，bot 已上线 session=", this.sessionId);
      log("[gateway] SELF_IDENTITY", { source: "READY.user", user: identityFields(d.user) });
      this.opts.connected();
      return;
    }
    if (t === "RESUMED") {
      this.resumeAttempted = false;
      this.reconnectAttempt = 0;
      log("[gateway] RESUMED 会话恢复");
      this.opts.connected();
      return;
    }
    if (t === "INTERACTION_CREATE") {
      this.opts.interaction(d as QQInteractionEvent);
      return;
    }
    if (t === "C2C_MESSAGE_CREATE") {
      const msg = this.parseMessage(t, d);
      if (msg) this.opts.message(msg);
    }
  }

  private parseMessage(t: string, d: any): QQMessage | undefined {
    const group = t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE";
    const groupOpenid = group ? String(d.group_openid ?? "") : undefined;
    const senderOpenid = String(group
      ? d.author?.member_openid ?? ""
      : d.author?.user_openid ?? d.author?.id ?? d.openid ?? "");
    if (!senderOpenid || (group && !groupOpenid)) {
      log("[gateway] 忽略缺少目标/发送者的消息:", t);
      return;
    }
    const target = group ? groupTarget(groupOpenid!) : senderOpenid;
    const content = String(d.content ?? "");
    const senderName = group
      ? (typeof d.author?.username === "string" && d.author.username.trim()) || `成员_${senderOpenid.slice(-8)}`
      : undefined;
    const memberRole = group && typeof d.author?.member_role === "string"
      ? d.author.member_role : undefined;
    const rawAttachments = Array.isArray(d.attachments) ? d.attachments : [];
    const attachments = rawAttachments
      .filter((a: any) => !!a && typeof a === "object")
      // 语音消息常常只给 voice_wav_url；其余附件用 url
      .map((a: any) => ({
        url: String(a.url ?? a.voice_wav_url ?? "").trim(),
        contentType: String(a.content_type ?? a.contentType ?? "").trim(),
        filename: a.filename ? String(a.filename) : undefined,
        size: Number.isFinite(Number(a.size)) ? Number(a.size) : undefined,
      }))
      .filter((a: any) => a.url);
    // 下载地址带 rkey（临时凭据），日志只留类别与来源主机
    if (!group || t === "GROUP_AT_MESSAGE_CREATE") log(
      group ? "[gateway] GROUP_AT 消息 target=" : "[gateway] C2C 消息 openid=",
      target,
      "sender=", senderOpenid,
      "content=",
      content.slice(0, 80),
      "attachments=",
      attachments.length,
      attachments.length > 0
        ? attachments
            .map((a: any) => {
              try {
                return new URL(a.url).host;
              } catch {
                return "?";
              }
            })
            .join(",")
        : "",
    );
    return {
      openid: target,
      senderOpenid,
      senderName,
      memberRole,
      groupOpenid,
      content,
      msgId: String(d.id ?? d.msg_id ?? ""),
      timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
      attachments,
      ...(group ? parseQuote(d) : {}),
    };
  }
}

export function createGatewayUrlFetcher(
  restBase: string,
  getToken: () => Promise<string>,
  fetchFn: typeof fetch = fetch,
): () => Promise<string> {
  return async () => {
    const token = await getToken();
    const res = await fetchFn(`${restBase}${GATEWAY_PATH}`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!res.ok) throw new Error(`get gateway failed: HTTP ${res.status}`);
    return (await res.json()).url;
  };
}
