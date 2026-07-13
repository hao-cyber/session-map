import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InstanceLock, StateStore, createEmptyState, repairState } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
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
      ask: { kind: "none", hint: "" }, status: "unknown", terminalOpen: false, lastTranscriptAt: at, lastStatusAt: at, updatedAt: at,
    };
    const result = repairState(raw);
    expect(result.repaired).toBeTrue();
    expect(result.state.nodes.a?.children).toEqual(["b"]);
    expect(result.state.nodes.b?.children).toEqual([]);
    expect(result.state.sessions.s?.cursor).toBe("a");
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
      mainline: "  Release   Maintrail ", ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "task", label: "完成原子状态写入" }],
    });
    const state = store.snapshot();
    expect(result.mainline).toBe("Release Maintrail");
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
});
