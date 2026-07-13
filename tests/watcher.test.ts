import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import type { RollOutput, TranscriptMeta } from "../src/types.ts";
import { discoverTranscripts, TranscriptWatcher, type TranscriptFile } from "../src/watcher.ts";
import { cleanup, temporaryDirectory, writeJsonLines } from "./helpers.ts";

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

describe("watcher delivery semantics", () => {
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
    writeJsonLines(path, [{ type: "user", sessionId: "self", message: { role: "user", content: "MAINTRAIL_ROLL_V1_DO_NOT_INGEST" } }]);
    const source = (): TranscriptFile[] => [{ path, provider: "claude", size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }];
    const store = new StateStore(join(root, "state"));
    const watcher = new TranscriptWatcher(store, new TreeRuntime(store), root, undefined, async () => {
      throw new Error("must not call roll");
    }, source);
    await watcher.once();
    expect(store.snapshot().offsets[path]?.ignored).toBeTrue();
    expect(store.snapshot().sessions.self).toBeUndefined();
  });
});
