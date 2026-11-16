import WebSocket from "ws";
import { GATEWAY_PATH } from "../constants";
import { log } from "../logger";
import { groupTarget } from "./target";

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface QQAttachment {
  /** 签名下载地址（带 rkey，有效期很短，收到就要下） */
  url: string;
  /** content_type：image/*、audio/*、video/*、file…；缺省时按扩展名推断 */
  contentType: string;
  filename?: string;
  size?: number;
}

export interface QQMessage {
  /** Conversation target: a user openid, or group:<group_openid>. */
  openid: string;
  senderOpenid?: string;
  /** Internal receipt metadata retained while waiting for the shared executor. */
  receivedAt?: number;
  isolationLogged?: boolean;
  groupOpenid?: string;
  content: string;
  msgId: string;
  timestamp: number;
  attachments: QQAttachment[];
  quotedText?: string;
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
        // interaction 有 5 秒 ACK 要求：平台重投时也必须再回应，不能按消息去重
        if (t !== "INTERACTION_CREATE" && this.isDuplicate(pkt.id ?? String(d.msg_id ?? d.id ?? ""))) return;
        this.handleDispatch(t, d);
        break;
      }
    }
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
      log("[gateway] ✅ READY，bot 已上线 session=", this.sessionId);
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
    if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE") {
      const group = t === "GROUP_AT_MESSAGE_CREATE";
      const groupOpenid = group ? String(d.group_openid ?? "") : undefined;
      const senderOpenid = String(group
        ? d.author?.member_openid ?? d.author?.id ?? ""
        : d.author?.user_openid ?? d.author?.id ?? d.openid ?? "");
      if (!senderOpenid || (group && !groupOpenid)) {
        log("[gateway] 忽略缺少目标/发送者的消息:", t);
        return;
      }
      const target = group ? groupTarget(groupOpenid!) : senderOpenid;
      const content = group ? String(d.content ?? "").trimStart() : String(d.content ?? "");
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
      log(
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
      this.opts.message({
        openid: target,
        senderOpenid,
        groupOpenid,
        content,
        msgId: String(d.id ?? d.msg_id ?? ""),
        timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
        attachments,
        quotedText: undefined,
      });
    }
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
