import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSessionCount, buildNowItems } from "@sessionmap/core/render.ts";
import { repairState } from "@sessionmap/core/state-repair.ts";
import type { NowItem, TrailState } from "@sessionmap/core/types.ts";
import { relativeTime } from "@sessionmap/core/utils.ts";

export interface NowSnapshot {
  revision: number;
  updatedAt: string;
  activeSessions: number;
  items: NowItem[];
}

export function readNowSnapshot(directory: string, now = Date.now()): NowSnapshot | null {
  const path = join(directory, "state.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("SessionMap state is unreadable; run sessionmap status for recovery details");
  }
  // A short-lived CLI must never become another state writer. Reuse the
  // canonical repair projection in memory, but leave persistence to the Bun
  // service's single StateStore owner.
  const state: TrailState = repairState(parsed).state;
  return {
    revision: state.revision,
    updatedAt: state.updatedAt,
    activeSessions: activeSessionCount(state),
    items: buildNowItems(state, now),
  };
}

export function nowItemAt(snapshot: NowSnapshot, oneBasedIndex: number): NowItem {
  if (!Number.isInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > snapshot.items.length) {
    throw new Error(`jump index must be between 1 and ${Math.max(1, snapshot.items.length)}`);
  }
  const item = snapshot.items[oneBasedIndex - 1];
  if (!item) throw new Error("that Now item no longer exists");
  if (!item.sessionId) throw new Error("that Now item has no recoverable session entry");
  return item;
}

export function formatNow(snapshot: NowSnapshot | null, now = Date.now()): string {
  if (!snapshot) {
    return "SessionMap 还没有状态。运行 sessionmap install，或先让一个 agent session 产生结构变化。";
  }
  const lines = [
    snapshot.items.length
      ? `${snapshot.items.length} 件事现在值得看`
      : "现在没有需要你立即处理的事项",
  ];
  for (const [index, item] of snapshot.items.entries()) {
    lines.push("", `${index + 1}. ${item.label} · ${item.mainline}`);
    if (item.detail && item.detail !== item.mainline) lines.push(`   ${item.detail}`);
    lines.push(`   ${relativeTime(item.at, now)}${item.sessionId ? ` · sessionmap now --jump ${index + 1}` : ""}`);
  }
  lines.push(
    "",
    `运行中的 session：${snapshot.activeSessions} · 地图更新：${relativeTime(snapshot.updatedAt, now)}`,
    "完整地图：sessionmap open",
  );
  return lines.join("\n");
}
