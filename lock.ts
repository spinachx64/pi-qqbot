import fs from "node:fs";
import lockfile from "proper-lockfile";
import { LOCK_PATH, OWNER_PATH } from "./constants";

const LOCK_RETRY_MS = 5000; // 待命实例抢锁间隔
const LOCK_STALE_MS = 30000; // 锁文件超过 30 秒无心跳视为僵尸锁
const LOCK_UPDATE_MS = 10000; // 宿主每 10 秒心跳刷新锁
/**
 * 「临时释放」的预约窗口：本进程 `/reload`、`/new` 这类会话重建时，锁会先释放再重新抢。
 * 这段时间内别的进程不许来抢，否则同一台机器上的另一个 pi 会把 bot 抢走。
 */
export const DEFAULT_RESERVE_MS = 20000;

type Release = () => Promise<void>;

/** 一个 bot 当前/最后一位持有者的记录（放在锁旁边，进程退出后不删） */
export interface LockOwner {
  account: string;
  appId: string;
  pid: number;
  /** 持有者启动时的工作目录（换进程提示要用） */
  cwd: string;
  claimedAt: string;
  /** 仅「临时释放」时写：谁在重载 */
  releasedAt?: string;
  /** 临时释放的原因（reload/new/fork/resume） */
  releaseReason?: string;
  /** 预约到期时间（epoch ms）：到点前其他进程不得抢占 */
  reservedUntil?: number;
}

export interface ClaimCandidate {
  name: string;
  appId: string;
}

export interface Claim {
  name: string;
  appId: string;
  release: Release;
  /** 抢到之前的持有者记录（没有则 null） */
  previous: LockOwner | null;
  /** 是否「换进程接管」（previous.pid 存在且不是自己） */
  takeover: boolean;
  /** 是否是「自己临时释放后又拿回来」（/reload 场景，静默） */
  reclaimed: boolean;
}

export interface ClaimSkip {
  name: string;
  reason: "online" | "reserved" | "raced";
  /** reserved 时用于日志：谁在重载 */
  owner?: LockOwner;
}

export interface ClaimResult {
  claim?: Claim;
  skipped: ClaimSkip[];
}

/** 抢文件锁：成功返回 release 函数；被占/异常返回 null */
export async function tryAcquireLock(lockPath: string): Promise<Release | null> {
  try {
    const release = await lockfile.lock(lockPath, {
      retries: 0,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      realpath: false,
    });
    return release;
  } catch {
    return null;
  }
}

/** 抢锁+心跳刷新的组合：保持旧导出名，供单 bot 场景与测试使用 */
export function startLockRetry(lockPath: string, onAcquired: (release: Release) => void): () => void {
  const timer = setInterval(async () => {
    const release = await tryAcquireLock(lockPath);
    if (release) {
      clearInterval(timer);
      onAcquired(release);
    }
  }, LOCK_RETRY_MS);
  return () => clearInterval(timer);
}

export function readOwner(appId: string): LockOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(OWNER_PATH(appId), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      account: String(raw.account ?? ""),
      appId: String(raw.appId ?? appId),
      pid: Number(raw.pid ?? 0),
      cwd: String(raw.cwd ?? ""),
      claimedAt: String(raw.claimedAt ?? ""),
      releasedAt: raw.releasedAt ? String(raw.releasedAt) : undefined,
      releaseReason: raw.releaseReason ? String(raw.releaseReason) : undefined,
      reservedUntil: Number.isFinite(raw.reservedUntil) ? Number(raw.reservedUntil) : undefined,
    };
  } catch {
    return null;
  }
}

function writeOwner(appId: string, owner: LockOwner): void {
  try {
    fs.writeFileSync(OWNER_PATH(appId), JSON.stringify(owner, null, 2), "utf8");
  } catch {
    /* owner 记录只是观测量，写不进去不能影响接入 */
  }
}

/** 接入成功后落盘身份（同时清掉上一次的临时释放预约） */
export function recordClaim(input: { name: string; appId: string }, now = Date.now()): LockOwner {
  const owner: LockOwner = {
    account: input.name,
    appId: input.appId,
    pid: process.pid,
    cwd: process.cwd(),
    claimedAt: new Date(now).toISOString(),
  };
  writeOwner(input.appId, owner);
  return owner;
}

/**
 * 「我要暂时放开，别来抢」：给其他进程留下预约窗口。
 * 只在会话重建（reload/new/fork/resume）时调用；真正退出（quit/崩溃）什么都不写，
 * 让别人立刻能接管。
 */
export function reserveBeforeRelease(
  input: { name: string; appId: string },
  reason: string,
  now = Date.now(),
  reserveMs = DEFAULT_RESERVE_MS,
): LockOwner | null {
  const prev = readOwner(input.appId);
  const owner: LockOwner = {
    account: input.name,
    appId: input.appId,
    pid: process.pid,
    cwd: process.cwd(),
    claimedAt: prev?.claimedAt ?? new Date(now).toISOString(),
    releasedAt: new Date(now).toISOString(),
    releaseReason: reason,
    reservedUntil: now + reserveMs,
  };
  writeOwner(input.appId, owner);
  return owner;
}

/** 该 bot 此刻是否被别人预约着（临时释放窗口内） */
function reservedByOther(owner: LockOwner | null, now: number): boolean {
  if (!owner?.reservedUntil) return false;
  if (owner.pid === process.pid) return false; // 自己 reload：拿回来即可，不算抢占
  return owner.reservedUntil > now;
}

/**
 * 按顺序抢占：跳过「别人正在重载」和「已在线」的 bot，抢到第一个可用就返回。
 *
 * 抢到之后会再读一次 owner 记录——如果刚好在抢锁瞬间别人贴了预约，
 * 立刻把锁放掉（关掉竞态窗口），换下一个候选。
 */
export async function claimAny(
  candidates: ClaimCandidate[],
  options: { preferredAppId?: string | null; now?: number } = {},
): Promise<ClaimResult> {
  const skipped: ClaimSkip[] = [];
  const ordered = [...candidates];
  if (options.preferredAppId) {
    const index = ordered.findIndex((c) => c.appId === options.preferredAppId);
    if (index > 0) ordered.unshift(...ordered.splice(index, 1));
  }

  for (const candidate of ordered) {
    const now = options.now ?? Date.now();
    const before = readOwner(candidate.appId);
    if (reservedByOther(before, now)) {
      skipped.push({ name: candidate.name, reason: "reserved", owner: before ?? undefined });
      continue;
    }
    const release = await tryAcquireLock(LOCK_PATH(candidate.appId));
    if (!release) {
      skipped.push({ name: candidate.name, reason: "online" });
      continue;
    }
    const raced = readOwner(candidate.appId);
    if (reservedByOther(raced, options.now ?? Date.now())) {
      // 抢锁和别人的「临时释放」撞在一起了：让出去，别抢别人 reload 中的 bot
      await release().catch(() => {});
      skipped.push({ name: candidate.name, reason: "raced", owner: raced ?? undefined });
      continue;
    }
    recordClaim({ name: candidate.name, appId: candidate.appId }, now);
    const previous = before;
    const takeover = !!previous && previous.pid !== process.pid && previous.pid !== 0;
    const reclaimed = !!previous && previous.pid === process.pid;
    return {
      claim: { name: candidate.name, appId: candidate.appId, release, previous, takeover, reclaimed },
      skipped,
    };
  }
  return { skipped };
}

/**
 * 待命：每 5 秒重扫一遍候选。
 *
 * 注意「全上线了就忽略」= 本进程不接入、但持续重扫——否则别人退出后没人接管，
 * 「同账号换进程要提示」这条需求永远触发不到。
 */
export function startClaimRetry(
  getCandidates: () => ClaimCandidate[],
  onClaim: (claim: Claim) => void,
  options: { preferredAppId?: string | null; intervalMs?: number; maxAttempts?: number } = {},
): () => void {
  let attempts = 0;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    attempts += 1;
    const result = await claimAny(getCandidates(), { preferredAppId: options.preferredAppId });
    if (result.claim) {
      clearInterval(timer);
      onClaim(result.claim);
      return;
    }
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) clearInterval(timer);
  }, options.intervalMs ?? LOCK_RETRY_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
