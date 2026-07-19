import { existsSync } from "node:fs";
import type { SessionRecord } from "./types.ts";
import { isRecord, normalizeText, safeJsonParse, truncateBytes } from "./utils.ts";

export interface OrcaAgent {
  paneKey: string;
  state: string;
  agentType: string;
  prompt: string;
  taskTitle: string;
  updatedAt: number;
  worktreePath: string;
}
export interface OrcaTerminal {
  handle: string;
  paneKey: string;
  title: string;
  connected: boolean;
  writable: boolean;
  worktreePath: string;
}

export interface OrcaSnapshot {
  agents: OrcaAgent[];
  terminals: OrcaTerminal[];
  available: boolean;
}

export interface OrcaSessionMatch {
  agent?: OrcaAgent;
  terminal?: OrcaTerminal;
  paneKey?: string;
}

export function orcaPath(): string | null {
  const candidates = [
    process.env.SESSIONMAP_ORCA ?? "",
    Bun.which("orca") ?? "",
    "/Applications/Orca.app/Contents/Resources/bin/orca",
    `${process.env.HOME ?? ""}/Applications/Orca.app/Contents/Resources/bin/orca`,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function runOrcaJson(args: string[], timeoutMs = 7_500): Promise<unknown> {
  const executable = orcaPath();
  if (!executable) throw new Error("Orca CLI is not installed");
  const proc = Bun.spawn([executable, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error("Orca command timed out");
  if (exitCode !== 0) throw new Error(`Orca exited ${exitCode}: ${truncateBytes(stderr, 1_000, true)}`);
  const parsed = safeJsonParse(stdout);
  if (!isRecord(parsed)) throw new Error("Orca returned malformed JSON");
  if (parsed.ok === false) throw new Error(`Orca error: ${JSON.stringify(parsed.error ?? parsed)}`);
  return parsed.result ?? parsed;
}

function arrayField(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

export async function readOrcaSnapshot(): Promise<OrcaSnapshot> {
  if (!orcaPath()) return { agents: [], terminals: [], available: false };
  try {
    const [worktreeResult, terminalResult] = await Promise.all([
      runOrcaJson(["worktree", "ps", "--limit", "60"]),
      runOrcaJson(["terminal", "list", "--limit", "200"]),
    ]);
    const agents: OrcaAgent[] = [];
    for (const worktree of arrayField(worktreeResult, "worktrees")) {
      if (!isRecord(worktree)) continue;
      const worktreePath = typeof worktree.path === "string" ? worktree.path : "";
      for (const raw of Array.isArray(worktree.agents) ? worktree.agents : []) {
        if (!isRecord(raw) || typeof raw.paneKey !== "string") continue;
        agents.push({
          paneKey: raw.paneKey,
          state: typeof raw.state === "string" ? raw.state : "unknown",
          agentType: typeof raw.agentType === "string" ? raw.agentType : "",
          prompt: typeof raw.prompt === "string" ? raw.prompt : "",
          taskTitle: typeof raw.taskTitle === "string" ? raw.taskTitle : "",
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
          worktreePath,
        });
      }
    }
    const terminals: OrcaTerminal[] = [];
    for (const raw of arrayField(terminalResult, "terminals")) {
      if (!isRecord(raw) || typeof raw.handle !== "string") continue;
      const tabId = typeof raw.tabId === "string" ? raw.tabId : "";
      const leafId = typeof raw.leafId === "string" ? raw.leafId : "";
      terminals.push({
        handle: raw.handle,
        paneKey: tabId && leafId ? `${tabId}:${leafId}` : "",
        title: typeof raw.title === "string" ? raw.title : "",
        connected: raw.connected === true,
        writable: raw.writable === true,
        worktreePath: typeof raw.worktreePath === "string" ? raw.worktreePath : "",
      });
    }
    return { agents, terminals, available: true };
  } catch {
    return { agents: [], terminals: [], available: false };
  }
}

export function stripSpinner(value: string): string {
  return value.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿⡿⣟⣯⣷⣾⣽⣻⢿⣿\s]+/u, "").trim();
}

function samePrompt(left: string, right: string): boolean {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // The transcript copy is bounded; a long exact prompt may therefore share only its prefix.
  return Math.min(a.length, b.length) >= 128 && (a.startsWith(b) || b.startsWith(a));
}

export function matchOrcaSession(session: SessionRecord, snapshot: OrcaSnapshot): OrcaSessionMatch {
  const rememberedTerminal = session.terminalHandle
    ? snapshot.terminals.find((candidate) => candidate.handle === session.terminalHandle)
    : session.paneKey
      ? snapshot.terminals.find((candidate) => candidate.paneKey === session.paneKey)
      : undefined;
  if (rememberedTerminal) {
    const agent = snapshot.agents.find((candidate) => candidate.paneKey === rememberedTerminal.paneKey);
    return {
      ...(agent ? { agent } : {}),
      terminal: rememberedTerminal,
      paneKey: rememberedTerminal.paneKey,
    };
  }

  let agent = snapshot.agents.find((candidate) => samePrompt(session.lastUser, candidate.prompt));
  if (!agent && session.title) {
    const title = normalizeText(stripSpinner(session.title));
    agent = snapshot.agents.find((candidate) => normalizeText(stripSpinner(candidate.taskTitle)) === title);
  }
  if (agent) {
    const terminal = snapshot.terminals.find((candidate) => candidate.paneKey === agent?.paneKey);
    return { agent, ...(terminal ? { terminal } : {}), paneKey: agent.paneKey };
  }

  const title = normalizeText(stripSpinner(session.title));
  const terminal = snapshot.terminals.find((candidate) => {
    if (!title) return false;
    return normalizeText(stripSpinner(candidate.title)) === title &&
      (!session.cwd || !candidate.worktreePath || session.cwd === candidate.worktreePath);
  });
  return terminal ? { terminal, paneKey: terminal.paneKey } : {};
}
