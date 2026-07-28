import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { ENGINE_NAMES, ROLL_TIMEOUT_MS } from "./constants.ts";
import type { EngineAvailability, EngineName, RollEngineResult, TokenUsage } from "./types.ts";
import { isRecord, truncateBytes } from "./utils.ts";
import { extractRollOutput } from "./roll-contract.ts";

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
        "json",
        "--permission-mode",
        "plan",
        "--tools",
        "",
      ],
    };
  }
  if (name === "kimi") {
    return {
      command: [executable, "--plan", "--print", "--output-format", "stream-json", "--max-steps-per-turn", "1", "-p", prompt],
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
      "json",
      "-p",
      prompt,
    ],
  };
}

function tokenNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return 0;
}

export function extractTokenUsage(stdout: string): TokenUsage | null {
  const values: unknown[] = [];
  try { values.push(JSON.parse(stdout)); } catch {}
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch {}
  }
  const candidates: TokenUsage[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    const inputTokens = tokenNumber(value, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
    const outputTokens = tokenNumber(value, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
    const reportedTotal = tokenNumber(value, "total_tokens", "totalTokens");
    const cachedInputTokens = tokenNumber(
      value,
      "cached_input_tokens",
      "cachedInputTokens",
      "cache_read_input_tokens",
      "cacheReadInputTokens",
    );
    const totalTokens = reportedTotal || inputTokens + outputTokens;
    if (totalTokens > 0 && (inputTokens > 0 || outputTokens > 0 || reportedTotal > 0)) {
      candidates.push({
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      });
    }
    for (const child of Object.values(value)) if (typeof child !== "string") visit(child);
  };
  values.forEach(visit);
  return candidates.sort((left, right) => right.totalTokens - left.totalTokens)[0] ?? null;
}

export async function callRollEngine(
  name: EngineName,
  prompt: string,
  cwd: string,
  timeoutMs = ROLL_TIMEOUT_MS,
): Promise<RollEngineResult> {
  const availability = (await detectEnginesAsync()).find((entry) => entry.name === name);
  const executable = availability?.path;
  if (!availability?.available || !executable) {
    throw new Error(`roll engine ${name} is not available${availability?.reason ? ` (${availability.reason})` : ""}`);
  }
  const plan = spawnPlan(name, executable, prompt);
  if (name === "codex") plan.command.splice(plan.command.length - 1, 0, "--json");
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
  const usage = extractTokenUsage(stdout);
  return { output, ...(usage ? { usage } : {}) };
}
