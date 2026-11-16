import fs from "node:fs";
import { CONFIG_PATH } from "./constants";
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MAX_PER_MESSAGE,
  DEFAULT_ATTACHMENT_RETENTION_HOURS,
  DEFAULT_SEND_MAX_BYTES,
} from "./constants";
import { DEFAULT_COMMANDS, type CommandConfig } from "./slash";
import { DEFAULT_REMOTE, type RemoteConfig } from "./remote";
import { DEFAULT_QUEUE_MAX } from "./queue";

export interface QueueConfig {
  /** 忙碌时最多排队多少条消息；0 = 关闭排队（忙碌时直接拒绝） */
  max: number;
  /** 排队任务开始执行时是否给 QQ 回执（入队回执不受此开关控制） */
  ack: boolean;
}

export interface ApproveConfig {
  /** 需要 QQ 审批的工具名（如 bash/powershell/write/edit） */
  tools: string[];
  /** 会话内记住选择：同意/拒绝后同类工具不再询问（「以后都同意」不受此开关限制） */
  remember: boolean;
}

export interface ProgressConfig {
  /** 是否自动推送进度摘要（默认开） */
  enabled: boolean;
  /** 推送间隔（毫秒，默认 15000；可用 PI_QQBOT_PROGRESS_MS 覆盖，便于测试） */
  intervalMs: number;
}

export interface AttachmentConfig {
  /** 是否接收附件并落盘（false = 只回一句忽略提示） */
  enabled: boolean;
  /** 落盘目录；空字符串 = 系统临时文件夹下的 pi-qqbot/<bot> */
  dir: string;
  /** 单个附件上限（字节） */
  maxBytes: number;
  /** 单条消息最多处理几个附件 */
  maxPerMessage: number;
  /** 临时文件保留时长（小时，启动时清理更早的） */
  retentionHours: number;
  /** 落盘目录内最多保留多少个文件（超出删最旧） */
  maxFiles: number;
}

export interface QQBotConfig {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  allowlist: string[];
  markdownReply: boolean;
  streaming: boolean;
  toolProgress: boolean;
  approve: ApproveConfig;
  /** QQ 侧斜杠命令的路由开关（/reload、/new… 以及扩展命令透传） */
  commands: CommandConfig;
  /** 忙碌时的消息队列 */
  queue: QueueConfig;
  /** 任务进度摘要推送 */
  progress: ProgressConfig;
  /** 收到图片/语音/视频/文档/压缩包/普通文件时的落盘设置 */
  attachments: AttachmentConfig;
  /** 把本机文件发到 QQ */
  files: FilesConfig;
  /** 「以下对话来自远程用户」提醒与系统提示规则 */
  remote: RemoteConfig;
}

export interface FilesConfig {
  /** 是否允许把本机文件发到 QQ（关掉后工具与 /sendfile 都拒绝） */
  enabled: boolean;
  /** 单个文件上限（字节，默认 30MB；QQ 硬限 200MB） */
  maxBytes: number;
  /** 外发文件强制审批：true = 每次单独确认，不吃「以后都同意」/会话记忆；
   *  false（默认）= 按普通审批规则（在 approve.tools 里才问） */
  forceApproval: boolean;
}

/**
 * 配置里的一个 QQ bot。
 *
 * 除凭据外，所有字段都是「对全局默认值的逐键覆盖」——没写的就继承顶层
 * `queue` / `progress` / `approve` / `commands` / `sandbox` / `allowlist`。
 */
export interface QQBotsEntry {
  /** 展示名（日志、/status、抢占提示都用它）；缺省 = `bot-<appId 后 6 位>` */
  name?: string;
  appId: string;
  appSecret: string;
  sandbox?: boolean;
  allowlist?: string[];
  markdownReply?: boolean;
  streaming?: boolean;
  toolProgress?: boolean;
  approve?: Partial<ApproveConfig>;
  commands?: Partial<CommandConfig>;
  queue?: Partial<QueueConfig>;
  progress?: Partial<ProgressConfig>;
  attachments?: Partial<AttachmentConfig>;
  files?: Partial<FilesConfig>;
  remote?: Partial<RemoteConfig>;
}

/** 校验并归一化后的账号（凭据 + 合并好的完整配置） */
export interface QQBotAccount {
  name: string;
  appId: string;
  /** 该账号最终生效的配置：全局 defaults + 本账号覆盖 */
  config: QQBotConfig;
}

export interface LoadAccountsResult {
  accounts: QQBotAccount[];
  /** 配置错误：有错误时**不启动网关**，避免「机器人没反应又不知道为什么」 */
  errors: string[];
}

const DEFAULT_PROGRESS_MS = 15000;

const asObject = (value: unknown): any =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

function readFile(): any {
  try {
    return asObject(JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")));
  } catch {
    /* 文件不存在或非法不致命，凭据可完全来自环境变量 */
    return {};
  }
}

/** 缺省名字：`bot-<appId 后 6 位>`，方便在多 bot 场景里一眼分辨 */
export function defaultAccountName(appId: string): string {
  const tail = appId.replace(/[^0-9a-zA-Z]/g, "").slice(-6);
  return tail ? `bot-${tail}` : "default";
}

/** 全局 defaults（顶层字段）与账号覆盖合并成一份可直接用的配置 */
export function resolveConfig(
  file: any,
  entry: QQBotsEntry,
  fallback?: { appId: string; appSecret: string },
): QQBotConfig {
  const appId = entry.appId ?? fallback?.appId ?? "";
  const appSecret = entry.appSecret ?? fallback?.appSecret ?? "";
  const envInterval = process.env.PI_QQBOT_PROGRESS_MS;
  return {
    appId,
    appSecret,
    sandbox: entry.sandbox ?? file.sandbox ?? false,
    allowlist: entry.allowlist ?? file.allowlist ?? [],
    markdownReply: entry.markdownReply ?? file.markdownReply ?? false,
    streaming: entry.streaming ?? file.streaming ?? false,
    toolProgress: entry.toolProgress ?? file.toolProgress ?? false,
    approve: {
      tools: entry.approve?.tools ?? file.approve?.tools ?? ["bash", "powershell", "write", "edit"],
      remember: entry.approve?.remember ?? file.approve?.remember ?? true,
    },
    commands: {
      passthrough: entry.commands?.passthrough ?? file.commands?.passthrough ?? DEFAULT_COMMANDS.passthrough,
      allowReload: entry.commands?.allowReload ?? file.commands?.allowReload ?? DEFAULT_COMMANDS.allowReload,
      allowQuit: entry.commands?.allowQuit ?? file.commands?.allowQuit ?? DEFAULT_COMMANDS.allowQuit,
      allowUpdate: entry.commands?.allowUpdate ?? file.commands?.allowUpdate ?? DEFAULT_COMMANDS.allowUpdate,
      allowSession: entry.commands?.allowSession ?? file.commands?.allowSession ?? DEFAULT_COMMANDS.allowSession,
    },
    queue: {
      max: entry.queue?.max ?? file.queue?.max ?? DEFAULT_QUEUE_MAX,
      ack: entry.queue?.ack ?? file.queue?.ack ?? true,
    },
    progress: {
      enabled: entry.progress?.enabled ?? file.progress?.enabled ?? true,
      intervalMs: Number(
        envInterval ?? entry.progress?.intervalMs ?? file.progress?.intervalMs ?? DEFAULT_PROGRESS_MS,
      ),
    },
    attachments: {
      enabled: entry.attachments?.enabled ?? file.attachments?.enabled ?? true,
      dir: String(entry.attachments?.dir ?? file.attachments?.dir ?? "").trim(),
      maxBytes: Number(
        entry.attachments?.maxBytes ?? file.attachments?.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
      ),
      maxPerMessage: Number(
        entry.attachments?.maxPerMessage ?? file.attachments?.maxPerMessage ?? DEFAULT_ATTACHMENT_MAX_PER_MESSAGE,
      ),
      retentionHours: Number(
        entry.attachments?.retentionHours ?? file.attachments?.retentionHours ?? DEFAULT_ATTACHMENT_RETENTION_HOURS,
      ),
      maxFiles: Number(entry.attachments?.maxFiles ?? file.attachments?.maxFiles ?? DEFAULT_ATTACHMENT_MAX_FILES),
    },
    files: {
      enabled: entry.files?.enabled ?? file.files?.enabled ?? true,
      maxBytes: Number(entry.files?.maxBytes ?? file.files?.maxBytes ?? DEFAULT_SEND_MAX_BYTES),
      forceApproval: entry.files?.forceApproval ?? file.files?.forceApproval ?? false,
    },
    remote: {
      notice: entry.remote?.notice ?? file.remote?.notice ?? DEFAULT_REMOTE.notice,
      guidelines: entry.remote?.guidelines ?? file.remote?.guidelines ?? DEFAULT_REMOTE.guidelines,
      extra: String(entry.remote?.extra ?? file.remote?.extra ?? DEFAULT_REMOTE.extra).trim(),
    },
  };
}

/**
 * 读配置，返回**按配置顺序**排好的账号列表。
 *
 * 支持两种格式：
 * - v2 多 bot：`{ "qqbots": [ { "name": "work", "appId": … }, … ], "queue": {…}, … }`
 * - v1 单 bot：`{ "appId": …, "appSecret": …, … }`（或全部来自 `PI_QQBOT_APPID/SECRET`），
 *   等价于只有一个名叫 `default` 的账号，行为与 1.x 完全一致。
 */
export function loadAccounts(): LoadAccountsResult {
  const file = readFile();
  const errors: string[] = [];
  // 自带 PI_ 前缀；QQ_BOT_APPID/SECRET 是 2.7.0 及以前的旧名字，作为弃用别名保留（只在本变量未设时生效）
  const envAppId = process.env.PI_QQBOT_APPID ?? process.env.QQ_BOT_APPID;
  const envAppSecret = process.env.PI_QQBOT_APPSECRET ?? process.env.QQ_BOT_APPSECRET;

  let entries: QQBotsEntry[];
  if (Array.isArray(file.qqbots)) {
    if (file.appId) {
      errors.push("配置里同时出现顶层 appId 和 qqbots 数组：请只保留一种格式（多 bot 请写进 qqbots）");
      return { accounts: [], errors };
    }
    entries = file.qqbots.map((item: any) => asObject(item));
    if (entries.length === 0) {
      errors.push("qqbots 是空数组：至少配置一个 bot，否则插件不会接入 QQ");
      return { accounts: [], errors };
    }
  } else if (file.appId || envAppId) {
    entries = [
      {
        name: "default",
        appId: envAppId ?? file.appId,
        appSecret: envAppSecret ?? file.appSecret,
      },
    ];
  } else {
    return { accounts: [], errors };
  }

  const accounts: QQBotAccount[] = [];
  const seenNames = new Set<string>();
  const seenAppIds = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const raw = asObject(entries[index]);
    const appId = String(raw.appId ?? "").trim();
    const appSecret = String(raw.appSecret ?? "").trim();
    const label = `qqbots[${index}]${raw.name ? `(name=${raw.name})` : ""}`;
    if (!appId || !appSecret) {
      // 单个账号缺凭据只跳过它，别让整个插件都起不来
      errors.push(`${label} 缺少 appId 或 appSecret，已跳过`);
      continue;
    }
    if (seenAppIds.has(appId)) {
      errors.push(`${label} 的 appId ${appId} 重复，已跳过（否则会双连接被平台踢）`);
      continue;
    }
    const name = String(raw.name ?? defaultAccountName(appId)).trim() || defaultAccountName(appId);
    if (seenNames.has(name)) {
      errors.push(`${label} 的 name "${name}" 与其他 bot 重复，已跳过（改名后重试）`);
      continue;
    }
    seenAppIds.add(appId);
    seenNames.add(name);
    accounts.push({ name, appId, config: resolveConfig(file, raw) });
  }

  return { accounts, errors };
}

/** 兼容旧调用：只取第一个账号的配置（1.x 单 bot 语义） */
export function loadConfig(): QQBotConfig | null {
  const { accounts } = loadAccounts();
  return accounts[0]?.config ?? null;
}

/** 环境变量指定的账号名（调试/测试用：钉住某个 bot，不参与自动抢占） */
export function pinnedAccountName(): string | null {
  const name = process.env.PI_QQBOT_ACCOUNT?.trim();
  return name ? name : null;
}
