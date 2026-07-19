import { existsSync } from "node:fs";
import { basename } from "node:path";
import { GIT_POLL_MS, STATUS_POLL_MS } from "./constants.ts";
import { Logger } from "./logger.ts";
import { enginePath } from "./roll.ts";
import { matchOrcaSession, readOrcaSnapshot } from "./orca.ts";
import { StateStore } from "./state.ts";
import type { GitChip, SessionRecord, SessionStatus } from "./types.ts";
import { isRecord, safeJsonParse, truncateBytes } from "./utils.ts";

type ClaudeAgent = {
  id: string;
  status: string;
  pid?: number;
};

export type ProcessRow = { pid: number; tty: string; command: string };
export type TranscriptProcessRow = ProcessRow & { sessionId: string };

async function runText(command: string[], timeoutMs = 5_000): Promise<{ ok: boolean; text: string }> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    return { ok: !timedOut && exitCode === 0, text: stdout };
  } catch {
    return { ok: false, text: "" };
  }
}

async function readClaudeAgents(): Promise<ClaudeAgent[]> {
  const claude = enginePath("claude");
  if (!claude) return [];
  const result = await runText([claude, "agents", "--json"], 7_500);
  if (!result.ok) return [];
  const parsed = safeJsonParse(result.text);
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.agents)
      ? parsed.agents
      : [];
  const agents: ClaudeAgent[] = [];
  for (const raw of values) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.sessionId === "string"
      ? raw.sessionId
      : typeof raw.id === "string"
        ? raw.id
        : "";
    if (!id) continue;
    const agent: ClaudeAgent = {
      id,
      status: typeof raw.status === "string"
        ? raw.status
        : typeof raw.state === "string"
          ? raw.state
          : "unknown",
    };
    if (typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid > 0) agent.pid = raw.pid;
    agents.push(agent);
  }
  return agents;
}

async function readProcesses(): Promise<ProcessRow[]> {
  const result = await runText(["/bin/ps", "-axo", "pid=,tty=,command="], 5_000);
  if (!result.ok) return [];
  const rows: ProcessRow[] = [];
  for (const line of result.text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), tty: match[2] ?? "", command: match[3] ?? "" });
  }
  return rows;
}

function sessionIdForOpenTranscript(path: string): string | null {
  if (!path.endsWith(".jsonl")) return null;
  const codex = path.match(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.+?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (codex?.[1]) return codex[1];
  if (!path.includes("/.claude/projects/")) return null;
  const name = basename(path, ".jsonl");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : null;
}

/** Parse one macOS lsof -Fpn stream into exact transcript-to-process links. */
export function parseLsofTranscriptProcesses(output: string): TranscriptProcessRow[] {
  type OpenProcess = { pid: number; tty: string; sessionIds: Set<string> };
  const processes: OpenProcess[] = [];
  let current: OpenProcess | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p") && /^p\d+$/.test(line)) {
      current = { pid: Number(line.slice(1)), tty: "", sessionIds: new Set() };
      processes.push(current);
      continue;
    }
    if (!current || !line.startsWith("n")) continue;
    const name = line.slice(1);
    if (!current.tty && /^\/dev\/tty\w+$/.test(name)) current.tty = name;
    const sessionId = sessionIdForOpenTranscript(name);
    if (sessionId) current.sessionIds.add(sessionId);
  }
  return processes.flatMap((process) => [...process.sessionIds].map((sessionId) => ({
    pid: process.pid,
    tty: process.tty,
    command: "open transcript",
    sessionId,
  })));
}

/**
 * Initial Codex/Claude processes often omit the session id from argv. Both
 * providers keep their append-only transcript open, which gives us an exact,
 * read-only process link without cwd heuristics or Orca.
 */
async function readTranscriptProcesses(): Promise<TranscriptProcessRow[]> {
  const lsof = "/usr/sbin/lsof";
  if (!existsSync(lsof)) return [];
  const result = await runText([lsof, "-n", "-P", "-Fpn", "-c", "codex", "-c", "claude"], 5_000);
  return result.ok ? parseLsofTranscriptProcesses(result.text) : [];
}

function mapAgentStatus(value: string, updatedAt: number, now: number): SessionStatus {
  const status = value.toLowerCase();
  if (["working", "busy", "running", "active"].includes(status)) return "busy";
  if (["done", "complete", "completed", "finished"].includes(status)) {
    return updatedAt > 0 && now - updatedAt <= 10 * 60_000 ? "recent" : "idle";
  }
  if (["idle", "waiting", "blocked"].includes(status)) return "idle";
  return "unknown";
}

function unquoteArg(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function processForSession(session: SessionRecord, rows: ProcessRow[]): ProcessRow | undefined {
  if (!session.id) return undefined;
  return rows.find((row) => {
    const args = row.command.split(/\s+/).filter(Boolean);
    const executable = args.findIndex((arg) => {
      const name = basename(unquoteArg(arg));
      return name === session.provider || name === `${session.provider}.js` || name.startsWith(`${session.provider}-`);
    });
    if (executable < 0) return false;
    if (session.provider === "codex") {
      return args.slice(executable + 1).some(
        (arg, index, tail) => arg === "resume" && unquoteArg(tail[index + 1] ?? "") === session.id,
      );
    }
    return args.slice(executable + 1).some((arg, index, tail) => {
      if (arg === `--resume=${session.id}`) return true;
      return ["--resume", "-r"].includes(arg) && unquoteArg(tail[index + 1] ?? "") === session.id;
    });
  });
}

function sameRuntimeState(left: SessionRecord, right: SessionRecord): boolean {
  return left.status === right.status &&
    left.terminalOpen === right.terminalOpen &&
    left.terminalHandle === right.terminalHandle &&
    left.paneKey === right.paneKey &&
    left.pid === right.pid;
}

export function mergeRuntimeState(current: SessionRecord, patch: SessionRecord): SessionRecord {
  const merged: SessionRecord = {
    ...current,
    status: patch.status,
    terminalOpen: patch.terminalOpen,
    lastStatusAt: patch.lastStatusAt,
    updatedAt: current.updatedAt,
  };
  if (patch.terminalHandle === undefined) delete merged.terminalHandle;
  else merged.terminalHandle = patch.terminalHandle;
  if (patch.paneKey === undefined) delete merged.paneKey;
  else merged.paneKey = patch.paneKey;
  if (patch.pid === undefined) delete merged.pid;
  else merged.pid = patch.pid;
  return merged;
}

export class SessionMonitor {
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #gitTimer: ReturnType<typeof setInterval> | null = null;
  #gitChips: GitChip[] = [];
  #lastGitAt = 0;

  constructor(
    readonly store: StateStore,
    readonly logger = new Logger(),
  ) {}

  start(): void {
    if (this.#statusTimer) return;
    void this.refreshStatuses();
    void this.refreshGit();
    this.#statusTimer = setInterval(() => void this.refreshStatuses(), STATUS_POLL_MS);
    this.#gitTimer = setInterval(() => void this.refreshGit(), GIT_POLL_MS);
  }

  stop(): void {
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    if (this.#gitTimer) clearInterval(this.#gitTimer);
    this.#statusTimer = null;
    this.#gitTimer = null;
  }

  gitChips(): GitChip[] {
    return structuredClone(this.#gitChips);
  }

  lastGitAt(): number {
    return this.#lastGitAt;
  }

  async refreshStatuses(): Promise<void> {
    try {
      const [orca, claudeAgents, processes, transcriptProcesses] = await Promise.all([
        readOrcaSnapshot(),
        readClaudeAgents(),
        readProcesses(),
        readTranscriptProcesses(),
      ]);
      const snapshot = this.store.snapshot();
      const patches = new Map<string, SessionRecord>();
      const now = Date.now();
      for (const session of Object.values(snapshot.sessions)) {
        const next = structuredClone(session);
        const orcaMatch = matchOrcaSession(session, orca);
        const claudeAgent = session.provider === "claude"
          ? claudeAgents.find((agent) => agent.id === session.id)
          : undefined;
        const process = transcriptProcesses.find((candidate) => candidate.sessionId === session.id)
          ?? processForSession(session, processes);
        const terminal = orcaMatch.terminal;
        // Orca is an optional source, not an authority gate.  A locally
        // installed but closed Orca app must never freeze the last observed
        // terminal state.  Every poll combines all available live evidence;
        // no evidence means the durable session entry remains, but its
        // terminal is closed and therefore resumable.
        next.terminalOpen = Boolean(terminal?.connected || process || claudeAgent);
        if (terminal?.handle) next.terminalHandle = terminal.handle;
        else delete next.terminalHandle;
        if (orcaMatch.paneKey) next.paneKey = orcaMatch.paneKey;
        else delete next.paneKey;
        const pid = claudeAgent?.pid ?? process?.pid;
        if (pid) next.pid = pid;
        else delete next.pid;

        const transcriptAge = Math.max(0, now - Date.parse(session.lastTranscriptAt));
        if (orcaMatch.agent) {
          next.status = mapAgentStatus(orcaMatch.agent.state, orcaMatch.agent.updatedAt, now);
        } else if (claudeAgent) {
          next.status = mapAgentStatus(claudeAgent.status, Date.parse(session.lastTranscriptAt), now);
        } else if (next.terminalOpen) {
          next.status = transcriptAge <= 30_000 ? "busy" : transcriptAge <= 10 * 60_000 ? "recent" : "idle";
        } else {
          next.status = "closed";
        }
        next.lastStatusAt = new Date(now).toISOString();
        if (!sameRuntimeState(session, next)) patches.set(session.id, next);
      }
      if (!patches.size) return;
      await this.store.update((state) => {
        for (const [id, patch] of patches) {
          const current = state.sessions[id];
          if (!current) continue;
          state.sessions[id] = mergeRuntimeState(current, patch);
        }
      });
    } catch (error) {
      this.logger.error("session status refresh failed", { error: String(error) });
    }
  }

  async refreshGit(): Promise<void> {
    const snapshot = this.store.snapshot();
    const directories = Array.from(new Set(Object.values(snapshot.sessions).map((session) => session.cwd)))
      .filter((cwd) => cwd && existsSync(cwd));
    const chips: GitChip[] = [];
    await Promise.all(directories.map(async (cwd) => {
      const [status, branch, ahead] = await Promise.all([
        runText(["git", "-C", cwd, "status", "--porcelain=v1", "--untracked-files=normal"]),
        runText(["git", "-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]),
        runText(["git", "-C", cwd, "rev-list", "--count", "@{upstream}..HEAD"]),
      ]);
      if (!status.ok) return;
      const dirty = status.text.split("\n").filter(Boolean).length;
      const aheadCount = ahead.ok ? Number.parseInt(ahead.text.trim(), 10) || 0 : 0;
      if (!dirty && !aheadCount) return;
      chips.push({
        cwd,
        name: basename(cwd) || cwd,
        branch: branch.ok ? truncateBytes(branch.text.trim(), 120) : "detached",
        dirty,
        ahead: aheadCount,
      });
    }));
    chips.sort((left, right) => left.name.localeCompare(right.name));
    this.#gitChips = chips;
    this.#lastGitAt = Date.now();
  }
}

export { readClaudeAgents, readProcesses, readTranscriptProcesses, runText };
