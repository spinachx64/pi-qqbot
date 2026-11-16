import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./redact";
import { LOG_PATH as ACCOUNT_LOG_PATH } from "./constants";

/**
 * 日志文件。默认仍写旧的单文件 `pi-qqbot.log`（1.x 行为、旧测试与旧排查习惯都靠它），
 * 一旦 `configureLog(账号名)` 被调用（多 bot 场景）就改成 `pi-qqbot-<账号>.log`：
 * 同一台机器跑多个 pi 进程时，各账号的日志不交织。
 */
let currentPath: string | null = null;
const legacyPath = () => path.join(os.homedir(), ".pi", "agent", "pi-qqbot.log");
const logPath = () => currentPath ?? legacyPath();

/**
 * 指定本进程的账号：之后所有日志写进该账号的日志文件。
 * `null` = 单 bot 场景，继续写旧的 `pi-qqbot.log`（v1 配置升级后日志位置不变）。
 */
export function configureLog(account: string | null): void {
  currentPath = account ? ACCOUNT_LOG_PATH(account) : legacyPath();
}

/** 当前日志文件路径（诊断用） */
export function currentLogPath(): string {
  return logPath();
}

const pad = (value: number, width = 2): string =>
  String(Math.trunc(Math.abs(value))).padStart(width, "0");

/**
 * 本地时间戳 + 时区偏移，例如 `2026-10-24T07:39:09.762+08:00`。
 *
 * 以前用 `toISOString()`（UTC），看日志要和文件 mtime、进程启动时间（都是本地）
 * 来回换算，容易对不上；北京时间直接读即可，同时又保留偏移，跨时区不会歧义。
 */
export function timestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset(); // 东八区 = +480
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  const local =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`;
  return `${local}${offset}`;
}

export function log(...args: unknown[]) {
  const body = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  // 日志会留在磁盘上：落盘前统一脱敏（Authorization、token=、URL userinfo、私钥块等）
  const line = `[${timestamp()}] ${redactSecrets(body)}\n`;
  try {
    fs.appendFileSync(logPath(), line, "utf8");
  } catch {
    /* ignore */
  }
}

/** Local conversation archive. Metadata excludes temporary attachment URLs and tokens. */
export function logConversation(
  direction: "in" | "out",
  target: string,
  content: string,
  metadata: Record<string, unknown> = {},
): void {
  try {
    const now = new Date();
    const day = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const dir = path.join(os.homedir(), "data", "logs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const clean = (value: unknown): unknown => {
      if (typeof value === "string") return redactSecrets(value);
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
      return value;
    };
    const entry = { timestamp: now.toISOString(), direction, target, content, ...metadata };
    fs.appendFileSync(path.join(dir, `qq-chat-${day}.jsonl`), JSON.stringify(clean(entry)) + "\n", { mode: 0o600 });
  } catch (error) {
    log("[chat-log] 写入失败:", String(error));
  }
}
