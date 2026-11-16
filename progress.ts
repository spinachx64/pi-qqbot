/**
 * 任务进度摘要：把 run 期间的事件（轮次、工具调用、流式文本、token）压成一条
 * 适合发到 QQ 的短消息。纯本地字符串拼接，不产生任何模型调用。
 */

import { redactSecrets, shortRedacted } from "./redact";

export interface ProgressSettings {
  /** 是否自动推送进度 */
  enabled: boolean;
  /** 推送间隔（毫秒） */
  intervalMs: number;
}

const MAX_PROGRESS_CHARS = 320;
const TOOL_PREVIEW_CHARS = 60;
const TAIL_CHARS = 120;

/** 把工具参数压成一句人能看懂的话（已脱敏、已截断） */
export function toolPreview(toolName: string, args: any): string {
  const input = args ?? {};
  switch (toolName) {
    case "bash":
    case "powershell":
      return shortRedacted(input.command ?? "");
    case "write":
    case "edit":
    case "read":
      return shortRedacted(input.path ?? input.file ?? input.filePath ?? "");
    case "grep":
    case "bgrep":
      return shortRedacted(input.pattern ?? "");
    case "glob":
    case "find":
      return shortRedacted(input.pattern ?? input.path ?? "");
    default:
      try {
        return shortRedacted(JSON.stringify(input));
      } catch {
        return shortRedacted(String(input));
      }
  }
}

const fmtDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

interface OpenTool {
  name: string;
  preview: string;
  startedAt: number;
}

export class ProgressTracker {
  running = false;
  private startedAt = 0;
  private turns = 0;
  private counts = new Map<string, number>();
  private failures = 0;
  private tokens = 0;
  private tail = "";
  private open = new Map<string, OpenTool>();
  private last: { name: string; preview: string; ms?: number; ok?: boolean } | null = null;

  start(now = Date.now()): void {
    this.running = true;
    this.startedAt = now;
    this.turns = 0;
    this.counts.clear();
    this.failures = 0;
    this.tokens = 0;
    this.tail = "";
    this.open.clear();
    this.last = null;
  }

  stop(): void {
    this.running = false;
    this.open.clear();
    this.tail = "";
  }

  toolStart(callId: string, toolName: string, args: any, now = Date.now()): void {
    if (!this.running) return;
    const name = toolName || "tool";
    this.open.set(callId, { name, preview: toolPreview(name, args), startedAt: now });
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.tail = "";
  }

  toolEnd(callId: string, toolName: string, isError: boolean, durationMs?: number, now = Date.now()): void {
    if (!this.running) return;
    const open = this.open.get(callId);
    this.open.delete(callId);
    if (isError) this.failures += 1;
    this.last = {
      name: open?.name ?? toolName ?? "tool",
      preview: open?.preview ?? "",
      ms: typeof durationMs === "number" ? durationMs : open ? now - open.startedAt : undefined,
      ok: !isError,
    };
  }

  turn(): void {
    if (this.running) this.turns += 1;
  }

  addUsage(usage: any): void {
    if (!this.running) return;
    const total = Number(usage?.totalTokens ?? 0);
    if (Number.isFinite(total) && total > 0) this.tokens += total;
  }

  appendText(delta: string): void {
    if (!this.running || !delta) return;
    this.tail = `${this.tail}${delta}`.slice(-TAIL_CHARS * 2);
  }

  /** 当前正在执行的工具（如果卡在某个长命令上，这比「正在写」有用） */
  private runningTool(): OpenTool | null {
    let newest: OpenTool | null = null;
    for (const tool of this.open.values()) {
      if (!newest || tool.startedAt > newest.startedAt) newest = tool;
    }
    return newest;
  }

  /** 一条可直接发到 QQ 的摘要；没有可说的内容时返回空串 */
  summary(now = Date.now()): string {
    if (!this.running) return "";
    const head: string[] = [`[进度 ${fmtDuration(now - this.startedAt)}]`];
    if (this.turns > 0) head.push(`第 ${this.turns} 轮`);

    const totalCalls = [...this.counts.values()].reduce((sum, n) => sum + n, 0);
    if (totalCalls > 0) {
      const top = [...this.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, n]) => `${name} ${n}`)
        .join(" / ");
      head.push(`工具 ${totalCalls} 次（${top}）`);
    }
    if (this.failures > 0) head.push(`失败 ${this.failures}`);

    const lines: string[] = [head.join(" · ")];

    if (this.last) {
      const timing = this.last.ms !== undefined ? ` · ${(this.last.ms / 1000).toFixed(1)}s` : "";
      const status = this.last.ok === false ? " · 失败" : "";
      const preview = this.last.preview ? ` "${this.last.preview}"` : "";
      lines.push(`最近: ${this.last.name}${preview}${timing}${status}`);
    }

    const active = this.runningTool();
    if (active) {
      lines.push(`正在: ${active.name}${active.preview ? ` "${active.preview}"` : ""}（已 ${(Math.max(0, now - active.startedAt) / 1000).toFixed(0)}s）`);
    } else {
      const tail = shortRedacted(this.tail.slice(-TAIL_CHARS), TAIL_CHARS);
      if (tail) lines.push(`正在: ${tail}`);
    }

    if (this.tokens > 0) lines.push(`已用 ${fmtTokens(this.tokens)} tok`);

    const text = redactSecrets(lines.join("\n"));
    return text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS)}…` : text;
  }
}
