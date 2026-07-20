import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StateStore } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import type { RollOutput, TranscriptMeta } from "../src/types.ts";
import { discoverTranscripts, TranscriptWatcher, type TranscriptFile } from "../src/watcher.ts";
import { sleep } from "../src/utils.ts";
import { cleanup, temporaryDirectory, transcriptMeta, writeJsonLines } from "./helpers.ts";

const directories: string[] = [];
function setup(): { root: string; path: string; source: () => TranscriptFile[]; store: StateStore } {
  const root = temporaryDirectory();
  directories.push(root);
  const path = join(root, "source.jsonl");
  writeJsonLines(path, [{ type: "user", sessionId: "watcher-session", cwd: root, message: { role: "user", content: "建立新的结构节点" } }]);
  const source = (): TranscriptFile[] => [{ path, provider: "claude", size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }];
  return { root, path, source, store: new StateStore(join(root, "state")) };
}
afterEach(() => directories.splice(0).forEach(cleanup));

async function allowExistingTranscriptConsumption(store: StateStore): Promise<void> {
  await store.update((state) => { state.intake.phase = "complete"; });
}

describe("watcher delivery semantics", () => {
  test("waits for a fresh user's history choice without consuming existing transcripts", async () => {
    const fixture = setup();
    let calls = 0;
    const watcher = new TranscriptWatcher(fixture.store, new TreeRuntime(fixture.store), fixture.root, undefined, async () => {
      calls += 1;
      return { mainline: "Unexpected", ask: { kind: "none", hint: "" }, ops: [] };
    }, fixture.source);

    await watcher.once();

    expect(calls).toBe(0);
    expect(fixture.store.snapshot().intake.phase).toBe("awaiting-choice");
    expect(fixture.store.snapshot().offsets).toEqual({});
    expect(watcher.intakeView().inventory.ranges.find((range) => range.days === 30)?.sessions).toBe(1);
  });

  test("skip history establishes a high-water mark and then consumes only new activity", async () => {
    const fixture = setup();
    const prompts: string[] = [];
    const watcher = new TranscriptWatcher(fixture.store, new TreeRuntime(fixture.store), fixture.root, undefined, async (_engine, prompt) => {
      prompts.push(prompt);
      return { mainline: "Live only", ask: { kind: "none", hint: "" }, ops: [] };
    }, fixture.source);

    await watcher.chooseHistory(null);
    expect(fixture.store.snapshot().offsets[fixture.path]?.offset).toBe(statSync(fixture.path).size);
    appendFileSync(fixture.path, `${JSON.stringify({ type: "user", sessionId: "watcher-session", cwd: fixture.root, message: { role: "user", content: "安装后的新进展" } })}\n`);
    await watcher.once();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("安装后的新进展");
    expect(prompts[0]).not.toContain("建立新的结构节点");
  });

  test("imports only the selected history range and extends it without replaying imports", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const recentPath = join(root, "recent.jsonl");
    const oldPath = join(root, "old.jsonl");
    writeJsonLines(recentPath, [{ type: "user", sessionId: "recent", cwd: root, message: { role: "user", content: "近期工作" } }]);
    writeJsonLines(oldPath, [{ type: "user", sessionId: "old", cwd: root, message: { role: "user", content: "更早工作" } }]);
    const now = Date.now();
    const recentTime = new Date(now - 5 * 86_400_000);
    const oldTime = new Date(now - 60 * 86_400_000);
    utimesSync(recentPath, recentTime, recentTime);
    utimesSync(oldPath, oldTime, oldTime);
    const source = (): TranscriptFile[] => [recentPath, oldPath].map((path) => {
      const stat = statSync(path);
      return { path, provider: "claude" as const, sessionId: path === recentPath ? "recent" : "old", size: stat.size, mtimeMs: stat.mtimeMs };
    });
    const store = new StateStore(join(root, "state"));
    const prompts: string[] = [];
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async (_engine, prompt) => {
      prompts.push(prompt);
      return { mainline: `History ${prompts.length}`, ask: { kind: "none", hint: "" }, ops: [] };
    }, source);

    await watcher.chooseHistory(new Date(now - 30 * 86_400_000).toISOString());
    await watcher.once();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("近期工作");
    expect(prompts[0]).toContain("HISTORICAL IMPORT");
    expect(store.snapshot().intake.imported["claude:recent"]).toBeString();
    expect(store.snapshot().intake.imported["claude:old"]).toBeUndefined();

    await watcher.chooseHistory(new Date(now - 90 * 86_400_000).toISOString());
    await watcher.once();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("更早工作");
    expect(prompts[1]!.split("FILTERED TRANSCRIPT INCREMENT")[1]).not.toContain("近期工作");
    expect(store.snapshot().intake.phase).toBe("complete");
    expect(watcher.intakeView().inventory.ranges.find((range) => range.days === 90)?.sessions).toBe(0);
  });

  test("pauses a failed history item and resumes it from its durable cursor", async () => {
    const fixture = setup();
    let calls = 0;
    const watcher = new TranscriptWatcher(fixture.store, new TreeRuntime(fixture.store), fixture.root, undefined, async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary model failure");
      return { mainline: "Recovered history", ask: { kind: "none", hint: "" }, ops: [] };
    }, fixture.source);

    await watcher.chooseHistory(new Date(Date.now() - 30 * 86_400_000).toISOString());
    await watcher.once();
    expect(fixture.store.snapshot().intake.job?.status).toBe("paused");
    expect(Object.values(fixture.store.snapshot().intake.job!.items)[0]?.cursor).toBe(0);

    await watcher.resumeHistory();
    await watcher.once();
    expect(calls).toBe(2);
    expect(fixture.store.snapshot().intake.phase).toBe("complete");
    expect(fixture.store.snapshot().intake.job?.status).toBe("complete");
  });

  test("cancelling an in-flight history roll keeps its late model result out of the tree", async () => {
    const fixture = setup();
    let signalStarted!: () => void;
    let releaseRoll!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRoll = resolve; });
    const watcher = new TranscriptWatcher(fixture.store, new TreeRuntime(fixture.store), fixture.root, undefined, async () => {
      signalStarted();
      await release;
      return { mainline: "Cancelled", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "note", label: "不应出现" }] };
    }, fixture.source);

    await watcher.chooseHistory(new Date(Date.now() - 30 * 86_400_000).toISOString());
    await started;
    await watcher.cancelHistory();
    releaseRoll();
    await watcher.once();

    expect(fixture.store.snapshot().intake.job?.status).toBe("cancelled");
    expect(fixture.store.snapshot().roots).toEqual([]);
  });

  test("rolls different historical sessions in parallel with a fixed bound", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const paths = ["one", "two", "three"].map((id) => {
      const path = join(root, `${id}.jsonl`);
      writeJsonLines(path, [{ type: "user", sessionId: id, cwd: root, message: { role: "user", content: `history-${id}` } }]);
      return path;
    });
    const source = (): TranscriptFile[] => paths.map((path) => ({
      path,
      provider: "claude",
      sessionId: path.slice(path.lastIndexOf("/") + 1, -6),
      size: statSync(path).size,
      mtimeMs: statSync(path).mtimeMs,
    }));
    const store = new StateStore(join(root, "state"));
    let active = 0;
    let peak = 0;
    let started = 0;
    let signalTwo!: () => void;
    let release!: () => void;
    const twoStarted = new Promise<void>((resolve) => { signalTwo = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async () => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      if (started === 2) signalTwo();
      if (started <= 2) await gate;
      active -= 1;
      return { mainline: "Shared history", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);

    await watcher.chooseHistory(new Date(Date.now() - 30 * 86_400_000).toISOString());
    await twoStarted;
    expect(peak).toBe(2);
    release();
    await watcher.once();

    expect(store.snapshot().intake.job?.status).toBe("complete");
    expect(Object.keys(store.snapshot().intake.imported)).toHaveLength(3);
  });

  test("keeps a roll slot available for live work during history backfill", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const historyPaths = ["history-a", "history-b"].map((id) => {
      const path = join(root, `${id}.jsonl`);
      writeJsonLines(path, [{ type: "user", sessionId: id, cwd: root, message: { role: "user", content: id } }]);
      return path;
    });
    const livePath = join(root, "live.jsonl");
    let includeLive = false;
    const source = (): TranscriptFile[] => [...historyPaths, ...(includeLive ? [livePath] : [])].map((path) => {
      const id = path.slice(path.lastIndexOf("/") + 1, -6);
      return { path, provider: "claude" as const, sessionId: id, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
    });
    const store = new StateStore(join(root, "state"));
    let historyStarted = 0;
    let releaseHistory!: () => void;
    let signalHistory!: () => void;
    let signalLive!: () => void;
    const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const bothHistoryStarted = new Promise<void>((resolve) => { signalHistory = resolve; });
    const liveStarted = new Promise<void>((resolve) => { signalLive = resolve; });
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async (_engine, prompt) => {
      if (prompt.includes("live-now")) {
        signalLive();
        return { mainline: "Live now", ask: { kind: "none", hint: "" }, ops: [] };
      }
      historyStarted += 1;
      if (historyStarted === 2) signalHistory();
      if (historyStarted <= 2) await historyGate;
      return { mainline: "History", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);

    await watcher.chooseHistory(new Date(Date.now() - 30 * 86_400_000).toISOString());
    await bothHistoryStarted;
    writeJsonLines(livePath, [{ type: "user", sessionId: "live", cwd: root, message: { role: "user", content: "live-now" } }]);
    includeLive = true;
    await watcher.checkNow();
    await liveStarted;
    for (let attempt = 0; attempt < 100 && !store.snapshot().sessions.live; attempt += 1) await sleep(5);
    expect(store.snapshot().sessions.live).toBeDefined();

    releaseHistory();
    await watcher.once();
    expect(store.snapshot().intake.job?.status).toBe("complete");
  });

  test("re-rolls a candidate when a concurrently committed new mainline makes its context stale", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const paths = ["alpha", "beta"].map((id) => {
      const path = join(root, `${id}.jsonl`);
      writeJsonLines(path, [{ type: "user", sessionId: id, cwd: root, message: { role: "user", content: `marker-${id}` } }]);
      return path;
    });
    const source = (): TranscriptFile[] => paths.map((path) => {
      const id = path.slice(path.lastIndexOf("/") + 1, -6);
      return { path, provider: "claude" as const, sessionId: id, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
    });
    const store = new StateStore(join(root, "state"));
    const calls = { alpha: 0, beta: 0 };
    let releaseAlpha!: () => void;
    let releaseBeta!: () => void;
    let signalTwo!: () => void;
    const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const betaGate = new Promise<void>((resolve) => { releaseBeta = resolve; });
    const twoStarted = new Promise<void>((resolve) => { signalTwo = resolve; });
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async (_engine, prompt) => {
      const delta = prompt.split("FILTERED TRANSCRIPT INCREMENT")[1] ?? "";
      const id = delta.includes("marker-alpha") ? "alpha" : "beta";
      calls[id] += 1;
      if (calls.alpha + calls.beta === 2) signalTwo();
      if (calls[id] === 1) await (id === "alpha" ? alphaGate : betaGate);
      return { mainline: id === "alpha" ? "Alpha line" : "Beta line", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);

    await watcher.chooseHistory(new Date(Date.now() - 30 * 86_400_000).toISOString());
    await twoStarted;
    releaseAlpha();
    for (let attempt = 0; attempt < 100 && !store.snapshot().mainlineIndex["Alpha line"]; attempt += 1) await sleep(5);
    expect(store.snapshot().mainlineIndex["Alpha line"]).toBeString();
    releaseBeta();
    await watcher.once();

    expect(calls.alpha).toBe(1);
    expect(calls.beta).toBe(2);
    expect(store.snapshot().mainlineIndex["Beta line"]).toBeString();
  });

  test("discovers Codex transcripts from an alternate runtime home", () => {
    const root = temporaryDirectory();
    directories.push(root);
    const codexHome = join(root, "orca-codex-home");
    const path = join(codexHome, "sessions", "2026", "07", "14", "rollout-session.jsonl");
    writeJsonLines(path, [{ type: "session_meta", payload: { id: "alternate", cwd: root } }]);
    const files = discoverTranscripts(root, [codexHome]);
    expect(files.map((file) => file.path)).toContain(path);
    expect(files.find((file) => file.path === path)?.provider).toBe("codex");
  });

  test("discovers Kimi, Grok, and MiniMax sources with recoverable metadata", () => {
    const root = temporaryDirectory();
    directories.push(root);
    const kimiCwd = "/work/kimi";
    const kimiHash = createHash("md5").update(kimiCwd).digest("hex");
    const kimi = join(root, ".kimi", "sessions", kimiHash, "kimi-id", "context.jsonl");
    writeJsonLines(kimi, [{ role: "user", content: "Kimi" }]);
    writeFileSync(join(root, ".kimi", "kimi.json"), JSON.stringify({ work_dirs: [{ path: kimiCwd, kaos: "local" }] }));
    const grok = join(root, ".grok", "sessions", "%2Fwork%2Fgrok", "grok-id", "updates.jsonl");
    writeJsonLines(grok, [{ method: "session/update", params: { sessionId: "grok-id", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Grok" } } } }]);
    writeFileSync(join(root, ".grok", "sessions", "%2Fwork%2Fgrok", "grok-id", "summary.json"), JSON.stringify({ info: { id: "grok-id", cwd: "/work/grok" }, generated_title: "Grok title" }));
    const minimax = join(root, ".minimax", "sessions", "minimax-id.json");
    writeJsonLines(minimax, [{ metadata: { id: "minimax-id", workspace: "/work/minimax", title: "MiniMax title" }, messages: [] }]);

    const files = discoverTranscripts(root, []);
    expect(files.find((file) => file.provider === "kimi")).toMatchObject({ path: kimi, cwd: "/work/kimi", kind: "append" });
    expect(files.find((file) => file.provider === "grok")).toMatchObject({ path: grok, cwd: "/work/grok", title: "Grok title", kind: "append" });
    expect(files.find((file) => file.provider === "minimax")).toMatchObject({ path: minimax, cwd: "/work/minimax", title: "MiniMax title", kind: "snapshot" });
  });

  test("deduplicates mirrored Codex homes by logical session id", () => {
    const root = temporaryDirectory();
    directories.push(root);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const name = `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`;
    const standard = join(root, ".codex", "sessions", "2026", "07", "14", name);
    const alternateHome = join(root, "orca-codex-home");
    const alternate = join(alternateHome, "sessions", "2026", "07", "14", name);
    writeJsonLines(standard, [{ type: "session_meta", payload: { id: sessionId } }]);
    writeJsonLines(alternate, [
      { type: "session_meta", payload: { id: sessionId } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "newer" }] } },
    ]);
    const matches = discoverTranscripts(root, [alternateHome]).filter(
      (file) => file.sessionId === sessionId,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe(alternate);
  });

  test("carries a logical session offset across mirrored paths", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const firstPath = join(root, "first", "mirror-session.jsonl");
    const secondPath = join(root, "second", "mirror-session.jsonl");
    const firstRow = { type: "user", sessionId: "mirror-session", message: { role: "user", content: "first increment" } };
    const secondRow = { type: "user", sessionId: "mirror-session", message: { role: "user", content: "second increment" } };
    writeJsonLines(firstPath, [firstRow]);
    writeJsonLines(secondPath, [firstRow]);
    let activePath = firstPath;
    const source = (): TranscriptFile[] => {
      const stat = statSync(activePath);
      return [{ path: activePath, provider: "claude", sessionId: "mirror-session", size: stat.size, mtimeMs: stat.mtimeMs }];
    };
    const store = new StateStore(join(root, "state"));
    await allowExistingTranscriptConsumption(store);
    const prompts: string[] = [];
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async (_engine, prompt) => {
      prompts.push(prompt);
      return {
        mainline: "Mirror",
        ask: { kind: "none", hint: "" },
        ops: [{ op: "grow", parent: "mainline", type: "note", label: `节点${prompts.length}` }],
      };
    }, source);
    await watcher.once();
    writeJsonLines(secondPath, [firstRow, secondRow]);
    activePath = secondPath;
    await watcher.once();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("second increment");
    expect(prompts[1]).not.toContain("[user]\nfirst increment");
    expect(store.snapshot().offsets[firstPath]).toBeUndefined();
    expect(store.snapshot().offsets[secondPath]?.offset).toBe(statSync(secondPath).size);
    const rootId = store.snapshot().roots[0]!;
    expect(store.snapshot().nodes[rootId]?.children).toHaveLength(2);
  });

  test("consumes rewritten snapshot sources once per mtime version", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const path = join(root, "minimax-id.json");
    const writeSnapshot = (text: string): void => writeFileSync(path, JSON.stringify({
      metadata: { id: "minimax-id", workspace: root, title: "MiniMax" },
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    }));
    writeSnapshot("first");
    const source = (): TranscriptFile[] => {
      const stat = statSync(path);
      return [{ path, provider: "minimax", kind: "snapshot", sessionId: "minimax-id", cwd: root, size: stat.size, mtimeMs: stat.mtimeMs }];
    };
    const store = new StateStore(join(root, "state"));
    await allowExistingTranscriptConsumption(store);
    let calls = 0;
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async () => {
      calls += 1;
      return { mainline: "MiniMax", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);
    await watcher.once();
    await watcher.once();
    expect(calls).toBe(1);
    writeSnapshot("second");
    const future = new Date(Date.now() + 1_000);
    utimesSync(path, future, future);
    await watcher.once();
    expect(calls).toBe(2);
  });

  test("commits the byte offset before applying non-idempotent grow", async () => {
    const fixture = setup();
    let observedOffset = 0;
    class ObservedRuntime extends TreeRuntime {
      override async applyRoll(meta: TranscriptMeta, output: RollOutput) {
        observedOffset = this.store.snapshot().offsets[fixture.path]?.offset ?? 0;
        return super.applyRoll(meta, output);
      }
    }
    const runtime = new ObservedRuntime(fixture.store);
    await allowExistingTranscriptConsumption(fixture.store);
    const watcher = new TranscriptWatcher(
      fixture.store,
      runtime,
      fixture.root,
      undefined,
      async () => ({ mainline: "Watcher", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "task", label: "只增长一次" }] }),
      fixture.source,
    );
    await watcher.once();
    expect(observedOffset).toBe(statSync(fixture.path).size);
    expect(fixture.store.snapshot().nodes[fixture.store.snapshot().roots[0]!]!.children).toHaveLength(1);
  });

  test("restart at the durable offset never repeats grow", async () => {
    const fixture = setup();
    let calls = 0;
    const roll = async (): Promise<RollOutput> => {
      calls += 1;
      return { mainline: "Once", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "task", label: "非幂等增长" }] };
    };
    await allowExistingTranscriptConsumption(fixture.store);
    await new TranscriptWatcher(fixture.store, new TreeRuntime(fixture.store), fixture.root, undefined, roll, fixture.source).once();
    const reloaded = new StateStore(join(fixture.root, "state"));
    await new TranscriptWatcher(reloaded, new TreeRuntime(reloaded), fixture.root, undefined, roll, fixture.source).once();
    expect(calls).toBe(1);
    const state = reloaded.snapshot();
    expect(state.nodes[state.roots[0]!]!.children).toHaveLength(1);
  });

  test("a crash-window apply failure can lose one roll but cannot replay it", async () => {
    const fixture = setup();
    let calls = 0;
    class FailingRuntime extends TreeRuntime {
      override async applyRoll(): Promise<never> {
        throw new Error("simulated crash after offset commit");
      }
    }
    const roll = async (): Promise<RollOutput> => {
      calls += 1;
      return { mainline: "Crash", ask: { kind: "none", hint: "" }, ops: [] };
    };
    await allowExistingTranscriptConsumption(fixture.store);
    await new TranscriptWatcher(fixture.store, new FailingRuntime(fixture.store), fixture.root, undefined, roll, fixture.source).once();
    expect(fixture.store.snapshot().offsets[fixture.path]?.offset).toBe(statSync(fixture.path).size);
    const reloaded = new StateStore(join(fixture.root, "state"));
    await new TranscriptWatcher(reloaded, new TreeRuntime(reloaded), fixture.root, undefined, roll, fixture.source).once();
    expect(calls).toBe(1);
    expect(reloaded.snapshot().roots).toEqual([]);
  });

  test("low-signal increments are consumed without calling a model", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const path = join(root, "low.jsonl");
    writeJsonLines(path, [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { path: "x" } }] } }]);
    const source = (): TranscriptFile[] => [{ path, provider: "claude", size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }];
    const store = new StateStore(join(root, "state"));
    await allowExistingTranscriptConsumption(store);
    let calls = 0;
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async () => {
      calls += 1;
      return { mainline: "never", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);
    await watcher.once();
    expect(calls).toBe(0);
    expect(store.snapshot().offsets[path]?.offset).toBe(statSync(path).size);
  });

  test("self-generated roll transcripts are permanently ignored", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const path = join(root, "self.jsonl");
    writeJsonLines(path, [{ type: "user", sessionId: "self", message: { role: "user", content: "SESSIONMAP_ROLL_V1_DO_NOT_INGEST" } }]);
    const source = (): TranscriptFile[] => [{ path, provider: "claude", size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }];
    const store = new StateStore(join(root, "state"));
    await allowExistingTranscriptConsumption(store);
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async () => {
      throw new Error("must not call roll");
    }, source);
    await watcher.once();
    expect(store.snapshot().offsets[path]?.ignored).toBeTrue();
    expect(store.snapshot().sessions.self).toBeUndefined();
  });

  test("does not reprocess a session after the user deletes its SessionMap record", async () => {
    const root = temporaryDirectory();
    directories.push(root);
    const path = join(root, "deleted.jsonl");
    writeJsonLines(path, [{ type: "user", sessionId: "deleted", message: { role: "user", content: "private work" } }]);
    const source = (): TranscriptFile[] => {
      const stat = statSync(path);
      return [{ path, provider: "claude", sessionId: "deleted", size: stat.size, mtimeMs: stat.mtimeMs }];
    };
    const store = new StateStore(join(root, "state"));
    await allowExistingTranscriptConsumption(store);
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("deleted", root), {
      mainline: "待删除主题", ask: { kind: "none", hint: "" }, ops: [],
    });
    await runtime.deleteSession("deleted");
    let calls = 0;
    const watcher = new TranscriptWatcher(store, runtime, root, undefined, async () => {
      calls += 1;
      return { mainline: "不应出现", ask: { kind: "none", hint: "" }, ops: [] };
    }, source);
    await watcher.once();
    expect(calls).toBe(0);
    expect(store.snapshot().sessions.deleted).toBeUndefined();
    expect(store.snapshot().offsets[path]).toBeUndefined();
  });
});
