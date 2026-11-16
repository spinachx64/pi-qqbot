import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { State } from "./index";
import type { QQMessage, QQInteractionEvent } from "./qq/gateway";
import type { QueuedJob } from "./queue";
import { log, logConversation } from "./logger";

type Hooks = {
  handle: (pi: any, state: State, msg: QQMessage) => Promise<void>;
  start: (pi: any, state: State, job: QueuedJob) => void;
  control: (state: State, msg: QQMessage) => boolean;
  reply: (state: State, target: string, text: string) => Promise<unknown>;
  interaction: (pi: any, state: State, event: QQInteractionEvent) => boolean;
};

/** A single live Pi runtime, swapping separate JSONL histories only while idle. */
export class IsolationHub {
  readonly states = new Map<string, State>();
  activeTarget: string | null = null;
  nextTarget: string | null = null;
  activeState: State | null = null;
  pi: any;
  switching = false;
  processing = false;
  commandCount = 0;
  private transport: Partial<State> | null = null;
  private hooks!: Hooks;
  private sessions: Record<string, string> = Object.create(null);
  private indexFile: string | null = null;
  private defaultModel: any;
  private reserved: { token: string; target: string; job: QueuedJob } | null = null;
  private lastTarget: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ingress: Promise<unknown> = Promise.resolve();

  constructor(private createState: () => State, private cwd = process.cwd()) {}

  stateFor(target: string | null): State {
    const key = target ?? "@local";
    let state = this.states.get(key);
    if (!state) {
      state = this.createState();
      state.isolation = this;
      this.states.set(key, state);
    }
    if (this.transport) {
      Object.assign(state, this.transport);
      state.queue.setLimit(state.cfg?.queue.max ?? 5);
    }
    return state;
  }

  bind(pi: any, state: State, hooks: Hooks): void {
    this.pi = pi;
    this.activeState = state;
    this.hooks = hooks;
    if (this.nextTarget !== null) this.activeTarget = this.nextTarget;
  }

  captureTransport(state: State): void {
    // A new conversation inherits the working host model, not an unrelated
    // built-in provider selected from an empty session's default catalog.
    if (!this.defaultModel && state.registryCtx?.model) this.defaultModel = state.registryCtx.model;
    this.transport = Object.fromEntries([
      "cfg", "api", "account", "gateway", "groupHistory", "getToken", "restBase", "releaseLock", "candidates",
    ].map(key => [key, (state as any)[key]]));
    const scope = createHash("sha256").update(`${this.cwd}\0${state.account?.appId ?? ""}`).digest("hex").slice(0, 24);
    const indexFile = path.join(os.homedir(), ".pi", "agent", "qq-isolation", scope, "sessions.json");
    if (this.indexFile !== indexFile) {
      this.indexFile = indexFile;
      this.sessions = Object.create(null);
      if (fs.existsSync(indexFile)) {
        const data = JSON.parse(fs.readFileSync(indexFile, "utf8"));
        if (data.version !== 1 || typeof data.sessions !== "object" || !data.sessions) throw new Error("Invalid QQ isolation index");
        for (const [target, file] of Object.entries(data.sessions)) {
          if (typeof file === "string" && path.isAbsolute(file)) this.sessions[target] = file;
        }
      }
    }
    for (const other of this.states.values()) {
      Object.assign(other, this.transport);
      other.queue.setLimit(state.cfg?.queue.max ?? 5);
    }
    if (this.activeTarget && state.registryCtx) this.record(this.activeTarget, state.registryCtx.sessionManager.getSessionFile());
    this.schedule();
  }

  started(ctx: any): boolean {
    if (!this.transport) return false;
    const state = this.activeState!;
    Object.assign(state, this.transport);
    state.registryCtx = ctx;
    if (this.activeTarget) this.record(this.activeTarget, ctx.sessionManager.getSessionFile());
    return true;
  }

  private record(target: string, file?: string): void {
    if (!file || !this.indexFile) throw new Error("QQ isolated session has no persistent session file");
    this.sessions[target] = file;
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, cwd: this.cwd, sessions: this.sessions }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  /** Serialize ingress only, never wait here for a model run to finish. */
  receive(msg: QQMessage): Promise<void> {
    const pending = this.ingress.then(() => this.accept(msg));
    this.ingress = pending.catch(error => log("[isolation] 收消息失败:", String(error)));
    return pending;
  }

  private async accept(msg: QQMessage): Promise<void> {
    if (!this.transport) return;
    const state = this.stateFor(msg.openid);
    const cfg = state.cfg;
    if (!cfg || !state.api) return;
    if (cfg.allowlist.length && !cfg.allowlist.includes(msg.senderOpenid ?? msg.openid)) {
      log("[isolation] 被 allowlist 拦截 target=", msg.openid);
      return;
    }
    msg.receivedAt = Date.now();
    state.passiveRefs.set(msg.openid, { msgId: msg.msgId, receivedAt: msg.receivedAt });
    state.api.rememberMessage(msg.openid, msg.msgId, msg.receivedAt);
    logConversation("in", msg.openid, msg.content, {
      sender: msg.senderOpenid ?? msg.openid, messageId: msg.msgId,
      attachments: (msg.attachments ?? []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    });
    msg.isolationLogged = true;
    // Only these controls are safe against an inactive conversation's own state.
    if (this.hooks.control(state, msg)) {
      await this.hooks.handle(this.pi, state, msg);
      this.schedule();
      return;
    }
    const idle = !this.reserved && !this.switching && !this.processing && !this.commandCount && !this.activeState?.busy;
    const result = idle && state.queue.size === 0
      ? { ok: true as const, job: state.queue.mint(msg.openid, msg.content) }
      : state.queue.push(msg.openid, msg.content);
    if (!result.ok) {
      await this.hooks.reply(state, msg.openid, `本会话队列已满（上限 ${state.queue.max} 条），这条没有排上。`);
      return;
    }
    const job = result.job;
    job.rawMessage = msg;
    if (idle && state.queue.size === 0) state.queue.unshift(job);
    if (!idle) await this.hooks.reply(state, msg.openid, `已排入本会话队列 #${job.id}，轮到本会话时执行。发 /queue 查看，/cancel 只取消本会话。`);
    this.schedule();
  }

  interaction(event: QQInteractionEvent): boolean {
    const target = event.group_openid ? `group:${event.group_openid}` : event.user_openid ?? "";
    if (this.switching || !target || target !== this.activeTarget || !this.activeState) return false;
    return this.hooks.interaction(this.pi, this.activeState, event);
  }

  onInteraction(event: QQInteractionEvent): void {
    let matched = false;
    try { matched = this.interaction(event); }
    catch (error) { log("[interaction] 按钮处理异常:", String(error)); }
    if (event.id) void this.transport?.api?.acknowledgeInteraction(event.id, matched ? 0 : 3)
      .catch(error => log("[interaction] ACK 失败:", String(error)));
  }

  schedule(delay = 0): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
    this.timer.unref?.();
  }

  private pump(): void {
    if (!this.transport || !this.pi || this.reserved || this.processing || this.switching || this.commandCount || this.activeState?.busy || this.activeState?.dispatching) return;
    const keys = [...this.states.keys()].filter(k => k !== "@local");
    const cursor = keys.indexOf(this.lastTarget ?? "");
    const ordered = [...keys.slice(cursor + 1), ...keys.slice(0, cursor + 1)];
    const target = ordered.find(k => this.states.get(k)!.queue.size > 0);
    if (!target) return;
    const job = this.states.get(target)!.queue.shift()!;
    const token = randomUUID();
    this.reserved = { token, target, job };
    Promise.resolve().then(() => this.pi.sendUserMessage(`/qq_dispatch ${token}`, { expandPromptTemplates: true })).catch(error => {
      if (this.reserved?.token !== token) return;
      this.reserved = null;
      job.attempts++;
      if (job.attempts < 3) this.stateFor(target).queue.unshift(job);
      log("[isolation] 派发失败:", String(error));
      this.schedule(1000);
    });
  }

  /** Called only from a real ExtensionCommandContext, never an event context. */
  async dispatch(token: string, ctx: any): Promise<void> {
    const reserved = this.reserved;
    if (!reserved || reserved.token !== token) return;
    this.processing = true;
    try {
      await ctx.waitForIdle();
      const { target, job } = reserved;
      const previous = this.sessions[target];
      const resume = !!previous && fs.existsSync(previous);
      const execute = async (fresh: any) => {
        // Cancellation may have removed the reserved job during a replacement.
        if (this.reserved?.token !== token) return;
        if (!resume && this.defaultModel &&
          (fresh.model?.provider !== this.defaultModel.provider || fresh.model?.id !== this.defaultModel.id)) {
          if (!await this.pi.setModel(this.defaultModel)) throw new Error("Could not select the configured QQ model for a new conversation");
        }
        this.record(target, fresh.sessionManager.getSessionFile());
        this.activeTarget = target;
        this.lastTarget = target;
        this.reserved = null;
        const state = this.stateFor(target);
        state.registryCtx = fresh;
        // The newly rebound extension owns this Pi API, not the captured old one.
        if (job.rawMessage) await this.hooks.handle(this.pi, state, job.rawMessage);
        else this.hooks.start(this.pi, state, job);
      };
      if (this.activeTarget === target) await execute(ctx);
      else {
        this.switching = true;
        this.nextTarget = target;
        const result = resume
          ? await ctx.switchSession(previous, { withSession: execute })
          : await ctx.newSession({ withSession: execute });
        if (result?.cancelled || this.reserved?.token === token) throw new Error("QQ session replacement cancelled or kickoff did not run");
      }
    } catch (error) {
      log("[isolation] 会话切换失败，未交给模型:", String(error));
      if (this.reserved?.token === token) {
        this.reserved = null;
        await this.hooks.reply(this.stateFor(reserved.target), reserved.target, "会话切换失败，这条没有执行，请稍后重试。");
      }
    } finally {
      this.processing = false;
      this.switching = false;
      this.nextTarget = null;
      this.schedule();
    }
  }

  trackCommand(promise: Promise<unknown>): void {
    this.commandCount++;
    promise.catch(error => log("[isolation] 命令失败:", String(error))).finally(() => { this.commandCount--; this.schedule(); });
  }

  cancelReserved(target: string): void {
    if (this.reserved?.target === target) this.reserved = null;
  }

  beforeShutdown(reason: string): boolean {
    if (this.activeState) {
      this.activeState.registryCtx = null;
      this.activeState.ctx = null;
    }
    if (this.switching && (reason === "new" || reason === "resume")) return true;
    this.transport = null;
    if (reason === "quit") {
      for (const state of this.states.values()) {
        state.approver.terminateAll(); state.queue.clear();
        if (state.progressTimer) clearInterval(state.progressTimer);
        if (state.cancelTimer) clearTimeout(state.cancelTimer);
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.reserved = null;
    }
    return false;
  }

  blockedCommand(text: string): boolean {
    // Global history selection and runtime-changing plugins could bypass routing.
    return /^\/(?:resume|tree|fork|clone|qq_dispatch)(?:\s|$)/i.test(text.trim()) ||
      /^\/qq\s+(?:list|pick|resume|tree|fork|clone)(?:\s|$)/i.test(text.trim());
  }
}

export function sharedIsolationHub(createState: () => State): IsolationHub {
  const key = Symbol.for(`pi-qqbot.isolation.v1:${process.cwd()}`);
  const root = globalThis as any;
  return root[key] ?? (root[key] = new IsolationHub(createState));
}
