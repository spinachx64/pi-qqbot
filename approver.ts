/**
 * QQ 远程审批：
 * - 每个待审批请求生成编号，发到 QQ，等用户回复「同意/拒绝 N」或「停止」。
 * - register 返回一个 Promise，QQ 回复后 resolve 决策。
 * - remember 记忆：会话内同意/拒绝某工具后，同类工具不再询问。
 * - 自动同意（「以后都同意」）：会话级开关，开启后本会话内所有需审批的工具直接放行，
 *   直到 /new、新会话或回复「取消自动同意」为止（不跨会话、不写盘）。
 */
export type ApproveDecision = "allow" | "block" | "terminate" | "timeout";

/** parseReply 的解析结果：前四种对应具体动作，always/revoke 操作会话级自动同意 */
export type ParsedDecision = "allow" | "block" | "terminate" | "always" | "revoke";

export interface ParsedReply {
  decision: ParsedDecision;
  /** 缺省表示「作用于最早的一条待审批」，没有待审批时按普通消息处理 */
  seq?: number;
}

interface PendingApproval {
  summary: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: ApproveDecision) => void;
}

/**
 * 「以后都同意」类表达。
 *
 * 这些正则全部要求**整句匹配**（parseReply 里先归一化再卡长度）：
 * 用户把审批提示整段引回来、或写了「你这句话里说『取消自动同意』」时，
 * 不能把文案里的词当成指令执行。
 */
const RE_ALWAYS =
  /^(?:(?:以后|之后|今后|一直|全都|全部|都)\s*(?:都)?\s*(?:同意|允许|批准|放行)|别再(?:问|烦|提示)了?|always\s*(?:allow|yes))$/i;
/** 「取消自动同意」类表达（含「以后都不同意」），同样要求整句 */
const RE_REVOKE =
  /^(?:(?:取消|关闭|结束|停止)\s*自动同意|恢复审批|(?:以后|之后|今后|都|全部)\s*(?:都)?\s*不(?:同意|允许|批准|放行))$/;
/** 「停止」终止本轮（index.ts 里同时会 abort 当前 run） */
const RE_TERMINATE = /^停止$/;
/** 带或不带编号的批准/拒绝 */
const RE_DECIDE = /^(同意|批准|放行|允许|allow|拒绝|驳回|deny)\s*(\d+)?$/i;

/** 整句长度上限：超过它就是聊天（比如引用了审批提示），不是审批回复 */
const MAX_REPLY_CHARS = 12;

/** 去掉空白与常见标点/引号，把「同意 2。」和「\"同意2\"」归一成「同意2」 */
function normalizeReply(text: string): string {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、,.!?;；:：…~～"'“”‘’「」『』()（）\[\]【】]/g, "");
}

export class Approver {
  private pending = new Map<number, PendingApproval>();
  private rememberMap = new Map<string, ApproveDecision>();
  private nextSeq = 1;
  private autoAllow = false;
  private timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /** 会话级自动同意是否开启 */
  get autoAllowed(): boolean {
    return this.autoAllow;
  }

  /** 待审批请求数量 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 会话内是否已记住某工具的决策 */
  isRemembered(toolName: string): ApproveDecision | undefined {
    return this.rememberMap.get(toolName);
  }

  register(
    summary: string,
    onTimeout?: () => void,
  ): { seq: number; done: Promise<ApproveDecision> } {
    const seq = this.nextSeq++;
    const done = new Promise<ApproveDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve("timeout");
        onTimeout?.();
      }, this.timeoutMs);
      this.pending.set(seq, { summary, timer, resolve });
    });
    return { seq, done };
  }

  /**
   * 审批提示。默认两三行就够：用户反馈过「太长」；
   * strict 用于每次都要单独确认的工具（发文件），所以不提「以后都同意」。
   */
  render(seq: number, opts: { strict?: boolean } = {}): string {
    const item = this.pending.get(seq);
    const hint = opts.strict
      ? `点下方按钮，或回「同意 ${seq}」/「拒绝 ${seq}」，需单独确认。`
      : `点下方按钮，或回「同意 ${seq}」/「拒绝 ${seq}」；想全部放行回「以后都同意」。`;
    return [`[审批 #${seq}] ${item?.summary ?? ""}`, hint].join("\n");
  }

  /** 最早（编号最小）的待审批请求 */
  oldestSeq(): number | undefined {
    let oldest: number | undefined;
    for (const seq of this.pending.keys()) {
      if (oldest === undefined || seq < oldest) oldest = seq;
    }
    return oldest;
  }

  parseReply(text: string): ParsedReply | null {
    const raw = String(text ?? "").trim();
    if (!raw) return null;
    const t = normalizeReply(raw);
    if (!t || t.length > MAX_REPLY_CHARS) return null;
    if (RE_REVOKE.test(t)) return { decision: "revoke" };
    if (RE_ALWAYS.test(t)) return { decision: "always" };
    if (RE_TERMINATE.test(t)) return { decision: "terminate" };
    const m = RE_DECIDE.exec(t);
    if (!m) return null;
    const allow = /^(同意|批准|放行|允许|allow)$/i.test(m[1]);
    return { decision: allow ? "allow" : "block", seq: m[2] ? Number(m[2]) : undefined };
  }

  confirm(seq: number, decision: ApproveDecision): boolean {
    const item = this.pending.get(seq);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(seq);
    item.resolve(decision);
    return true;
  }

  /** 放行所有待审批请求（开启自动同意时用） */
  allowAll(): number {
    return this.resolveAll("allow");
  }

  /** 终止所有待审批请求（「停止」） */
  terminateAll(): number {
    return this.resolveAll("terminate");
  }

  /** 开启/关闭会话级自动同意 */
  setAutoAllow(on: boolean): void {
    this.autoAllow = on;
  }

  remember(toolName: string, decision: ApproveDecision) {
    this.rememberMap.set(toolName, decision);
  }

  /** 清空会话状态（remember 记忆 + 自动同意开关） */
  reset() {
    this.rememberMap.clear();
    this.autoAllow = false;
  }

  private resolveAll(decision: ApproveDecision): number {
    let count = 0;
    for (const [seq, item] of [...this.pending]) {
      clearTimeout(item.timer);
      this.pending.delete(seq);
      item.resolve(decision);
      count++;
    }
    return count;
  }
}
