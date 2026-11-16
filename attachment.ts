/**
 * QQ 附件落盘。
 *
 * 收到消息后把附件下载到系统临时目录，再把「图片路径 <path>」这类标记行拼进
 * 交给 pi 的文本里——pi 的 read 工具能直接打开图片，普通文件也能按路径处理。
 *
 * 分类（用户定的六类，一个都不忽略）：
 *   图片 → `图片路径 <path>`
 *   语音 → `语音路径 <path>`
 *   视频 → `视频路径 <path>`
 *   文档 → `文档路径 <path>`
 *   压缩包 → `压缩包路径 <path>`
 *   其它 → `文件路径 <path>`
 *
 * 纯逻辑 + 可注入 fetch / 目录，方便单测（见 test/attachment.test.mjs）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTACHMENT_CONCURRENCY,
  ATTACHMENT_TIMEOUT_MS,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MAX_PER_MESSAGE,
  DEFAULT_ATTACHMENT_RETENTION_HOURS,
} from "./constants";

export type AttachmentKind = "image" | "voice" | "video" | "document" | "archive" | "file";

/** 网关归一化后的附件（见 qq/gateway.ts） */
export interface IncomingAttachment {
  url: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

export interface SavedAttachment {
  kind: AttachmentKind;
  /** 落盘后的绝对路径 */
  path: string;
  /** 规整后的文件名 */
  name: string;
}

export interface AttachmentFailure {
  /** 展示名（原始文件名或「附件 N」） */
  name: string;
  reason: string;
}

export interface SaveAttachmentsOptions {
  dir: string;
  maxBytes?: number;
  maxPerMessage?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** 下载 401/403 时重试用的凭据（QQ 签名 URL 一般不需要） */
  credential?: (() => Promise<string>) | null;
  /** 文件名前缀，通常传 msgId，便于追到是哪条消息 */
  prefix?: string;
}

export interface SaveAttachmentsResult {
  saved: SavedAttachment[];
  failed: AttachmentFailure[];
}

/** 拼进 pi 文本时的行首文案 */
export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片路径",
  voice: "语音路径",
  video: "视频路径",
  document: "文档路径",
  archive: "压缩包路径",
  file: "文件路径",
};

/** 回执里用的中文类别名 */
export const KIND_NAME_ZH: Record<AttachmentKind, string> = {
  image: "图片",
  voice: "语音",
  video: "视频",
  document: "文档",
  archive: "压缩包",
  file: "文件",
};

/** 回执里的固定顺序，避免每次排列不同 */
export const KIND_ORDER: AttachmentKind[] = ["image", "voice", "video", "document", "archive", "file"];

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/amr": "amr",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/opus": "opus",
  "audio/silk": "silk",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/xml": "xml",
  "application/json": "json",
  "application/xml": "xml",
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff"]);
const VOICE_EXT = new Set(["silk", "amr", "mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv", "wmv", "mpg", "mpeg"]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "jar"]);
const DOC_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "log",
  "ini",
  "toml",
  "ts",
  "js",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "rs",
  "go",
  "sh",
]);

/** 从文件名 / URL 里取扩展名（去掉 query 与 hash，只看最后一段） */
export function extFromName(value: string | undefined): string {
  if (!value) return "";
  const clean = String(value).split("#")[0].split("?")[0];
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext.length > 8 ? "" : ext;
}

function mimeExt(contentType: string | undefined): string {
  const ct = String(contentType ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (!ct) return "";
  return MIME_EXT[ct] ?? "";
}

/** 六类判定：content_type 优先，其次看扩展名 */
export function classifyAttachment(a: IncomingAttachment): AttachmentKind {
  const ct = String(a.contentType ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const ext = extFromName(a.filename) || extFromName(a.url) || mimeExt(ct);
  if (ct.startsWith("image/") || ct === "image" || (ext !== "" && IMAGE_EXT.has(ext))) return "image";
  if (ct.startsWith("audio/") || ct === "audio" || ct === "voice" || (ext !== "" && VOICE_EXT.has(ext)))
    return "voice";
  if (ct.startsWith("video/") || ct === "video" || (ext !== "" && VIDEO_EXT.has(ext))) return "video";
  if ((ext !== "" && ARCHIVE_EXT.has(ext)) || /zip|rar|7z|tar|gzip|compressed/.test(ct)) return "archive";
  if (
    (ext !== "" && DOC_EXT.has(ext)) ||
    ct.startsWith("text/") ||
    /pdf|word|document|sheet|presentation|excel|powerpoint|msword|officedocument/.test(ct)
  )
    return "document";
  return "file";
}

function extensionFor(a: IncomingAttachment): string {
  return mimeExt(a.contentType) || extFromName(a.filename) || extFromName(a.url) || "bin";
}

/** 落盘名里只允许 [0-9a-zA-Z._-]：路径带空格/中文会让 agent 的命令行不好写 */
function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[^0-9a-zA-Z._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 40);
  return cleaned || fallback;
}

/** 默认落盘目录：系统临时文件夹 / pi-qqbot / bot-<appId 后 6 位> */
export function defaultAttachmentDir(appId: string): string {
  const tail = String(appId ?? "")
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-6);
  return path.join(os.tmpdir(), "pi-qqbot", tail ? `bot-${tail}` : "default");
}

function dayStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function timeStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function displayName(a: IncomingAttachment, index: number): string {
  const name = String(a.filename ?? "").trim();
  return name || `附件 ${index + 1}`;
}

function reasonOf(error: unknown): string {
  const message = String((error as any)?.message ?? error ?? "").trim();
  return (message || "未知错误").slice(0, 160);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const anyAbort = AbortSignal as any;
  return typeof anyAbort?.timeout === "function" ? anyAbort.timeout(ms) : undefined;
}

async function readLimitedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`文件过大（${formatBytes(declared)} > 上限 ${formatBytes(maxBytes)}）`);
  }
  const tooBig = () => new Error(`文件过大（超过上限 ${formatBytes(maxBytes)}）`);
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooBig();
    if (buf.byteLength === 0) throw new Error("下载到 0 字节");
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw tooBig();
    chunks.push(buf);
  }
  if (total === 0) throw new Error("下载到 0 字节");
  return Buffer.concat(chunks);
}

async function download(a: IncomingAttachment, opts: SaveAttachmentsOptions): Promise<Buffer> {
  const maxBytes = Math.max(1024, Number(opts.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES));
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? ATTACHMENT_TIMEOUT_MS));
  const fetchFn = opts.fetchFn ?? fetch;
  const url = String(a.url ?? "").trim();
  if (!url) throw new Error("没有下载地址");

  const attempt = async (authorization: string | null): Promise<Response | null> => {
    const headers: Record<string, string> = {};
    if (authorization) headers.Authorization = authorization;
    const res = await fetchFn(url, { headers, redirect: "follow", signal: timeoutSignal(timeoutMs) });
    if (!authorization && (res.status === 401 || res.status === 403)) return null; // 交给带凭据的重试
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return res;
  };

  let res = await attempt(null);
  if (res === null) {
    const auth = opts.credential ? await opts.credential().catch(() => "") : "";
    if (!auth) throw new Error("下载失败 HTTP 401/403（没有可用凭据重试）");
    res = await attempt(`QQBot ${auth}`);
    if (res === null) throw new Error("下载失败 HTTP 403（凭据被拒绝）");
  }
  return readLimitedBody(res, maxBytes);
}

async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || "att";
  let candidate = path.join(dir, filename);
  for (let i = 2; i <= 50; i += 1) {
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * 下载并落盘。**不抛异常**：单个附件失败只记进 failed，正文照旧走。
 * 返回的 saved 按入参顺序排列。
 */
export async function saveIncoming(
  attachments: IncomingAttachment[],
  opts: SaveAttachmentsOptions,
): Promise<SaveAttachmentsResult> {
  const list = (attachments ?? []).filter((a) => a && String(a.url ?? "").trim() !== "");
  if (list.length === 0) return { saved: [], failed: [] };

  const maxPer = Math.max(1, Number(opts.maxPerMessage ?? DEFAULT_ATTACHMENT_MAX_PER_MESSAGE));
  const target = list.slice(0, maxPer);
  const failed: AttachmentFailure[] = [];
  if (list.length > target.length) {
    failed.push({
      name: `其余 ${list.length - target.length} 个附件`,
      reason: `单条消息最多处理 ${maxPer} 个`,
    });
  }

  const now = new Date();
  const dir = path.join(opts.dir, dayStamp(now));
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});

  const prefix = sanitizeSegment(opts.prefix ?? "", "att");
  const results: (SavedAttachment & { index: number })[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < target.length) {
      const index = cursor;
      cursor += 1;
      const a = target[index];
      try {
        const kind = classifyAttachment(a);
        const ext = extensionFor(a);
        const name = `${prefix}-${index + 1}-${timeStamp(now)}.${ext}`;
        const filePath = await uniquePath(dir, name);
        const bytes = await download(a, opts);
        await fs.promises.writeFile(filePath, bytes);
        results.push({ index, kind, path: filePath, name: path.basename(filePath) });
      } catch (e) {
        failed.push({ name: displayName(a, index), reason: reasonOf(e) });
      }
    }
  };

  const workers = Math.min(ATTACHMENT_CONCURRENCY, target.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const saved = results.sort((a, b) => a.index - b.index).map(({ kind, path: filePath, name }) => ({
    kind,
    path: filePath,
    name,
  }));
  return { saved, failed };
}

/** 拼进 pi 文本的标记行（顺序与 saved 一致） */
export function renderAttachmentLines(saved: SavedAttachment[]): string[] {
  return saved.map((item) => `${KIND_LABEL[item.kind]} ${item.path}`);
}

/** 下载失败行：告诉 pi 缺了什么 */
export function renderAttachmentFailureLines(failed: AttachmentFailure[]): string[] {
  return failed.map((f) => `附件下载失败：${f.name}（${f.reason}）`);
}

/** QQ 回执：收到几个、什么类别、落在哪、哪些失败 */
export function renderAttachmentAck(saved: SavedAttachment[], failed: AttachmentFailure[]): string {
  const lines: string[] = [];
  if (saved.length > 0) {
    const counts = new Map<AttachmentKind, number>();
    for (const item of saved) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const parts = KIND_ORDER.filter((k) => counts.has(k)).map((k) => `${KIND_NAME_ZH[k]} ×${counts.get(k)}`);
    lines.push(`已收到 ${saved.length} 个附件（${parts.join("、")}），已存为临时文件并交给 pi：`);
    lines.push(...renderAttachmentLines(saved));
  }
  if (failed.length > 0) {
    lines.push(...renderAttachmentFailureLines(failed));
  }
  return lines.join("\n");
}

/**
 * 清理落盘目录：先按保留时长删过期文件，再按数量上限删最旧的。
 * 只碰自己创建的 `<dir>/<YYYY-MM-DD>/` 层，配置到自定义目录也不会误删别的文件。
 */
export async function sweepAttachmentDir(
  dir: string,
  opts: { retentionHours?: number; maxFiles?: number } = {},
): Promise<{ removed: number }> {
  const retentionMs =
    Math.max(0, Number(opts.retentionHours ?? DEFAULT_ATTACHMENT_RETENTION_HOURS)) * 60 * 60 * 1000;
  const maxFiles = Math.max(1, Number(opts.maxFiles ?? DEFAULT_ATTACHMENT_MAX_FILES));
  const now = Date.now();
  let removed = 0;
  const kept: { path: string; mtimeMs: number }[] = [];

  let days: string[] = [];
  try {
    days = await fs.promises.readdir(dir);
  } catch {
    return { removed: 0 }; // 目录还不存在
  }

  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const dayDir = path.join(dir, day);
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dayDir);
    } catch {
      continue;
    }
    let alive = 0;
    for (const name of names) {
      const full = path.join(dayDir, name);
      let stat: { isFile(): boolean; mtimeMs: number };
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (retentionMs > 0 && now - stat.mtimeMs > retentionMs) {
        try {
          await fs.promises.unlink(full);
          removed += 1;
        } catch {
          /* ignore */
        }
        continue;
      }
      kept.push({ path: full, mtimeMs: stat.mtimeMs });
      alive += 1;
    }
    if (alive === 0) {
      try {
        await fs.promises.rmdir(dayDir);
      } catch {
        /* ignore */
      }
    }
  }

  if (kept.length > maxFiles) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of kept.slice(0, kept.length - maxFiles)) {
      try {
        await fs.promises.unlink(item.path);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }

  return { removed };
}
