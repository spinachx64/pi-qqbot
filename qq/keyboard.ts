/**
 * QQ 内联键盘（消息按钮）构建与 button_data 编解码。
 *
 * 官方规则（bot.q.qq.com「消息按钮」文档）：
 * - 键盘只随 markdown 消息（msg_type=2）发送；
 * - 最多 5 行 × 每行 5 个按钮；
 * - action.type=1 为回调按钮：data 原样回传给后台（INTERACTION_CREATE 事件）；
 * - 自定义按钮需平台「内邀开通」；发送失败时调用方应降级纯文本（编号回复仍可用）。
 */

export interface KeyboardButton {
  id: string;
  render_data: { label: string; visited_label: string; style: number };
  action: {
    type: 1;
    permission: { type: 2 };
    data: string;
    unsupport_tips: string;
  };
}

export interface InlineKeyboard {
  content: { rows: { buttons: KeyboardButton[] }[] };
}

/** 按钮 label 保守上限（官方未给硬限，对齐同平台 dsh-qqbot 的 10 字符） */
export const BUTTON_LABEL_MAX = 10;
/** 每行按钮数（2 列布局，减少选项多时的刷屏） */
export const BUTTONS_PER_ROW = 2;
/** 官方上限：5 行 */
export const BUTTON_ROW_MAX = 5;

/** 截断按钮 label，超长补省略号（正文保留完整文本） */
export function buttonLabel(text: string): string {
  const s = String(text ?? "").trim();
  return s.length > BUTTON_LABEL_MAX ? `${s.slice(0, BUTTON_LABEL_MAX - 1)}…` : s;
}

/** 审批按钮载荷：s = 审批编号（与 Approver.pending 的 seq 对应） */
export interface ApprovalButtonData {
  t: "approval";
  d: "allow" | "deny" | "always";
  s: number;
}

/** 选择按钮载荷：i = 1 起始的选项编号（与「回复编号」口径一致） */
export interface PickButtonData {
  t: "pick";
  i: number;
}

export function encodeButtonData(data: ApprovalButtonData | PickButtonData): string {
  return JSON.stringify(data);
}

/** 解码 button_data；非法 JSON 或缺少合法顶层判别字段时返回 undefined */
export function decodeButtonData(raw: unknown): ApprovalButtonData | PickButtonData | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalButtonData | PickButtonData> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.t === "approval" && (parsed.d === "allow" || parsed.d === "deny" || parsed.d === "always")) {
      return parsed as ApprovalButtonData;
    }
    if (parsed.t === "pick" && typeof parsed.i === "number" && Number.isFinite(parsed.i)) {
      return parsed as PickButtonData;
    }
  } catch {
    // 非法 JSON → undefined
  }
  return undefined;
}

/**
 * 审批键盘：允许一次 / 拒绝（非 strict 再加「以后都同意」），全部放在一行。
 * 点击由服务端按 seq 匹配 pending：过期卡片点击不 settle（ACK 重复操作）。
 */
export function buildApprovalKeyboard(seq: number, opts: { strict?: boolean } = {}): InlineKeyboard {
  const allow: KeyboardButton = {
    id: `approval-allow-${seq}`,
    render_data: { label: "✅ 允许一次", visited_label: "✓ 已允许", style: 1 },
    action: {
      type: 1,
      permission: { type: 2 },
      data: encodeButtonData({ t: "approval", d: "allow", s: seq }),
      unsupport_tips: "当前客户端不支持按钮，请回复「同意」",
    },
  };
  const deny: KeyboardButton = {
    id: `approval-deny-${seq}`,
    render_data: { label: "❌ 拒绝", visited_label: "✓ 已拒绝", style: 0 },
    action: {
      type: 1,
      permission: { type: 2 },
      data: encodeButtonData({ t: "approval", d: "deny", s: seq }),
      unsupport_tips: "当前客户端不支持按钮，请回复「拒绝」",
    },
  };
  const buttons: KeyboardButton[] = [allow, deny];
  if (!opts.strict) {
    buttons.push({
      id: `approval-always-${seq}`,
      render_data: { label: "🚀 以后都同意", visited_label: "✓ 已放行", style: 1 },
      action: {
        type: 1,
        permission: { type: 2 },
        data: encodeButtonData({ t: "approval", d: "always", s: seq }),
        unsupport_tips: "当前客户端不支持按钮，请回复「以后都同意」",
      },
    });
  }
  return { content: { rows: [{ buttons }] } };
}

/**
 * 选择键盘：每行 2 个按钮、最多 5 行；超出部分不生成按钮（正文编号仍可用）。
 * i 从 1 起与「回复编号」一致。
 */
export function buildPickerKeyboard(items: { label: string }[]): InlineKeyboard | undefined {
  if (items.length === 0) return undefined;
  const rows: { buttons: KeyboardButton[] }[] = [];
  const cap = BUTTON_ROW_MAX * BUTTONS_PER_ROW;
  for (let i = 0; i < items.length && i < cap; i += BUTTONS_PER_ROW) {
    rows.push({
      buttons: items.slice(i, i + BUTTONS_PER_ROW).map((item, offset) => {
        const idx = i + offset;
        return {
          id: `pick-${idx}`,
          render_data: { label: buttonLabel(item.label), visited_label: "✓ 已选", style: 1 },
          action: {
            type: 1,
            permission: { type: 2 },
            data: encodeButtonData({ t: "pick", i: idx + 1 }),
            unsupport_tips: "当前客户端不支持按钮，请回复编号选择",
          },
        };
      }),
    });
  }
  return { content: { rows } };
}
