import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyState } from "@sessionmap/core/state-repair.ts";
import { formatNow, nowItemAt, readNowSnapshot } from "@sessionmap/runtime/now.ts";
import { sessionRecord, temporaryDirectory } from "./helpers.ts";

describe("terminal Now projection", () => {
  test("reads the same priority projection without writing state", () => {
    const root = temporaryDirectory();
    const state = createEmptyState("claude", "2026-07-20T00:00:00.000Z");
    const rootId = "root:release";
    state.nodes[rootId] = {
      id: rootId,
      label: "发布 SessionMap",
      type: "goal",
      state: "active",
      parent: null,
      children: [],
      createdAt: state.createdAt,
      updatedAt: state.createdAt,
    };
    state.roots.push(rootId);
    state.mainlineIndex["发布 SessionMap"] = rootId;
    const session = sessionRecord("release-session", root);
    session.rootId = rootId;
    session.mainline = "发布 SessionMap";
    session.cursor = rootId;
    session.ask = { kind: "decision", hint: "选择发布方式" };
    session.status = "busy";
    session.terminalOpen = true;
    state.sessions[session.id] = session;
    mkdirSync(root, { recursive: true });
    const path = join(root, "state.json");
    writeFileSync(path, `${JSON.stringify(state)}\n`);

    const before = Bun.file(path).size;
    const snapshot = readNowSnapshot(root, Date.parse("2026-07-20T00:01:00.000Z"));
    expect(snapshot?.items[0]).toMatchObject({
      label: "等拍板",
      mainline: "发布 SessionMap",
      detail: "选择发布方式",
      sessionId: "release-session",
    });
    expect(snapshot?.activeSessions).toBe(1);
    expect(Bun.file(path).size).toBe(before);
    expect(formatNow(snapshot, Date.parse("2026-07-20T00:01:00.000Z"))).toContain("sessionmap now --jump 1");
    expect(nowItemAt(snapshot!, 1).sessionId).toBe("release-session");
    expect(() => nowItemAt(snapshot!, 2)).toThrow("between 1 and 1");
  });

  test("handles missing and empty state without inventing work", () => {
    expect(readNowSnapshot(temporaryDirectory())).toBeNull();
    expect(formatNow(null)).toContain("还没有状态");
    const root = temporaryDirectory();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "state.json"), `${JSON.stringify(createEmptyState())}\n`);
    expect(formatNow(readNowSnapshot(root))).toContain("没有需要你立即处理");
  });
});
