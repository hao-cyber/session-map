import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord, TranscriptMeta } from "@sessionmap/core/types.ts";

export function temporaryDirectory(prefix = "sessionmap-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeJsonLines(path: string, rows: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

export function transcriptMeta(id: string, cwd: string, provider: "claude" | "codex" = "claude"): TranscriptMeta {
  return {
    provider,
    sessionId: id,
    path: join(cwd, `${id}.jsonl`),
    cwd,
    title: `Session ${id}`,
    lastUser: `Prompt ${id}`,
    mtimeMs: Date.now(),
  };
}

export function sessionRecord(id: string, cwd: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    provider: "claude",
    path: join(cwd, `${id}.jsonl`),
    cwd,
    title: "Safe title",
    lastUser: "Safe prompt",
    mainline: null,
    rootId: null,
    cursor: null,
    ask: { kind: "none", hint: "" },
    snapshot: { summary: "安全会话", progress: "等待下一步", trail: [], at: now },
    status: "idle",
    terminalOpen: false,
    firstSeenAt: now,
    lastTranscriptAt: now,
    lastStatusAt: now,
    updatedAt: now,
  };
}
