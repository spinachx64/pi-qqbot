import { PASSIVE_WINDOW_MS } from "../constants";

/** Internal conversation key; never pass the group: prefix to QQ's API. */
export function groupTarget(groupOpenid: string): string {
  if (!groupOpenid) throw new Error("Missing group_openid");
  return `group:${groupOpenid}`;
}

export function isGroupTarget(target: string): boolean {
  return target.startsWith("group:");
}

export function targetPath(target: string): string {
  const group = isGroupTarget(target);
  const id = group ? target.slice(6) : target;
  if (!id) throw new Error("Missing QQ conversation target");
  return `/v2/${group ? "groups" : "users"}/${encodeURIComponent(id)}`;
}

export function passiveWindowMs(target: string): number {
  return isGroupTarget(target) ? 5 * 60 * 1000 : PASSIVE_WINDOW_MS;
}
