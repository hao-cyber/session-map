import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Provider, SessionRecord } from "./types.ts";
import { controlSafe, isRecord, normalizeText, truncateChars } from "./utils.ts";

export type SourceKind = "append" | "snapshot";

export interface ProviderSource {
  path: string;
  provider: Provider;
  kind: SourceKind;
  sessionId: string;
  size: number;
  mtimeMs: number;
  cwd?: string;
  title?: string;
}

export interface ProviderIdentity {
  provider: Provider;
  sessionId: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeId(value: unknown): string {
  return typeof value === "string" && SAFE_ID.test(value) ? value : "";
}

function readJsonObject(path: string, maxBytes = 256 * 1024): Record<string, unknown> | null {
  try {
    if (statSync(path).size > maxBytes) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function walkFiles(root: string, depth: number, accept: (name: string) => boolean): string[] {
  const result: string[] = [];
  const visit = (directory: string, remaining: number): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && remaining > 0) visit(path, remaining - 1);
      else if (entry.isFile() && accept(entry.name)) result.push(path);
    }
  };
  visit(root, depth);
  return result;
}

function source(path: string, provider: Provider, kind: SourceKind, metadata: Partial<ProviderSource> = {}): ProviderSource | null {
  try {
    const stat = statSync(path);
    const sessionId = safeId(metadata.sessionId) || providerIdentityForPath(path)?.sessionId || "";
    if (!sessionId) return null;
    return { path, provider, kind, sessionId, size: stat.size, mtimeMs: stat.mtimeMs, ...metadata };
  } catch {
    return null;
  }
}

function kimiWorkdirs(kimiHome: string): Map<string, string> {
  const result = new Map<string, string>();
  const metadata = readJsonObject(join(kimiHome, "kimi.json"), 2 * 1024 * 1024);
  const workdirs = metadata && Array.isArray(metadata.work_dirs) ? metadata.work_dirs : [];
  for (const value of workdirs) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    const path = controlSafe(value.path);
    result.set(createHash("md5").update(path).digest("hex"), path);
  }
  return result;
}

function grokMetadata(path: string): { sessionId: string; cwd: string; title: string } {
  const summary = readJsonObject(join(dirname(path), "summary.json"), 512 * 1024);
  const info = summary && isRecord(summary.info) ? summary.info : {};
  let cwd = typeof info.cwd === "string" ? controlSafe(info.cwd) : "";
  if (!cwd) {
    try {
      cwd = decodeURIComponent(basename(dirname(dirname(path))));
    } catch {}
  }
  const title = truncateChars(normalizeText(
    summary?.generated_title ?? summary?.session_summary ?? "",
  ), 100);
  return {
    sessionId: safeId(info.id) || basename(dirname(path)),
    cwd,
    title,
  };
}

function minimaxMetadata(path: string): { sessionId: string; cwd: string; title: string } {
  const saved = readJsonObject(path, 4 * 1024 * 1024);
  const metadata = saved && isRecord(saved.metadata) ? saved.metadata : {};
  return {
    sessionId: safeId(metadata.id) || basename(path, ".json"),
    cwd: typeof metadata.workspace === "string" ? controlSafe(metadata.workspace) : "",
    title: truncateChars(normalizeText(metadata.title), 100),
  };
}

export function discoverProviderSources(
  home = homedir(),
  additionalCodexHomes: string[] = [
    process.env.CODEX_HOME ?? "",
    join(home, "Library", "Application Support", "orca", "codex-runtime-home", "home"),
  ],
): ProviderSource[] {
  const result: ProviderSource[] = [];
  for (const path of walkFiles(join(home, ".claude", "projects"), 1, (name) => name.endsWith(".jsonl"))) {
    const item = source(path, "claude", "append");
    if (item) result.push(item);
  }

  const codexHomes = new Set([join(home, ".codex"), ...additionalCodexHomes].filter(Boolean));
  for (const codexHome of codexHomes) {
    for (const path of walkFiles(join(codexHome, "sessions"), 4, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))) {
      const item = source(path, "codex", "append");
      if (item) result.push(item);
    }
  }

  const kimiHome = process.env.KIMI_SHARE_DIR || join(home, ".kimi");
  const workdirs = kimiWorkdirs(kimiHome);
  for (const path of walkFiles(join(kimiHome, "sessions"), 2, (name) => name === "context.jsonl")) {
    const item = source(path, "kimi", "append", { cwd: workdirs.get(basename(dirname(dirname(path)))) ?? "" });
    if (item) result.push(item);
  }

  const grokHome = process.env.GROK_HOME || join(home, ".grok");
  for (const path of walkFiles(join(grokHome, "sessions"), 2, (name) => name === "updates.jsonl")) {
    const metadata = grokMetadata(path);
    const item = source(path, "grok", "append", metadata);
    if (item) result.push(item);
  }

  for (const path of walkFiles(join(home, ".minimax", "sessions"), 0, (name) => name.endsWith(".json"))) {
    const metadata = minimaxMetadata(path);
    const item = source(path, "minimax", "snapshot", metadata);
    if (item) result.push(item);
  }
  return result;
}

export function providerIdentityForPath(path: string): ProviderIdentity | null {
  const normalized = path.replaceAll("\\", "/");
  const name = basename(path);
  if (normalized.includes("/.claude/projects/") && name.endsWith(".jsonl")) {
    const sessionId = basename(path, ".jsonl");
    return safeId(sessionId) ? { provider: "claude", sessionId } : null;
  }
  if (normalized.includes("/sessions/") && name.startsWith("rollout-") && name.endsWith(".jsonl")) {
    const stem = basename(path, ".jsonl");
    const match = stem.match(/([0-9a-f]{8}-[0-9a-f-]{20,})$/i);
    const sessionId = match?.[1] ?? stem;
    return safeId(sessionId) ? { provider: "codex", sessionId } : null;
  }
  if (normalized.includes("/.kimi/sessions/") || normalized.includes("/sessions/")) {
    if (name === "context.jsonl") {
      const sessionId = basename(dirname(path));
      return safeId(sessionId) ? { provider: "kimi", sessionId } : null;
    }
    if (name === "updates.jsonl") {
      const sessionId = basename(dirname(path));
      return safeId(sessionId) ? { provider: "grok", sessionId } : null;
    }
  }
  if (normalized.includes("/.minimax/sessions/") && name.endsWith(".json")) {
    const sessionId = basename(path, ".json");
    return safeId(sessionId) ? { provider: "minimax", sessionId } : null;
  }
  return null;
}

export function providerForPath(path: string): Provider | null {
  return providerIdentityForPath(path)?.provider ?? null;
}

export function providerProcessNames(): Provider[] {
  return ["codex", "claude", "kimi", "grok", "minimax"];
}

export function providerHomeForSource(session: Pick<SessionRecord, "provider" | "path">): { name: string; value: string } | null {
  const marker = "/sessions/";
  const index = controlSafe(session.path).lastIndexOf(marker);
  if (!session.path.startsWith("/") || index <= 0) return null;
  const value = session.path.slice(0, index);
  if (session.provider === "codex") return { name: "CODEX_HOME", value };
  if (session.provider === "kimi") return { name: "KIMI_SHARE_DIR", value };
  if (session.provider === "grok") return { name: "GROK_HOME", value };
  return null;
}

export function providerResumeArgs(provider: Provider, sessionId: string): string[] {
  if (provider === "claude") return ["claude", "--resume", sessionId];
  if (provider === "codex") return ["codex", "resume", "-c", "check_for_update_on_startup=false", sessionId];
  if (provider === "kimi") return ["kimi", "--session", sessionId];
  if (provider === "grok") return ["grok", "--resume", sessionId];
  return ["minimax", "--resume", sessionId];
}

export function providerExecutableMatches(provider: Provider, executable: string): boolean {
  const name = basename(executable.replace(/^['"]|['"]$/g, ""));
  return name === provider || name === `${provider}.js` || name.startsWith(`${provider}-`);
}

export function sourceExists(path: string): boolean {
  return existsSync(path);
}
