import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InstanceLock, StateStore, createEmptyState, repairState } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import {
  SCHEMA_VERSION,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
  SESSION_TRAIL_ITEMS,
} from "../src/constants.ts";
import { cleanup, temporaryDirectory, transcriptMeta } from "./helpers.ts";

const directories: string[] = [];
function directory(): string {
  const value = temporaryDirectory();
  directories.push(value);
  return value;
}
afterEach(() => directories.splice(0).forEach(cleanup));

describe("durable state", () => {
  test("creates a private atomic state file", async () => {
    const root = directory();
    const store = new StateStore(root);
    await store.update((state) => { state.engine = "codex"; state.offsets.example = { path: "example", provider: "codex", sessionId: "s", offset: 9, mtimeMs: 1, cooldownUntil: 2 }; });
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.statePath, "utf8")).offsets.example.offset).toBe(9);
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBeFalse();
  });

  test("serializes concurrent writers without losing updates", async () => {
    const store = new StateStore(directory());
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((state) => {
      state.offsets[`p${index}`] = { path: `p${index}`, provider: "claude", sessionId: `s${index}`, offset: index, mtimeMs: index, cooldownUntil: 0 };
    })));
    expect(Object.keys(store.snapshot().offsets)).toHaveLength(20);
    expect(store.snapshot().revision).toBe(20);
  });

  test("quarantines malformed JSON and restarts empty", () => {
    const root = directory();
    writeFileSync(join(root, "state.json"), "{broken");
    const store = new StateStore(root);
    expect(store.snapshot().roots).toEqual([]);
    expect(readdirSync(root).some((name) => name.startsWith("state.json.corrupt-"))).toBeTrue();
  });

  test("repairs dangling edges, cycles, and bad cursors", () => {
    const raw = createEmptyState();
    const at = new Date().toISOString();
    raw.nodes.a = { id: "a", label: "A", type: "goal", state: "active", parent: null, children: ["a", "b", "missing"], createdAt: at, updatedAt: at };
    raw.nodes.b = { id: "b", label: "B", type: "task", state: "active", parent: "a", children: ["a"], createdAt: at, updatedAt: at };
    raw.roots = ["a"];
    raw.sessions.s = {
      id: "s", provider: "claude", path: "p", cwd: "", title: "t", lastUser: "", mainline: "A", rootId: "a", cursor: "missing",
      ask: { kind: "none", hint: "" }, snapshot: { summary: "测试会话", progress: "检查修复", trail: [], at },
      status: "unknown", terminalOpen: false, lastTranscriptAt: at, lastStatusAt: at, updatedAt: at,
    };
    const result = repairState(raw);
    expect(result.repaired).toBeTrue();
    expect(result.state.nodes.a?.children).toEqual(["b"]);
    expect(result.state.nodes.b?.children).toEqual([]);
    expect(result.state.sessions.s?.cursor).toBe("a");
  });

  test("migrates old sessions into bounded revisable snapshots", () => {
    const at = new Date().toISOString();
    const raw = createEmptyState();
    raw.schemaVersion = 1;
    raw.sessions.legacy = {
      id: "legacy", provider: "claude", path: "p", cwd: "", title: "旧版完整会话标题", lastUser: "", mainline: null, rootId: null, cursor: null,
      ask: { kind: "none", hint: "" },
      // Deliberately remove the v2 projection to simulate an on-disk v1 record.
      snapshot: undefined,
      summary: "旧版摘要",
      progress: "旧版进展",
      status: "unknown", terminalOpen: false, lastTranscriptAt: at, lastStatusAt: at, updatedAt: at,
    } as never;
    const result = repairState(raw, at);
    expect(result.repaired).toBeTrue();
    expect(result.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.state.sessions.legacy?.snapshot).toEqual({
      summary: "旧版摘要",
      progress: "旧版进展",
      trail: [],
      at,
    });
  });

  test("preserves colliding root objects under distinct canonical names", () => {
    const at = new Date().toISOString();
    const raw = createEmptyState();
    raw.nodes.a = { id: "a", label: "same", type: "goal", state: "active", parent: null, children: [], createdAt: at, updatedAt: at };
    raw.nodes.b = { id: "b", label: "same", type: "goal", state: "active", parent: null, children: [], createdAt: at, updatedAt: at };
    raw.roots = ["a", "b"];
    const state = repairState(raw).state;
    expect(state.roots).toHaveLength(2);
    expect(new Set(state.roots.map((id) => state.nodes[id]?.label)).size).toBe(2);
  });

  test("singleton lock rejects a second live owner and recovers stale locks", () => {
    const root = directory();
    const first = new InstanceLock(root);
    first.acquire();
    expect(() => new InstanceLock(root).acquire()).toThrow("already running");
    first.release();
    const stale = join(root, ".instance.lock");
    new InstanceLock(root); // ensure constructor itself has no side effect
    writeFileSync(stale, JSON.stringify({ pid: 999_999_999 }));
    const recovered = new InstanceLock(root);
    recovered.acquire();
    expect(existsSync(recovered.path)).toBeTrue();
    recovered.release();
  });
});

describe("tree write boundary", () => {
  test("allocates ids and grows inside the assigned mainline", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const result = await runtime.applyRoll(transcriptMeta("s1", process.cwd()), {
      mainline: "  Release   SessionMap ", ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "task", label: "完成原子状态写入" }],
    });
    const state = store.snapshot();
    expect(result.mainline).toBe("Release SessionMap");
    expect(result.accepted).toBe(1);
    expect(state.nodes[result.rootId]?.children).toHaveLength(1);
    expect(state.sessions.s1?.cursor).toBe(state.nodes[result.rootId]?.children[0]);
  });

  test("accepts the assigned mainline name as a root reference but rejects another name", async () => {
    const store = new StateStore(directory());
    const result = await new TreeRuntime(store).applyRoll(transcriptMeta("s1", process.cwd()), {
      mainline: "Exact Work Object",
      ask: { kind: "none", hint: "" },
      ops: [
        { op: "grow", parent: "Exact Work Object", type: "finding", label: "真实模型根引用" },
        { op: "grow", parent: "Some Other Work", type: "finding", label: "越界引用" },
      ],
    });
    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(store.snapshot().nodes[result.rootId]?.children).toHaveLength(1);
  });

  test("rejects operations against another mainline", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("a", process.cwd()), { mainline: "A", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "task", label: "A节点" }] });
    await runtime.applyRoll(transcriptMeta("b", process.cwd()), { mainline: "B", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "task", label: "B节点" }] });
    const foreign = store.snapshot().sessions.b!.cursor!;
    const result = await runtime.applyRoll(transcriptMeta("a", process.cwd()), { mainline: "A", ask: { kind: "none", hint: "" }, ops: [{ op: "close", node: foreign, state: "dead", note: "越权" }] });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]).toContain("outside");
    expect(store.snapshot().nodes[foreign]?.state).toBe("active");
  });

  test("makes a reattach round read-only for existing nodes", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("moving", process.cwd()), { mainline: "Old", ask: { kind: "none", hint: "" }, ops: [] });
    const newLine = await runtime.applyRoll(transcriptMeta("owner", process.cwd()), { mainline: "New", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "task", label: "已有节点" }] });
    const existing = store.snapshot().nodes[newLine.rootId]!.children[0]!;
    const result = await runtime.applyRoll(transcriptMeta("moving", process.cwd()), {
      mainline: "New", ask: { kind: "none", hint: "" },
      ops: [{ op: "close", node: existing, state: "dead" }, { op: "grow", parent: "mainline", type: "task", label: "新接续方向" }],
    });
    expect(result.reattached).toBeTrue();
    expect(result.accepted).toBe(1);
    expect(result.rejected[0]).toContain("reattach");
    expect(store.snapshot().nodes[existing]?.state).toBe("active");
  });

  test("rejects root rename and enforces the six-op ceiling", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const first = await runtime.applyRoll(transcriptMeta("s", process.cwd()), { mainline: "Stable", ask: { kind: "none", hint: "" }, ops: [] });
    const result = await runtime.applyRoll(transcriptMeta("s", process.cwd()), {
      mainline: "Stable", ask: { kind: "none", hint: "" },
      ops: [
        { op: "rename", node: first.rootId, label: "Broken" },
        ...Array.from({ length: 6 }, (_, index) => ({ op: "grow", parent: "mainline", type: "note", label: `节点${index}` })),
      ],
    });
    expect(result.accepted).toBe(5);
    expect(result.rejected.some((value) => value.includes("roots cannot"))).toBeTrue();
    expect(result.rejected.some((value) => value.includes("runtime limit"))).toBeTrue();
    expect(store.snapshot().nodes[first.rootId]?.label).toBe("Stable");
  });

  test("archive is reversible and never deletes the object", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const line = await runtime.applyRoll(transcriptMeta("s", process.cwd()), { mainline: "Memory", ask: { kind: "none", hint: "" }, ops: [] });
    await runtime.archive(line.rootId);
    expect(store.snapshot().archived).toContain(line.rootId);
    expect(store.snapshot().nodes[line.rootId]).toBeDefined();
    await runtime.restore(line.rootId);
    expect(store.snapshot().archived).not.toContain(line.rootId);
  });

  test("closed nodes keep their recorded labels", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("closed-label", process.cwd());
    await runtime.applyRoll(meta, {
      mainline: "保留历史措辞",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "旧假设" }],
    });
    const node = store.snapshot().sessions["closed-label"]!.cursor!;
    await runtime.applyRoll(meta, {
      mainline: "保留历史措辞",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "close", node, state: "dead", note: "证据推翻" }],
    });
    const result = await runtime.applyRoll(meta, {
      mainline: "保留历史措辞",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "rename", node, label: "无痕改写" }],
    });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]).toContain("recorded label");
    expect(store.snapshot().nodes[node]?.label).toBe("旧假设");
  });

  test("requires a reason before closing a direction", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("close-reason", process.cwd());
    await runtime.applyRoll(meta, {
      mainline: "保留关闭原因",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "待验证方向" }],
    });
    const node = store.snapshot().sessions["close-reason"]!.cursor!;
    const result = await runtime.applyRoll(meta, {
      mainline: "保留关闭原因",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "close", node, state: "dead" }],
    });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]).toContain("requires a note");
    expect(store.snapshot().nodes[node]?.state).toBe("active");
  });

  test("revises the reading snapshot while preserving the superseded path", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("revision", process.cwd());
    const first = await runtime.applyRoll(meta, {
      mainline: "修复音频路由",
      ask: { kind: "none", hint: "" },
      snapshot: {
        summary: "修复蓝牙静音",
        progress: "怀疑系统音量被重置",
        trail: ["静音只在重连后出现", "准备验证音量写入"],
      },
      ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "验证音量重置假设" }],
    });
    const oldPath = store.snapshot().sessions.revision!.cursor!;

    await runtime.applyRoll(meta, {
      mainline: "修复音频路由",
      ask: { kind: "review", hint: "审阅路由修复" },
      snapshot: {
        summary: "修复蓝牙路由恢复",
        progress: "音量假设已证伪，改查设备路由",
        trail: ["重连触发静音", "音量写入正常，旧假设被证伪", "当前验证设备路由恢复"],
      },
      ops: [
        { op: "close", node: oldPath, state: "dead", note: "日志证明音量写入正常" },
        { op: "grow", parent: "mainline", type: "attempt", label: "验证设备路由恢复" },
      ],
    });

    const state = store.snapshot();
    expect(state.sessions.revision?.snapshot.summary).toBe("修复蓝牙路由恢复");
    expect(state.sessions.revision?.snapshot.progress).toBe("音量假设已证伪，改查设备路由");
    expect(state.nodes[oldPath]?.state).toBe("dead");
    expect(state.nodes[oldPath]?.note).toBe("日志证明音量写入正常");
    expect(state.nodes[first.rootId]?.children).toHaveLength(2);
  });

  test("bounds every rolling snapshot field at the runtime boundary", async () => {
    const store = new StateStore(directory());
    await new TreeRuntime(store).applyRoll(transcriptMeta("bounded", process.cwd()), {
      mainline: "快照边界",
      ask: { kind: "none", hint: "" },
      snapshot: {
        summary: "主".repeat(SESSION_SUMMARY_CHARS + 10),
        progress: "进".repeat(SESSION_PROGRESS_CHARS + 10),
        trail: Array.from({ length: SESSION_TRAIL_ITEMS + 3 }, (_, index) => `${index}${"路".repeat(SESSION_TRAIL_ITEM_CHARS + 10)}`),
      },
      ops: [],
    });
    const snapshot = store.snapshot().sessions.bounded!.snapshot;
    expect(Array.from(snapshot.summary)).toHaveLength(SESSION_SUMMARY_CHARS);
    expect(Array.from(snapshot.progress)).toHaveLength(SESSION_PROGRESS_CHARS);
    expect(snapshot.trail).toHaveLength(SESSION_TRAIL_ITEMS);
    expect(snapshot.trail.every((item) => Array.from(item).length <= SESSION_TRAIL_ITEM_CHARS)).toBeTrue();
  });

  test("preserves closed outcomes and represents later reconsideration as a new path", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("reconsider", process.cwd());
    const line = await runtime.applyRoll(meta, {
      mainline: "选择存储方案",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "尝试事件数据库" }],
    });
    const old = store.snapshot().sessions.reconsider!.cursor!;
    await runtime.applyRoll(meta, {
      mainline: "选择存储方案",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "close", node: old, state: "dead", note: "首版维护成本过高" }],
    });
    const revised = await runtime.applyRoll(meta, {
      mainline: "选择存储方案",
      ask: { kind: "none", hint: "" },
      ops: [
        { op: "unblock", node: old },
        { op: "grow", parent: "mainline", type: "attempt", label: "规模扩大后重评事件库" },
      ],
    });
    const state = store.snapshot();
    expect(revised.accepted).toBe(1);
    expect(revised.rejected[0]).toContain("waiting");
    expect(state.nodes[old]?.state).toBe("dead");
    expect(state.nodes[old]?.note).toBe("首版维护成本过高");
    expect(state.nodes[line.rootId]?.children).toHaveLength(2);
  });
});
