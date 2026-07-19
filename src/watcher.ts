import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LINGER_BYTES,
  LINGER_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_READ_BYTES,
  POLL_MS,
  SESSION_COOLDOWN_MS,
} from "./constants.ts";
import { readTranscriptDelta, sessionIdFromPath } from "./adapters.ts";
import { Logger } from "./logger.ts";
import { buildRollPrompt, callRollEngine } from "./roll.ts";
import { StateStore } from "./state.ts";
import { TreeRuntime } from "./tree.ts";
import type {
  EngineName,
  FilteredDelta,
  OffsetRecord,
  Provider,
  RollOutput,
  SessionRecord,
  TranscriptMeta,
} from "./types.ts";
import { nowIso, sleep } from "./utils.ts";

export interface TranscriptFile {
  path: string;
  provider: Provider;
  sessionId?: string;
  size: number;
  mtimeMs: number;
}

export type RollFunction = (
  engine: EngineName,
  prompt: string,
  cwd: string,
) => Promise<RollOutput>;

type Pending = { firstSeen: number; latestSize: number };

function filesAt(root: string, provider: Provider, depth: number): TranscriptFile[] {
  const result: TranscriptFile[] = [];
  const visit = (directory: string, remaining: number): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && remaining > 0) {
        visit(path, remaining - 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (provider === "codex" && !entry.name.startsWith("rollout-")) continue;
      try {
        const stat = statSync(path);
        result.push({
          path,
          provider,
          sessionId: sessionIdFromPath(path, provider),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }
  };
  visit(root, depth);
  return result;
}

export function discoverTranscripts(
  home = homedir(),
  additionalCodexHomes: string[] = [
    process.env.CODEX_HOME ?? "",
    join(home, "Library", "Application Support", "orca", "codex-runtime-home", "home"),
  ],
): TranscriptFile[] {
  const codexHomes = new Set([
    join(home, ".codex"),
    ...additionalCodexHomes,
  ].filter(Boolean));
  const files = [
    ...filesAt(join(home, ".claude", "projects"), "claude", 1),
    ...[...codexHomes].flatMap((codexHome) => filesAt(join(codexHome, "sessions"), "codex", 4)),
  ];
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.size - left.size);
  const logicalSessions = new Map<string, TranscriptFile>();
  for (const file of files) {
    const key = `${file.provider}:${file.sessionId ?? sessionIdFromPath(file.path, file.provider)}`;
    if (!logicalSessions.has(key)) logicalSessions.set(key, file);
  }
  return [...logicalSessions.values()].slice(0, MAX_ACTIVE_SESSIONS);
}

function storedOffset(state: ReturnType<StateStore["snapshot"]>, source: TranscriptFile): OffsetRecord | undefined {
  const direct = state.offsets[source.path];
  if (direct) return direct;
  const sessionId = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
  return Object.values(state.offsets).find(
    (record) => record.provider === source.provider && record.sessionId === sessionId,
  );
}

function sessionFromMeta(meta: TranscriptMeta, existing?: SessionRecord): SessionRecord {
  const at = nowIso();
  return {
    id: meta.sessionId,
    provider: meta.provider,
    path: meta.path,
    cwd: meta.cwd || existing?.cwd || "",
    title: meta.title || existing?.title || `${meta.provider}:${meta.sessionId.slice(0, 8)}`,
    lastUser: meta.lastUser || existing?.lastUser || "",
    mainline: existing?.mainline ?? null,
    rootId: existing?.rootId ?? null,
    cursor: existing?.cursor ?? null,
    ask: existing?.ask ?? { kind: "none", hint: "" },
    snapshot: existing?.snapshot ?? {
      summary: meta.title || `${meta.provider}:${meta.sessionId.slice(0, 8)}`,
      progress: "等待首次语义快照",
      trail: [],
      at,
    },
    status: existing?.status ?? "unknown",
    terminalOpen: existing?.terminalOpen ?? false,
    ...(existing?.terminalHandle ? { terminalHandle: existing.terminalHandle } : {}),
    ...(existing?.paneKey ? { paneKey: existing.paneKey } : {}),
    ...(existing?.pid ? { pid: existing.pid } : {}),
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastTranscriptAt: new Date(meta.mtimeMs).toISOString(),
    lastStatusAt: existing?.lastStatusAt ?? at,
    updatedAt: at,
  };
}

export class TranscriptWatcher {
  readonly #pending = new Map<string, Pending>();
  readonly #queued = new Set<string>();
  readonly #queue: TranscriptFile[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #working = false;
  #stopped = false;

  constructor(
    readonly store: StateStore,
    readonly runtime: TreeRuntime,
    readonly rollDirectory: string,
    readonly logger = new Logger(),
    readonly roll: RollFunction = callRollEngine,
    readonly discover: () => TranscriptFile[] = discoverTranscripts,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async once(): Promise<void> {
    await this.poll(true);
    while (this.#working || this.#queue.length) await sleep(10);
  }

  async poll(force = false): Promise<void> {
    if (this.#stopped && !force) return;
    const now = Date.now();
    const state = this.store.snapshot();
    for (const source of this.discover()) {
      const stored = storedOffset(state, source);
      if (stored?.ignored) continue;
      const offset = stored && stored.offset <= source.size ? stored.offset : 0;
      const available = source.size - offset;
      if (available <= 0) {
        this.#pending.delete(source.path);
        continue;
      }
      const pending = this.#pending.get(source.path) ?? { firstSeen: now, latestSize: source.size };
      pending.latestSize = source.size;
      this.#pending.set(source.path, pending);
      const cooldownUntil = stored?.cooldownUntil ?? 0;
      const ready = force || available >= LINGER_BYTES || now - pending.firstSeen >= LINGER_MS;
      if (ready && (force || now >= cooldownUntil)) this.#enqueue(source);
    }
  }

  #enqueue(source: TranscriptFile): void {
    if (this.#queued.has(source.path)) return;
    this.#queued.add(source.path);
    this.#queue.push(source);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#working) return;
    this.#working = true;
    try {
      while (this.#queue.length) {
        const source = this.#queue.shift();
        if (!source) continue;
        try {
          await this.#process(source);
        } catch (error) {
          this.logger.error("transcript roll failed", { path: source.path, error: String(error) }, source.path);
          await this.#setRetryCooldown(source);
        } finally {
          this.#queued.delete(source.path);
          this.#pending.delete(source.path);
        }
      }
    } finally {
      this.#working = false;
    }
  }

  async #process(source: TranscriptFile): Promise<void> {
    const before = this.store.snapshot();
    const offset = storedOffset(before, source);
    const initialOffset = offset && offset.offset <= source.size
      ? offset.offset
      : source.size > MAX_READ_BYTES
        ? source.size - MAX_READ_BYTES
        : 0;
    const delta = readTranscriptDelta(source.path, source.provider, {
      offset: initialOffset,
      mtimeMs: source.mtimeMs,
      ...(offset?.skipUntilNewline && initialOffset > 0 ? { skipUntilNewline: true } : {}),
    });
    if (delta.nextOffset <= initialOffset && delta.bytesRead > 0) return;
    if (delta.selfGenerated) {
      await this.#commitConsumption(delta, true);
      this.logger.info("ignored self-generated roll session", { sessionId: delta.meta.sessionId });
      return;
    }
    if (delta.lowSignal || !delta.text) {
      await this.#commitConsumption(delta, false);
      return;
    }

    const current = this.store.snapshot();
    const session = current.sessions[delta.meta.sessionId];
    const prompt = buildRollPrompt(current, session, delta.text);
    const output = await this.roll(current.engine, prompt, this.rollDirectory);

    // Deliberate at-most-once boundary: source progress is durable before non-idempotent grow ops.
    await this.#commitConsumption(delta, false);
    const applied = await this.runtime.applyRoll(delta.meta, output);
    if (applied.rejected.length) {
      this.logger.warn("runtime rejected roll operations", {
        sessionId: delta.meta.sessionId,
        rejected: applied.rejected,
      });
    }
  }

  async #commitConsumption(delta: FilteredDelta, ignored: boolean): Promise<void> {
    await this.store.update((state) => {
      const record: OffsetRecord = {
        path: delta.meta.path,
        provider: delta.meta.provider,
        sessionId: delta.meta.sessionId,
        offset: delta.nextOffset,
        mtimeMs: delta.meta.mtimeMs,
        cooldownUntil: Date.now() + SESSION_COOLDOWN_MS,
      };
      if (delta.skipUntilNewline) record.skipUntilNewline = true;
      if (ignored) record.ignored = true;
      for (const [key, existing] of Object.entries(state.offsets)) {
        if (
          key !== delta.meta.path
          && existing.provider === delta.meta.provider
          && existing.sessionId === delta.meta.sessionId
        ) delete state.offsets[key];
      }
      state.offsets[delta.meta.path] = record;
      if (!ignored) {
        state.sessions[delta.meta.sessionId] = sessionFromMeta(
          delta.meta,
          state.sessions[delta.meta.sessionId],
        );
      }
    });
  }

  async #setRetryCooldown(source: TranscriptFile): Promise<void> {
    await this.store.update((state) => {
      const existing = storedOffset(state, source);
      const sessionId = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
      for (const [key, record] of Object.entries(state.offsets)) {
        if (key !== source.path && record.provider === source.provider && record.sessionId === sessionId) {
          delete state.offsets[key];
        }
      }
      state.offsets[source.path] = {
        path: source.path,
        provider: source.provider,
        sessionId: existing?.sessionId ?? sessionId,
        offset: existing?.offset ?? 0,
        mtimeMs: source.mtimeMs,
        cooldownUntil: Date.now() + SESSION_COOLDOWN_MS,
        ...(existing?.skipUntilNewline ? { skipUntilNewline: true } : {}),
        ...(existing?.ignored ? { ignored: true } : {}),
      };
    });
  }
}
