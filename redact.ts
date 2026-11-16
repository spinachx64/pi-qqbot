/**
 * 敏感信息脱敏。
 *
 * 所有要「离开本地」或「落盘」的文本都应该先过这里：
 *   - 发到 QQ 的消息（进度摘要、审批提示、队列预览）
 *   - pi-qqbot.log
 *
 * 原则：
 *   1. 认得出的凭据一律替换成 `***`（保留键名，方便排错）
 *   2. 不碰正常内容（路径、命令、中文句子、git sha、UUID）
 *   3. 幂等：对已脱敏文本再跑一次不会再变形
 */

/** PEM 私钥 / 证书块：整块替换 */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g;

/** `Authorization: Bearer xxx` / `QQBot xxx` / `Bot xxx` / `Token xxx` */
const AUTH_HEADER =
  /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token|qqbot|bot|digest)\s+)?[^\s"',;]{6,}/gi;

/** URL 里的 user:password@host */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

/** 敏感的键名（键值对 / JSON / 查询参数 / --flag） */
const SENSITIVE_KEYS = [
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth[_-]?token',
  'api[_-]?key',
  'apikey',
  'x-api-key',
  'client[_-]?id',
  'client[_-]?secret',
  'app[_-]?secret',
  'appsecret',
  'secret[_-]?key',
  'private[_-]?key',
  'session[_-]?id',
  'sessionid',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'credentials?',
  'authorization',
  'cookie',
  'set-cookie',
  'signature',
  'sign',
  'nonce',
  'ticket',
  'secret',
].join('|');

/** `key=value` / `"key": "value"` / `key: value`（值两侧的引号一并吃掉） */
const KEY_VALUE = new RegExp(
  `((?<![A-Za-z0-9_])(?:${SENSITIVE_KEYS})(?:["']?\\s*[:=]\\s*["']?))(?!\\*\\*\\*)[^\\s"',;&]{3,}`,
  'gi',
);

/** 命令行形式：`--token xxx` / `--api-key xxx`（只认带短横线的 flag，避免误伤普通词） */
const FLAG_VALUE = new RegExp(
  `((?:^|\\s)--?(?:access-token|api-key|apikey|token|auth-token|client-secret|secret|password|passwd|pwd)\\s+["']?)(?!\\*\\*\\*)[^\\s"',;&]{3,}`,
  'gi',
);

/** 中文键名 */
const CN_KEY_VALUE = /((?:密码|密钥|秘钥|令牌|凭证|口令)\s*[:：=]\s*)(?!\*{3})\S+/g;

/** 已知凭据格式 */
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_***'],
  [/\bpypi-[A-Za-z0-9_-]{20,}/g, 'pypi-***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-***'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, 'sk_live_***'],
  [/\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'SG.***'],
  [/\bROBOT1\.0_[A-Za-z0-9._!-]{10,}/g, 'ROBOT1.0_***'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, 'eyJ*** (JWT)'],
];

/**
 * 兜底：超长高熵串（≥44 字符且同时含大小写与数字）。
 * 刻意放过纯小写十六进制（git sha / md5）与带连字符的 UUID，避免把正常内容打码。
 */
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9+/=_-]{44,}\b)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9+/=_-]{44,}\b/g;

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(PEM_BLOCK, '<已隐藏的私钥/证书>');
  out = out.replace(AUTH_HEADER, '$1***');
  out = out.replace(URL_USERINFO, '$1***:***@');
  out = out.replace(KEY_VALUE, '$1***');
  out = out.replace(FLAG_VALUE, '$1***');
  out = out.replace(CN_KEY_VALUE, '$1***');
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement);
  out = out.replace(HIGH_ENTROPY, '***');
  return out;
}

/** 递归脱敏：字符串值处理，数组/对象继续下钻，其余原样 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /pass|secret|token|key|credential|cookie|auth|sig/i.test(key)
        ? typeof item === 'string'
          ? '***'
          : '***'
        : redactDeep(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** 单行化 + 脱敏 + 截断（用于 QQ 消息里的参数摘要） */
export function shortRedacted(value: unknown, limit = 60): string {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = redactSecrets(flat);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}
