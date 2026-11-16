import os from "node:os";
import path from "node:path";

export const TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
export const REST_BASE_PROD = "https://api.bot.qq.com";
export const REST_BASE_SANDBOX = "https://sandbox.api.sgroup.qq.com";
export const INTENT_GROUP_AND_C2C = 1 << 25;
/** 按钮点击回调（INTERACTION_CREATE）*/
 export const INTENT_INTERACTION = 1 << 26;
export const PASSIVE_WINDOW_MS = 60 * 60 * 1000; // 单聊被动窗口 60 分钟
export const MAX_REPLIES_PER_MSG_ID = 4;
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const STREAM_FLUSH_INTERVAL_MS = 1200;
export const GATEWAY_PATH = "/gateway";
/** 队列任务派发给 pi 失败（通常是上一轮还没收尾）时的重试间隔 */
export const DISPATCH_RETRY_MS = 3000;
/** /cancel 之后等 agent_settled 的宽限时间，超时就强制释放 busy */
export const CANCEL_SETTLE_GRACE_MS = 8000;

// ---- 附件（图片/语音/视频/文档/压缩包/普通文件）----
/** 单个附件下载上限：25 MB */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** 单条消息最多处理几个附件 */
export const DEFAULT_ATTACHMENT_MAX_PER_MESSAGE = 10;
/** 临时文件保留时长（小时）：启动时清理更早的 */
export const DEFAULT_ATTACHMENT_RETENTION_HOURS = 24;
/** 临时目录里最多保留多少个文件（超出删最旧） */
export const DEFAULT_ATTACHMENT_MAX_FILES = 200;
/** 单个附件下载超时 */
export const ATTACHMENT_TIMEOUT_MS = 30_000;
/** 单条消息内并发下载数 */
export const ATTACHMENT_CONCURRENCY = 3;

// ---- 发送本机文件到 QQ（富媒体分片上传）----
/** 默认单个文件上限：30 MB（QQ 硬限 200 MB，软限以上会降级成文件卡片） */
export const DEFAULT_SEND_MAX_BYTES = 30 * 1024 * 1024;
/** 分片大小兜底：服务端会在 upload_prepare 里下发 block_size */
export const UPLOAD_PART_FALLBACK_BYTES = 5 * 1024 * 1024;
/** 单个分片失败重试次数 */
export const UPLOAD_PART_ATTEMPTS = 3;
/** 上传请求（预上传/合并/分片）超时 */
export const UPLOAD_TIMEOUT_MS = 120_000;

const PI_DIR = path.join(os.homedir(), ".pi", "agent");
/** pi 的 agent 目录（其他扩展也往里写东西，如 pi-usage-report） */
export const PI_AGENT_DIR = PI_DIR;
export const CONFIG_PATH = () => path.join(PI_DIR, "pi-qqbot.json");
export const LOCK_PATH = (appId: string) => path.join(PI_DIR, `pi-qqbot-${appId}.lock`);
/** 记录「谁占着这个 bot」：pid/cwd/账号名 + 临时释放的预约窗口（换进程时用来生成提示） */
export const OWNER_PATH = (appId: string) => path.join(PI_DIR, `pi-qqbot-${appId}.owner.json`);
/** 日志文件（按账号分文件：多进程同机时不交错） */
export const LOG_PATH = (account: string, legacy = false) =>
  path.join(PI_DIR, legacy ? "pi-qqbot.log" : `pi-qqbot-${account}.log`);
