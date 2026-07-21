import { describe, expect, test } from "bun:test";
import {
  mergeRuntimeState,
  parseLsofTranscriptProcesses,
  processForSession,
  readGitWorkspace,
  readTranscriptProcess,
  readTranscriptProcesses,
} from "@sessionmap/core/monitor.ts";
import { sessionRecord } from "./helpers.ts";

describe("session monitor state merge", () => {
  test("projects branch and worktree context without persisting Git state", async () => {
    const calls: string[][] = [];
    const result = await readGitWorkspace("/repo/packages/app", async (command) => {
      calls.push(command);
      if (command.includes("status")) return { ok: true, text: " M web/app.js\n?? notes.txt\n" };
      if (command.includes("symbolic-ref")) return { ok: true, text: "feature/directory-ui\n" };
      if (command.includes("rev-list")) return { ok: true, text: "2\n" };
      if (command.includes("rev-parse")) return { ok: true, text: "/repo\n" };
      return { ok: false, text: "" };
    });

    expect(calls).toHaveLength(4);
    expect(result).toEqual({
      cwd: "/repo/packages/app",
      worktree: "/repo",
      name: "repo",
      branch: "feature/directory-ui",
      dirty: 2,
      ahead: 2,
    });
  });

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
      "p60000",
      "n/dev/ttys008",
      "n/Users/example/.kimi/sessions/hash/kimi-session/context.jsonl",
      "p70000",
      "n/dev/ttys009",
      "n/Users/example/.grok/sessions/cwd/grok-session/updates.jsonl",
    ].join("\n");
    expect(parseLsofTranscriptProcesses(output)).toEqual([
      { pid: 30538, tty: "/dev/ttys000", command: "open transcript", provider: "codex", sessionId: "11111111-1111-4111-8111-111111111111" },
      { pid: 41200, tty: "/dev/ttys004", command: "open transcript", provider: "claude", sessionId: "22222222-2222-4222-8222-222222222222" },
      { pid: 60000, tty: "/dev/ttys008", command: "open transcript", provider: "kimi", sessionId: "kimi-session" },
      { pid: 70000, tty: "/dev/ttys009", command: "open transcript", provider: "grok", sessionId: "grok-session" },
    ]);
  });

  test("keeps Codex transcript evidence when no Claude process exists", async () => {
    const calls: string[][] = [];
    const codexOutput = [
      "p33593",
      "n/dev/ttys000",
      "n/Users/example/.codex/sessions/2026/07/19/rollout-2026-07-19T21-56-38-33333333-3333-4333-8333-333333333333.jsonl",
    ].join("\n");
    const rows = await readTranscriptProcesses(async (command) => {
      calls.push(command);
      return command.at(-1) === "codex"
        ? { ok: true, text: codexOutput }
        : { ok: false, text: "" };
    });

    expect(calls.map((command) => command.at(-1))).toEqual(["codex", "claude", "kimi", "grok", "minimax"]);
    expect(rows).toEqual([{
      pid: 33593,
      tty: "/dev/ttys000",
      command: "open transcript",
      provider: "codex",
      sessionId: "33333333-3333-4333-8333-333333333333",
    }]);
  });

  test("revalidates a cached PID against both provider and session transcript", async () => {
    const output = [
      "p4242",
      "n/dev/ttys007",
      "n/Users/example/.codex/sessions/2026/07/19/rollout-2026-07-19T15-51-02-same-session.jsonl",
      "n/Users/example/.claude/projects/-Users-example-Code/same-session.jsonl",
    ].join("\n");
    const run = async () => ({ ok: true, text: output });

    expect(await readTranscriptProcess({ id: "same-session", provider: "claude" }, 4242, run))
      .toMatchObject({ pid: 4242, tty: "/dev/ttys007", provider: "claude" });
    expect(await readTranscriptProcess({ id: "same-session", provider: "codex" }, 4242, run))
      .toBeNull();
  });
});
