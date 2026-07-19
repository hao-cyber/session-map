import { describe, expect, test } from "bun:test";
import { mergeRuntimeState, parseLsofTranscriptProcesses, processForSession } from "../src/monitor.ts";
import { sessionRecord } from "./helpers.ts";

describe("session monitor state merge", () => {
  test("deletes stale runtime handles without overwriting concurrent semantics", () => {
    const current = sessionRecord("session", "/tmp/work");
    current.cursor = "new-concurrent-cursor";
    current.ask = { kind: "decision", hint: "保留拍板" };
    current.pid = 123;
    current.terminalHandle = "term_old";
    current.paneKey = "tab:leaf";
    const patch = structuredClone(current);
    patch.cursor = "stale-cursor";
    patch.ask = { kind: "none", hint: "" };
    patch.status = "closed";
    patch.terminalOpen = false;
    patch.lastStatusAt = "2026-07-14T00:00:00.000Z";
    delete patch.pid;
    delete patch.terminalHandle;
    delete patch.paneKey;

    const merged = mergeRuntimeState(current, patch);
    expect(merged.status).toBe("closed");
    expect(merged.terminalOpen).toBeFalse();
    expect(merged.pid).toBeUndefined();
    expect(merged.terminalHandle).toBeUndefined();
    expect(merged.paneKey).toBeUndefined();
    expect(merged.cursor).toBe("new-concurrent-cursor");
    expect(merged.ask).toEqual({ kind: "decision", hint: "保留拍板" });
  });

  test("matches only provider resume argv, not any process mentioning the id", () => {
    const codex = sessionRecord("safe-session", "/tmp/work");
    codex.provider = "codex";
    const rows = [
      { pid: 1, tty: "ttys001", command: "bun api-client.ts safe-session" },
      { pid: 2, tty: "ttys002", command: "/opt/bin/claude --resume safe-session" },
      { pid: 3, tty: "ttys003", command: "/opt/bin/codex resume safe-session" },
    ];
    expect(processForSession(codex, rows)?.pid).toBe(3);
    codex.provider = "claude";
    expect(processForSession(codex, rows)?.pid).toBe(2);
    expect(processForSession({ ...codex, id: "missing" }, rows)).toBeUndefined();
  });

  test("links initial Codex and Claude processes by their read-only open transcripts", () => {
    const output = [
      "p30538",
      "f0",
      "n/dev/ttys000",
      "f41",
      "n/Users/example/.codex/sessions/2026/07/19/rollout-2026-07-19T15-51-02-11111111-1111-4111-8111-111111111111.jsonl",
      "p41200",
      "f0",
      "n/dev/ttys004",
      "f22",
      "n/Users/example/.claude/projects/-Users-example-Code/22222222-2222-4222-8222-222222222222.jsonl",
      "p50000",
      "n/Users/example/random.jsonl",
    ].join("\n");
    expect(parseLsofTranscriptProcesses(output)).toEqual([
      { pid: 30538, tty: "/dev/ttys000", command: "open transcript", sessionId: "11111111-1111-4111-8111-111111111111" },
      { pid: 41200, tty: "/dev/ttys004", command: "open transcript", sessionId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });
});
