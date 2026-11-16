/**
 * 把本机文件发到 QQ（单聊富媒体上传）。
 *
 * 官方接口（2026-07 文档）：
 *   1) POST /v2/users/{openid}/upload_prepare  → upload_id / block_size / parts[].presigned_url
 *   2) PUT  <presigned_url>                     → 直接推分片字节（不带 Authorization）
 *   3) POST /v2/users/{openid}/upload_part_finish { upload_id, part_index, block_size, md5 }
 *   4) POST /v2/users/{openid}/files           { file_type, upload_id, file_name, srv_send_msg:false }
 *      → file_info / ttl
 *   5) 再走发消息接口：msg_type=7 + media.file_info（见 qq/api.ts 的 sendC2CMedia）
 *
 * 只有 URL 上传和分片上传两种方式能突破 5MB；本地文件没有公网 URL，所以统一走分片。
 * `file_type`：1=图片(png/jpg) 2=视频(mp4) 3=语音(silk) 4=文件；其余扩展名一律 4。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { targetPath } from "./target";
import {
  DEFAULT_SEND_MAX_BYTES,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_PART_FALLBACK_BYTES,
  UPLOAD_TIMEOUT_MS,
} from "../constants";

/** QQ 富媒体业务类型 */
export type MediaFileType = 1 | 2 | 3 | 4;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXT = new Set([".mp4"]);
const VOICE_EXT = new Set([".silk"]);
/** QQ 侧硬上限 */
const HARD_LIMIT_BYTES = 200 * 1024 * 1024;
/** md5_10m 取文件前 10002432 字节（约 9.54MB，官方定义） */
const MD5_10M_BYTES = 10_002_432;

/**
 * 扩展名 → file_type。
 * 注意：只有 png/jpg 算图片、mp4 算视频、silk 算语音；其它（gif/webp/mp3/pdf/zip…）
 * 必须按「文件」发，否则服务端报 850019 不支持的文件格式。
 */
export function mediaFileTypeOf(filePath: string): MediaFileType {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 1;
  if (VIDEO_EXT.has(ext)) return 2;
  if (VOICE_EXT.has(ext)) return 3;
  return 4;
}

export interface RichMediaUploadOptions {
  /** REST 基址（生产/沙箱） */
  restBase: string;
  /** 目标用户 openid */
  openid: string;
  getToken: () => Promise<string>;
  /** 要发送的本机文件路径 */
  filePath: string;
  /** 在 QQ 里显示的文件名（默认取 basename） */
  fileName?: string;
  /** 扩展里的大小上限（默认 30MB，QQ 硬限 200MB） */
  maxBytes?: number;
  /** 覆盖自动判定的 file_type */
  fileType?: MediaFileType;
  onProgress?: (done: number, total: number) => void;
  log?: (message: string, ...rest: unknown[]) => void;
  fetchFn?: typeof fetch;
}

export interface UploadedMedia {
  /** 发送消息时用的 media.file_info（原样透传，不要解析） */
  fileInfo: string;
  /** 有效期（秒），0 = 长期可用 */
  ttl: number;
  fileType: MediaFileType;
  fileName: string;
  size: number;
  md5: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function short(value: string, max = 200): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const anyAbort = AbortSignal as any;
  return typeof anyAbort?.timeout === "function" ? anyAbort.timeout(ms) : undefined;
}

function sanitizeFileName(name: string): string {
  const base = String(name ?? "")
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .trim();
  const clipped = base.slice(0, 100);
  return clipped || "file.bin";
}

/** md5 / sha1 / md5_10m（上传预检要这三个） */
export function hashFileBuffer(buffer: Buffer): { md5: string; sha1: string; md5_10m: string } {
  return {
    md5: crypto.createHash("md5").update(buffer).digest("hex"),
    sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
    md5_10m: crypto.createHash("md5").update(buffer.subarray(0, MD5_10M_BYTES)).digest("hex"),
  };
}

/** 把 QQ 的错误码翻成人话（用于回执） */
export function explainUploadError(error: unknown): string {
  const text = String((error as any)?.message ?? error ?? "");
  const hints: [RegExp, string][] = [
    [/850031/, "文件超过 QQ 大小限制"],
    [/850019/, "QQ 不支持该文件格式（图片只收 png/jpg，视频只收 mp4，语音只收 silk）"],
    [/40093002/, "今天的发送文件容量已达上限（QQ 限制），明天再试或换小文件"],
    [/850027/, "QQ 侧发送超时，稍后重试"],
    [/850018/, "机器人被禁言或受频率限制"],
    [/850026/, "QQ 下载原始文件失败"],
    [/40093001/, "QQ 转存失败，请重试"],
  ];
  for (const [pattern, hint] of hints) {
    if (pattern.test(text)) return `${hint}${text ? `（${short(text)}）` : ""}`;
  }
  return short(text) || "未知错误";
}

async function withRetry<T>(task: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    try {
      return await task();
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function makeClient(opts: RichMediaUploadOptions, token: string) {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = UPLOAD_TIMEOUT_MS;
  const postJson = async (url: string, body: unknown): Promise<any> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${short(text)}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`响应不是 JSON：${short(text)}`);
    }
  };
  return { fetchFn, postJson };
}

/**
 * 分片上传一个本机文件，返回可用于发消息的 file_info。
 * 失败抛异常（调用方用 explainUploadError 转成回执文案）。
 */
export async function uploadRichMedia(opts: RichMediaUploadOptions): Promise<UploadedMedia> {
  const filePath = path.resolve(String(opts.filePath ?? ""));
  let stat: { isFile(): boolean; size: number };
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new Error(`文件不存在：${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  if (stat.size === 0) throw new Error(`文件是空的：${filePath}`);

  const maxBytes = Math.max(1, Number(opts.maxBytes ?? DEFAULT_SEND_MAX_BYTES));
  if (stat.size > HARD_LIMIT_BYTES) {
    throw new Error(`文件过大（${formatBytes(stat.size)}），QQ 硬上限 ${formatBytes(HARD_LIMIT_BYTES)}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`文件过大（${formatBytes(stat.size)} > 上限 ${formatBytes(maxBytes)}）`);
  }

  const buffer = await fs.promises.readFile(filePath);
  const fileName = sanitizeFileName(opts.fileName || path.basename(filePath));
  const fileType = opts.fileType ?? mediaFileTypeOf(filePath);
  const hashes = hashFileBuffer(buffer);
  const base = `${opts.restBase}${targetPath(opts.openid)}`;
  const token = await opts.getToken();
  const client = makeClient(opts, token);

  // 1) 预上传
  const prepared = await client.postJson(`${base}/upload_prepare`, {
    file_type: fileType,
    file_size: String(buffer.length),
    file_name: fileName,
    ...hashes,
  });
  const uploadId = String(prepared?.upload_id ?? "");
  if (!uploadId) throw new Error(`预上传失败：缺少 upload_id（${short(JSON.stringify(prepared))}）`);

  const parts: any[] = Array.isArray(prepared.parts) ? [...prepared.parts] : [];
  parts.sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
  if (parts.length === 0) throw new Error("预上传失败：没有返回分片信息");

  const fallbackPartSize = Number(prepared.block_size ?? 0) || UPLOAD_PART_FALLBACK_BYTES;
  let offset = 0;
  const jobs = parts.map((p) => {
    const size = Number(p?.block_size ?? 0) || fallbackPartSize;
    const slice = buffer.subarray(offset, offset + size);
    offset += size;
    return {
      index: Number(p?.index ?? 0),
      url: String(p?.presigned_url ?? ""),
      slice,
      size: slice.length,
      md5: crypto.createHash("md5").update(slice).digest("hex"),
    };
  });

  const uploadConfig = prepared?.upload_config ?? {};
  const concurrency = Math.max(1, Math.min(8, Number(uploadConfig.concurrency ?? 1) || 1));
  const retryDelayMs = Math.max(200, Number(uploadConfig.retry_delay ?? 1) * 1000 || 1000);

  // 2)+3) 分片 PUT + 确认
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      if (!job.url) throw new Error(`分片 ${job.index} 没有预签名地址`);
      await withRetry(
        async () => {
          const res = await client.fetchFn(job.url, {
            method: "PUT",
            body: job.slice,
            signal: timeoutSignal(UPLOAD_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`分片上传失败 HTTP ${res.status} ${short(await res.text())}`);
          await client.postJson(`${base}/upload_part_finish`, {
            upload_id: uploadId,
            part_index: job.index,
            block_size: String(job.size),
            md5: job.md5,
          });
        },
        UPLOAD_PART_ATTEMPTS,
        retryDelayMs,
      );
      done += 1;
      opts.onProgress?.(done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

  // 4) 合并，拿 file_info
  const merged = await client.postJson(`${base}/files`, {
    file_type: fileType,
    upload_id: uploadId,
    file_name: fileName,
    srv_send_msg: false,
  });
  const fileInfo = String(merged?.file_info ?? "");
  if (!fileInfo) throw new Error(`上传合并失败：${short(JSON.stringify(merged))}`);

  opts.log?.(
    "[send] 上传完成",
    fileName,
    formatBytes(buffer.length),
    `file_type=${fileType}`,
    `ttl=${merged?.ttl ?? 0}`,
  );
  return { fileInfo, ttl: Number(merged?.ttl ?? 0), fileType, fileName, size: buffer.length, md5: hashes.md5 };
}

/** 回执里用的类型说明 */
export function mediaKindLabel(fileType: MediaFileType): string {
  if (fileType === 1) return "图片";
  if (fileType === 2) return "视频";
  if (fileType === 3) return "语音";
  return "文件卡片";
}
