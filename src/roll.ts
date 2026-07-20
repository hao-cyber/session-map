import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import {
  ENGINE_NAMES,
  MAX_OPS,
  MAX_SUBTREE_LINES,
  ROLL_SENTINEL,
  ROLL_TIMEOUT_MS,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
  SESSION_TRAIL_ITEMS,
} from "./constants.ts";
import type {
  EngineAvailability,
  EngineName,
  RollOutput,
  SessionRecord,
  TrailState,
} from "./types.ts";
import { byteLength, isRecord, truncateBytes } from "./utils.ts";

const ENGINE_ENV: Record<EngineName, string> = {
  claude: "SESSIONMAP_CLAUDE",
  codex: "SESSIONMAP_CODEX",
  kimi: "SESSIONMAP_KIMI",
  grok: "SESSIONMAP_GROK",
};

function executableCandidates(name: EngineName): string[] {
  const home = process.env.HOME ?? "";
  const explicit = process.env[ENGINE_ENV[name]];
  return [
    explicit ?? "",
    Bun.which(name) ?? "",
    join(home, ".local", "bin", name),
    join(home, "bin", name),
    name === "codex" ? `/opt/homebrew/bin/${name}` : "",
    name === "claude" ? join(home, ".local", "bin", "claude") : "",
    name === "kimi" ? join(home, "bin", "kimi") : "",
    name === "grok" ? join(home, ".grok", "bin", "grok") : "",
  ].filter(Boolean);
}

export function enginePath(name: EngineName): string | null {
  for (const candidate of executableCandidates(name)) {
    if (!candidate.includes(delimiter) && candidate === name) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type AvailabilityReason = NonNullable<EngineAvailability["reason"]>;
const AUTH_CACHE_MS = 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
let authCache: { expiresAt: number; values: Map<EngineName, AvailabilityReason | null> } | null = null;
let authRefresh: Promise<void> | null = null;
const recentFailures = new Map<EngineName, number>();

function authProbe(name: EngineName, executable: string): AvailabilityReason | null {
  if (process.env.SESSIONMAP_SKIP_ENGINE_PROBES === "1") return null;
  if (name === "kimi") {
    return existsSync(join(process.env.HOME ?? "", ".kimi", "credentials", "kimi-code.json"))
      ? null
      : "not-authenticated";
  }
  const command = name === "claude"
    ? [executable, "auth", "status"]
    : name === "codex"
      ? [executable, "login", "status"]
      : [executable, "models"];
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 256 * 1024,
    env: process.env,
  });
  if (result.error || result.status === null) return "auth-check-failed";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (name === "claude") {
    try {
      const status = JSON.parse(String(result.stdout)) as { loggedIn?: boolean };
      return result.status === 0 && status.loggedIn === true ? null : "not-authenticated";
    } catch {
      return "auth-check-failed";
    }
  }
  if (name === "codex") return result.status === 0 && /logged in/i.test(output) ? null : "not-authenticated";
  if (/not authenticated/i.test(output)) return "not-authenticated";
  return result.status === 0 ? null : "auth-check-failed";
}

function authCommand(name: EngineName, executable: string): string[] | null {
  if (name === "kimi") return null;
  if (name === "claude") return [executable, "auth", "status"];
  if (name === "codex") return [executable, "login", "status"];
  return [executable, "models"];
}

function authResult(
  name: EngineName,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  failed: boolean,
): AvailabilityReason | null {
  if (failed || exitCode === null) return "auth-check-failed";
  const output = `${stdout}\n${stderr}`;
  if (name === "claude") {
    try {
      const status = JSON.parse(stdout) as { loggedIn?: boolean };
      return exitCode === 0 && status.loggedIn === true ? null : "not-authenticated";
    } catch {
      return "auth-check-failed";
    }
  }
  if (name === "codex") return exitCode === 0 && /logged in/i.test(output) ? null : "not-authenticated";
  if (/not authenticated/i.test(output)) return "not-authenticated";
  return exitCode === 0 ? null : "auth-check-failed";
}

async function authProbeAsync(name: EngineName, executable: string): Promise<AvailabilityReason | null> {
  if (process.env.SESSIONMAP_SKIP_ENGINE_PROBES === "1") return null;
  if (name === "kimi") {
    return existsSync(join(process.env.HOME ?? "", ".kimi", "credentials", "kimi-code.json"))
      ? null
      : "not-authenticated";
  }
  const command = authCommand(name, executable);
  if (!command) return "auth-check-failed";
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 2_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return authResult(name, exitCode, stdout, stderr, timedOut);
  } catch {
    return "auth-check-failed";
  } finally {
    clearTimeout(timer);
  }
}

function availabilityFromCache(now: number, allowChecking: boolean): EngineAvailability[] {
  return ENGINE_NAMES.map((name) => {
    const path = enginePath(name);
    if (!path) return { name, available: false, path, reason: "not-installed" };
    const failedAt = recentFailures.get(name) ?? 0;
    if (now - failedAt < FAILURE_TTL_MS) return { name, available: false, path, reason: "recent-failure" };
    if (!authCache || authCache.expiresAt <= now || !authCache.values.has(name)) {
      return allowChecking
        ? { name, available: false, path, reason: "checking" }
        : { name, available: true, path };
    }
    const reason = authCache.values.get(name) ?? null;
    return reason ? { name, available: false, path, reason } : { name, available: true, path };
  });
}

function refreshEngineAuth(): Promise<void> {
  const now = Date.now();
  if (authCache && authCache.expiresAt > now) return Promise.resolve();
  if (authRefresh) return authRefresh;
  authRefresh = (async () => {
    const values = new Map<EngineName, AvailabilityReason | null>();
    await Promise.all(ENGINE_NAMES.map(async (name) => {
      const path = enginePath(name);
      if (path) values.set(name, await authProbeAsync(name, path));
    }));
    authCache = { expiresAt: Date.now() + AUTH_CACHE_MS, values };
  })().finally(() => { authRefresh = null; });
  return authRefresh;
}

/**
 * Immediate UI view of engine availability. Authentication probes run in the
 * background so the first map snapshot is never held behind four external
 * CLIs. The next four-second UI poll observes the populated cache.
 */
export function engineAvailabilitySnapshot(): EngineAvailability[] {
  if (process.env.SESSIONMAP_SKIP_ENGINE_PROBES === "1") {
    const values = new Map<EngineName, AvailabilityReason | null>();
    for (const name of ENGINE_NAMES) if (enginePath(name)) values.set(name, null);
    authCache = { expiresAt: Date.now() + AUTH_CACHE_MS, values };
  } else {
    void refreshEngineAuth();
  }
  return availabilityFromCache(Date.now(), true);
}

export function detectEngines(): EngineAvailability[] {
  const now = Date.now();
  if (!authCache || authCache.expiresAt <= now) {
    const values = new Map<EngineName, AvailabilityReason | null>();
    for (const name of ENGINE_NAMES) {
      const path = enginePath(name);
      if (path) values.set(name, authProbe(name, path));
    }
    authCache = { expiresAt: now + AUTH_CACHE_MS, values };
  }
  return availabilityFromCache(now, false);
}

export async function detectEnginesAsync(): Promise<EngineAvailability[]> {
  if (process.env.SESSIONMAP_SKIP_ENGINE_PROBES === "1") return detectEngines();
  await refreshEngineAuth();
  return availabilityFromCache(Date.now(), false);
}

function rootLines(state: TrailState, rootId: string, maxLines: number): string[] {
  const lines: string[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>();
  while (stack.length && lines.length < maxLines) {
    const item = stack.pop();
    if (!item || seen.has(item.id)) continue;
    const node = state.nodes[item.id];
    if (!node) continue;
    seen.add(item.id);
    const note = node.blockedNote ?? node.note;
    lines.push(
      `${"  ".repeat(item.depth)}- ${node.id} [${node.type}/${node.state}] ${node.label}${note ? ` — ${note}` : ""}`,
    );
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) stack.push({ id: child, depth: item.depth + 1 });
    }
  }
  if (stack.length) lines.push("  … subtree truncated by runtime …");
  return lines;
}

function boundedMainlineList(state: TrailState, preferredRoot: string | null): string {
  const roots = [...state.roots].sort((left, right) => {
    if (left === preferredRoot) return -1;
    if (right === preferredRoot) return 1;
    return Date.parse(state.nodes[right]?.updatedAt ?? "") - Date.parse(state.nodes[left]?.updatedAt ?? "");
  });
  let output = "";
  for (const rootId of roots) {
    const root = state.nodes[rootId];
    if (!root) continue;
    const sessions = Object.values(state.sessions)
      .filter((session) => session.rootId === rootId)
      .sort((left, right) => Date.parse(right.lastTranscriptAt) - Date.parse(left.lastTranscriptAt))
      .slice(0, 3);
    const summaries = sessions.map((session) => session.snapshot.summary).filter(Boolean);
    const focuses = sessions
      .map((session) => session.cursor ? state.nodes[session.cursor]?.label : undefined)
      .filter((label): label is string => Boolean(label));
    const anchors = [
      summaries.length ? `sessions: ${summaries.join(" / ")}` : "",
      focuses.length ? `focus: ${Array.from(new Set(focuses)).join(" / ")}` : "",
    ].filter(Boolean).join(" | ");
    const line = `- ${root.label}${state.archived.includes(rootId) ? " [archived]" : ""}${anchors ? ` | ${anchors}` : ""}\n`;
    if (byteLength(output + line) > 4_096) break;
    output += line;
  }
  return output.trimEnd() || "(none)";
}

export function buildRollPrompt(
  state: TrailState,
  session: SessionRecord | undefined,
  delta: string,
  options: { historical?: boolean; reconcile?: boolean } = {},
): string {
  const subtree = session?.rootId && state.nodes[session.rootId]
    ? rootLines(state, session.rootId, MAX_SUBTREE_LINES).join("\n")
    : "(session is not attached yet)";
  const mainlines = boundedMainlineList(state, session?.rootId ?? null);
  const currentSnapshot = session
    ? JSON.stringify(session.snapshot)
    : "(no snapshot yet)";
  const historyContract = options.historical
    ? options.reconcile
      ? `\nHISTORICAL RECONCILIATION\n- This increment is older context discovered after newer activity was already mapped.\n- Preserve the current direction. Add only genuinely missing historical background or explicit revision relationships.\n- Do not close, unblock, rename, or refocus existing nodes based only on this older context.\n- Prefer no ops when the context is already represented. The snapshot may be clarified but must still describe the current session state.\n`
      : `\nHISTORICAL IMPORT\n- This is a chronological chunk from a user-confirmed historical session import.\n- Treat it as normal evidence in its original order; later chunks may revise it.\n`
    : "";
  return `${ROLL_SENTINEL}

You update a persistent external thinking tree for a developer who runs many coding agents in parallel.

SEMANTIC AUTHORITY
- You decide which work mainline this increment belongs to, what is a structural turn, and whether the agent is waiting for the user.
- A mainline is one piece of work, never a session and never a cwd. Different sessions in the same cwd can belong to different mainlines. A new session may continue an old mainline.
- Reuse an existing mainline name whenever its meaning is the same. Do not create aliases or cosmetic variants.

MEMORY STANDARD
- Record only structural change: a new subproblem, attempt, decisive finding, blocker, decision, or turn in direction.
- Do not record routine linear progress, narration, tool chatter, or every completed step.
- A direction change is close(old node with a concrete reason) plus grow(new direction). Dead paths remain permanently useful.
- Labels must be concrete enough for a human to recover context in three seconds. "音量假设已证伪" is useful; "调试进展" is not.
- Earlier beliefs are not timeless facts. Preserve revision history structurally: close an outdated attempt with why it changed, then grow the revised direction. Never silently rewrite the path.
- If later evidence makes a previously dead or resolved path useful again, do not unblock or rewrite that closed node. Grow a new "reconsidered because ..." direction so both judgments remain intelligible.

ROLLING SESSION SNAPSHOT
- snapshot is a revisable read projection, not the permanent source of truth. The tree records the non-erased thought trajectory.
- snapshot.summary is a stable whole-session headline (what this session is really about), not the latest message. Keep it when still accurate; revise it when the session's meaning genuinely changes.
- snapshot.progress is the newest meaningful state, result, blocker, or next move. It should answer "where is this session now?" without vague progress language.
- snapshot.trail is 2-${SESSION_TRAIL_ITEMS} causal breadcrumbs for quick expansion: intent, decisive attempt/finding, rejected path, decision, and current direction. Prefer "A failed because B" over chronological narration.

RUNTIME CONTRACT
- Return one JSON object only, with no prose and no code fence.
- At most ${MAX_OPS} ops.
- mainline <= 48 characters; node labels <= 20 characters; ask.hint <= 16 characters.
- snapshot.summary <= ${SESSION_SUMMARY_CHARS} characters; snapshot.progress <= ${SESSION_PROGRESS_CHARS}; each snapshot.trail item <= ${SESSION_TRAIL_ITEM_CHARS}.
- Allowed node types: goal, task, attempt, finding, blocker, decision, note.
- For grow at the root, parent may be the literal "mainline" or the exact mainline value. Prefer "mainline". Otherwise parent must be an existing node id from CURRENT SESSION SUBTREE.
- Allowed ops:
  {"op":"grow","parent":"<node-id|mainline>","type":"<node-type>","label":"..."}
  {"op":"close","node":"<node-id>","state":"resolved|dead","note":"reason"}
  {"op":"block","node":"<node-id>","note":"what is awaited"}
  {"op":"unblock","node":"<node-id>"}
  {"op":"rename","node":"<node-id>","label":"..."}
  {"op":"refocus","node":"<node-id>"}
- The runtime allocates ids and rejects cross-mainline writes. Never invent an id for an existing node.
- unblock applies only to a waiting node. resolved/dead outcomes cannot be reopened; represent reconsideration with grow.
- ask.kind is decision, review, reply, or none. This is a semantic judgment about what the user is being asked to do now.
${historyContract}

OUTPUT SHAPE
{"mainline":"existing or new semantic mainline","ask":{"kind":"decision|review|reply|none","hint":"short"},"snapshot":{"summary":"whole-session headline","progress":"latest meaningful state","trail":["causal breadcrumb"]},"ops":[]}

EXISTING MAINLINES
${mainlines}

CURRENT SESSION SUBTREE
${subtree}

CURRENT REVISABLE SESSION SNAPSHOT
${currentSnapshot}

FILTERED TRANSCRIPT INCREMENT
<delta>
${truncateBytes(delta, 12 * 1024)}
</delta>`;
}

function unwrapRoll(value: unknown): RollOutput | null {
  if (isRecord(value)) {
    if (typeof value.mainline === "string" && Array.isArray(value.ops)) {
      const ask = isRecord(value.ask) ? value.ask : { kind: "none", hint: "" };
      return {
        mainline: value.mainline,
        ask: {
          kind: typeof ask.kind === "string" ? (ask.kind as RollOutput["ask"]["kind"]) : "none",
          hint: typeof ask.hint === "string" ? ask.hint : "",
        },
        ...(value.snapshot !== undefined ? { snapshot: value.snapshot } : {}),
        ops: value.ops,
      };
    }
    for (const key of ["result", "output", "content", "response"]) {
      const nested = value[key];
      if (typeof nested === "string") {
        const parsed = extractRollOutput(nested);
        if (parsed) return parsed;
      } else if (nested !== undefined) {
        const parsed = unwrapRoll(nested);
        if (parsed) return parsed;
      }
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = unwrapRoll(item);
      if (parsed) return parsed;
    }
  }
  return null;
}

function balancedObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return objects;
}

export function extractRollOutput(output: string): RollOutput | null {
  const trimmed = output.trim();
  try {
    const direct = unwrapRoll(JSON.parse(trimmed));
    if (direct) return direct;
  } catch {}
  for (const candidate of balancedObjects(trimmed)) {
    try {
      const parsed = unwrapRoll(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {}
  }
  return null;
}

type SpawnPlan = { command: string[]; stdin?: string };

function spawnPlan(name: EngineName, executable: string, prompt: string): SpawnPlan {
  if (name === "codex") {
    return {
      command: [executable, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"],
      stdin: prompt,
    };
  }
  if (name === "claude") {
    return {
      command: [
        executable,
        "-p",
        prompt,
        "--output-format",
        "text",
        "--permission-mode",
        "plan",
        "--tools",
        "",
      ],
    };
  }
  if (name === "kimi") {
    return {
      command: [executable, "--plan", "--quiet", "--max-steps-per-turn", "1", "-p", prompt],
    };
  }
  return {
    command: [
      executable,
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      "--max-turns",
      "1",
      "--verbatim",
      "--output-format",
      "plain",
      "-p",
      prompt,
    ],
  };
}

export async function callRollEngine(
  name: EngineName,
  prompt: string,
  cwd: string,
  timeoutMs = ROLL_TIMEOUT_MS,
): Promise<RollOutput> {
  const availability = (await detectEnginesAsync()).find((entry) => entry.name === name);
  const executable = availability?.path;
  if (!availability?.available || !executable) {
    throw new Error(`roll engine ${name} is not available${availability?.reason ? ` (${availability.reason})` : ""}`);
  }
  const plan = spawnPlan(name, executable, prompt);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CI;
  env.SESSIONMAP_ROLL = "1";
  const proc = Bun.spawn(plan.command, {
    cwd,
    env,
    stdin: plan.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (plan.stdin !== undefined && proc.stdin) {
    proc.stdin.write(plan.stdin);
    proc.stdin.end();
  }
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
  if (timedOut) {
    recentFailures.set(name, Date.now());
    throw new Error(`roll engine ${name} timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    recentFailures.set(name, Date.now());
    throw new Error(`roll engine ${name} exited ${exitCode}: ${truncateBytes(stderr, 2_000, true)}`);
  }
  const output = extractRollOutput(stdout);
  if (!output) {
    recentFailures.set(name, Date.now());
    throw new Error(`roll engine ${name} returned no valid JSON object`);
  }
  recentFailures.delete(name);
  return output;
}
