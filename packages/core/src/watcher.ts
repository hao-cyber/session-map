import { homedir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_RANGE_DAYS,
  HISTORY_QUEUE_BUFFER,
  HISTORY_RETRY_BASE_MS,
  HISTORY_RETRY_LIMIT,
  LINGER_BYTES,
  LINGER_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_HISTORY_ROLLS,
  MAX_ROLL_CONCURRENCY,
  POLL_MS,
  SESSION_COOLDOWN_MS,
  STALE_RETRY_LIMIT,
} from "./constants.ts";
import { readTranscriptDelta, sessionIdFromPath } from "./adapters.ts";
import { Logger } from "./logger.ts";
import { callRollEngine } from "./roll-engine.ts";
import { buildRollPrompt } from "./roll.ts";
import { StateStore } from "./state-store.ts";
import { sessionIdentity, sessionIsExcluded, TreeRuntime } from "./tree.ts";
import type {
  EngineName,
  FilteredDelta,
  HistoryImportJob,
  HistoryImportItem,
  OffsetRecord,
  Provider,
  ProviderSummaryHint,
  RollEngineResult,
  RollOutput,
  SessionRecord,
  SourceKind,
  TrailState,
  TranscriptMeta,
} from "./types.ts";
import { canonicalMainline, nowIso, sleep } from "./utils.ts";
import { discoverProviderSources, type ProviderSource } from "./providers.ts";

export interface TranscriptFile {
  path: string;
  provider: Provider;
  sessionId?: string;
  kind?: SourceKind;
  cwd?: string;
  title?: string;
  summaryHint?: ProviderSummaryHint;
  size: number;
  mtimeMs: number;
}

export type RollFunction = (
  engine: EngineName,
  prompt: string,
  cwd: string,
) => Promise<RollOutput | RollEngineResult>;

type Pending = { firstSeen: number; latestSize: number };
type WorkLane = "live-new" | "live-update" | "history";
type WorkStage = "queued" | "reading" | "rolling" | "validating" | "committing";
type WorkItem = {
  mode: "live" | "history";
  lane: WorkLane;
  sequence: number;
  source: TranscriptFile;
  historyKey?: string;
  historyJobId?: string;
};
type WorkActivity = {
  lane: WorkLane;
  stage: WorkStage;
  provider: Provider;
  sessionId: string;
  title: string;
  startedAt: string;
  updatedAt: string;
};

export interface IntakeRangePreview {
  days: number;
  cutoffAt: string;
  sessions: number;
  bytes: number;
}

export interface IntakeView {
  phase: "awaiting-choice" | "importing" | "complete";
  coverageStartAt: string | null;
  lastDiscoveryAt: string | null;
  inventory: {
    total: number;
    providers: Partial<Record<Provider, number>>;
    ranges: IntakeRangePreview[];
    activity: Array<{ mtimeMs: number; size: number }>;
  };
  job: null | {
    id: string;
    status: "running" | "paused" | "complete" | "cancelled";
    cutoffAt: string;
    total: number;
    completed: number;
    failed: number;
    active: number;
    maxParallel: number;
    processedBytes: number;
    totalBytes: number;
    lastProgressAt: string;
    waitingRetry: number;
    liveActive: number;
    liveQueued: number;
    activities: Array<WorkActivity & { processedBytes: number; totalBytes: number; error?: string }>;
    current: null | {
      provider: Provider;
      sessionId: string;
      title: string;
      path: string;
      processedBytes: number;
      totalBytes: number;
      error?: string;
    };
  };
}

function sessionKey(source: Pick<TranscriptFile, "provider" | "sessionId" | "path">): string {
  return sessionIdentity(source.provider, source.sessionId ?? sessionIdFromPath(source.path, source.provider));
}

function dedupeSources(files: ProviderSource[]): TranscriptFile[] {
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.size - left.size);
  const logicalSessions = new Map<string, TranscriptFile>();
  for (const file of files) {
    const key = sessionKey(file);
    if (!logicalSessions.has(key)) logicalSessions.set(key, file);
  }
  return [...logicalSessions.values()];
}

function rootFingerprint(state: TrailState, rootId: string | null): string {
  if (!rootId || !state.nodes[rootId]) return "";
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !state.nodes[id]) continue;
    seen.add(id);
    ids.push(id);
    stack.push(...state.nodes[id]!.children);
  }
  ids.sort();
  const nodes = ids.map((id) => {
    const node = state.nodes[id]!;
    return [id, node.parent, node.type, node.label, node.state, node.note, node.blockedNote, node.children];
  });
  const sessions = Object.values(state.sessions)
    .filter((session) => session.rootId === rootId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => [session.id, session.cursor, session.lastTranscriptAt, session.snapshot]);
  return JSON.stringify([nodes, sessions]);
}

function directoryFingerprint(state: TrailState): string {
  return JSON.stringify(state.roots.map((rootId) => {
    const root = state.nodes[rootId];
    const sessions = Object.values(state.sessions)
      .filter((session) => session.rootId === rootId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => [session.id, session.cursor, session.lastTranscriptAt, session.snapshot.summary]);
    return [rootId, root?.label, state.archived.includes(rootId), sessions];
  }));
}

function candidateIsFresh(
  base: TrailState,
  current: TrailState,
  sessionId: string,
  output: RollOutput,
  snapshotOnly = false,
): boolean {
  const baseSource = base.sessions[sessionId]?.rootId ?? null;
  const currentSource = current.sessions[sessionId]?.rootId ?? null;
  if (baseSource !== currentSource || rootFingerprint(base, baseSource) !== rootFingerprint(current, currentSource)) {
    return false;
  }
  if (snapshotOnly) return true;
  const mainline = canonicalMainline(output.mainline);
  if (!mainline) return true;
  const baseTarget = base.mainlineIndex[mainline] ?? null;
  const currentTarget = current.mainlineIndex[mainline] ?? null;
  if (baseTarget) {
    return baseTarget === currentTarget
      && rootFingerprint(base, baseTarget) === rootFingerprint(current, currentTarget);
  }
  // Exact-name convergence is safe: a candidate that did not see this target can
  // only grow from the root on an unattached/reattach round; TreeRuntime still
  // rejects every stale or cross-mainline node reference.
  if (currentTarget) return true;
  return directoryFingerprint(base) === directoryFingerprint(current);
}

export function discoverAllTranscripts(
  home = homedir(),
  additionalCodexHomes: string[] = [
    process.env.CODEX_HOME ?? "",
    join(home, "Library", "Application Support", "orca", "codex-runtime-home", "home"),
  ],
): TranscriptFile[] {
  return dedupeSources(discoverProviderSources(home, additionalCodexHomes));
}

export function discoverTranscripts(
  home = homedir(),
  additionalCodexHomes?: string[],
): TranscriptFile[] {
  return discoverAllTranscripts(home, additionalCodexHomes).slice(0, MAX_ACTIVE_SESSIONS);
}

function storedOffset(state: ReturnType<StateStore["snapshot"]>, source: TranscriptFile): OffsetRecord | undefined {
  const direct = state.offsets[source.path];
  if (direct) return direct;
  const id = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
  return Object.values(state.offsets).find(
    (record) => record.provider === source.provider && record.sessionId === id,
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
  readonly #queue: WorkItem[] = [];
  readonly #activeSessions = new Set<string>();
  readonly #activities = new Map<string, WorkActivity>();
  #inventory: TranscriptFile[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #activeWorkers = 0;
  #activeHistory = 0;
  #committing = 0;
  #commitTail: Promise<void> = Promise.resolve();
  #sequence = 0;
  #stopped = false;

  constructor(
    readonly store: StateStore,
    readonly runtime: TreeRuntime,
    readonly rollDirectory: string,
    readonly logger = new Logger(),
    readonly roll: RollFunction = callRollEngine,
    readonly discover: () => TranscriptFile[] = discoverAllTranscripts,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    void this.checkNow();
    this.#timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async once(): Promise<void> {
    await this.poll(true);
    while (this.#activeWorkers || this.#queue.length || this.#committing) await sleep(10);
  }

  intakeView(now = Date.now()): IntakeView {
    if (!this.#inventory.length) this.#inventory = this.discover();
    const state = this.store.snapshot();
    const visibleInventory = this.#inventory.filter((source) => !state.excludedSessions[sessionKey(source)]);
    const eligible = visibleInventory.filter((source) => !state.intake.imported[sessionKey(source)]);
    const providers: Partial<Record<Provider, number>> = {};
    for (const source of visibleInventory) providers[source.provider] = (providers[source.provider] ?? 0) + 1;
    const ranges = HISTORY_RANGE_DAYS.map((days) => {
      const cutoff = now - days * 86_400_000;
      const matches = eligible.filter((source) => source.mtimeMs >= cutoff);
      return {
        days,
        cutoffAt: new Date(cutoff).toISOString(),
        sessions: matches.length,
        bytes: matches.reduce((sum, source) => sum + source.size, 0),
      };
    });
    const job = state.intake.job;
    const items = job ? Object.values(job.items) : [];
    const processedBytes = items.reduce(
      (sum, item) => sum + Math.min(item.plannedSize, Math.max(0, item.cursor)),
      0,
    );
    const totalBytes = items.reduce((sum, item) => sum + item.plannedSize, 0);
    const currentItem = items.find((item) => item.status === "running")
      ?? (job?.status === "paused" ? items.find((item) => item.status === "failed") : undefined)
      ?? items.find((item) => item.status === "pending")
      ?? items.find((item) => item.status === "failed")
      ?? null;
    const source = currentItem
      ? this.#inventory.find((candidate) => sessionKey(candidate) === currentItem.key)
      : undefined;
    const historyActivities = [...this.#activities.entries()]
      .filter(([, activity]) => activity.lane === "history")
      .map(([key, activity]) => {
        const item = items.find((candidate) => `history:${job?.id ?? ""}:${candidate.key}` === key);
        return {
          ...activity,
          processedBytes: item ? Math.min(item.plannedSize, Math.max(0, item.cursor)) : 0,
          totalBytes: item?.plannedSize ?? 0,
          ...(item?.error ? { error: item.error } : {}),
        };
      });
    const liveActivities = [...this.#activities.values()].filter((activity) => activity.lane !== "history");
    return {
      phase: state.intake.phase,
      coverageStartAt: state.intake.coverageStartAt,
      lastDiscoveryAt: state.intake.lastDiscoveryAt,
      inventory: {
        total: visibleInventory.length,
        providers,
        ranges,
        activity: eligible.map((source) => ({ mtimeMs: source.mtimeMs, size: source.size })),
      },
      job: job ? {
        id: job.id,
        status: job.status,
        cutoffAt: job.cutoffAt,
        total: items.length,
        completed: items.filter((item) => item.status === "complete" || item.status === "skipped").length,
        failed: items.filter((item) => item.status === "failed").length,
        active: items.filter((item) => item.status === "running").length,
        maxParallel: MAX_HISTORY_ROLLS,
        processedBytes,
        totalBytes,
        lastProgressAt: job.lastProgressAt,
        waitingRetry: items.filter((item) => item.status === "pending" && item.retryAt && Date.parse(item.retryAt) > now).length,
        liveActive: liveActivities.filter((activity) => activity.stage !== "queued").length,
        liveQueued: liveActivities.filter((activity) => activity.stage === "queued").length,
        activities: historyActivities,
        current: currentItem ? {
          provider: currentItem.provider,
          sessionId: currentItem.sessionId,
          title: source?.title || `${currentItem.provider}:${currentItem.sessionId.slice(0, 8)}`,
          path: currentItem.path,
          processedBytes: Math.min(currentItem.plannedSize, Math.max(0, currentItem.cursor)),
          totalBytes: currentItem.plannedSize,
          ...(currentItem.error ? { error: currentItem.error } : {}),
        } : null,
      } : null,
    };
  }

  async checkNow(): Promise<IntakeView> {
    this.#inventory = this.discover();
    const checkedAt = nowIso();
    await this.store.update((state) => { state.intake.lastDiscoveryAt = checkedAt; });
    await this.poll(true, this.#inventory);
    return this.intakeView();
  }

  async chooseHistory(cutoffAt: string | null): Promise<IntakeView> {
    this.#inventory = this.discover();
    const cutoffMs = cutoffAt === null ? null : Date.parse(cutoffAt);
    if (cutoffAt !== null && !Number.isFinite(cutoffMs)) throw new Error("invalid history cutoff");
    const selectedCutoff = cutoffAt;
    const at = nowIso();
    await this.store.update((state) => {
      if (state.intake.job?.status === "running" || state.intake.job?.status === "paused") {
        throw new Error("a history import is already active");
      }
      const firstChoice = state.intake.phase === "awaiting-choice";
      for (const source of this.#inventory) {
        const id = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
        if (sessionIsExcluded(state, source.provider, id)) continue;
        const existing = storedOffset(state, source);
        if (!firstChoice && existing) continue;
        for (const [key, record] of Object.entries(state.offsets)) {
          if (key !== source.path && record.provider === source.provider && record.sessionId === id) delete state.offsets[key];
        }
        state.offsets[source.path] = {
          path: source.path,
          provider: source.provider,
          sessionId: id,
          offset: source.size,
          mtimeMs: source.mtimeMs,
          cooldownUntil: 0,
        };
      }
      state.intake.lastDiscoveryAt = at;
      if (cutoffMs === null) {
        state.intake.phase = "complete";
        state.intake.job = null;
        return;
      }
      const selected = this.#inventory.filter((source) =>
        source.mtimeMs >= (cutoffMs ?? Number.POSITIVE_INFINITY)
        && !state.excludedSessions[sessionKey(source)]
      );
      const items: Record<string, HistoryImportItem> = {};
      for (const source of selected) {
        const key = sessionKey(source);
        if (state.intake.imported[key]) continue;
        const id = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
        items[key] = {
          key,
          provider: source.provider,
          sessionId: id,
          path: source.path,
          kind: source.kind ?? "append",
          plannedSize: source.size,
          plannedMtimeMs: source.mtimeMs,
          cursor: 0,
          status: "pending",
          reconcile: Boolean(state.sessions[id]),
        };
      }
      if (!Object.keys(items).length) {
        state.intake.phase = "complete";
        state.intake.coverageStartAt = earlierIso(state.intake.coverageStartAt, selectedCutoff!);
        state.intake.job = null;
        return;
      }
      state.intake.phase = "importing";
      state.intake.job = {
        id: crypto.randomUUID(),
        createdAt: at,
        cutoffAt: selectedCutoff!,
        highWaterAt: at,
        lastProgressAt: at,
        status: "running",
        items,
      };
    });
    await this.poll(true, this.#inventory);
    return this.intakeView();
  }

  async pauseHistory(): Promise<IntakeView> {
    let jobId = "";
    await this.store.update((state) => {
      if (!state.intake.job || state.intake.job.status !== "running") throw new Error("no running history import");
      jobId = state.intake.job.id;
      state.intake.job.status = "paused";
      for (const item of Object.values(state.intake.job.items)) {
        if (item.status === "running") item.status = "pending";
      }
    });
    this.#dropQueuedHistory(jobId);
    return this.intakeView();
  }

  async resumeHistory(): Promise<IntakeView> {
    await this.store.update((state) => {
      const job = state.intake.job;
      if (!job || job.status !== "paused") throw new Error("no paused history import");
      for (const item of Object.values(job.items)) {
        if (item.status === "failed") {
          item.status = "pending";
          delete item.error;
          delete item.retryAt;
          delete item.retryCount;
        }
      }
      job.status = "running";
      state.intake.phase = "importing";
    });
    await this.poll(true);
    return this.intakeView();
  }

  async cancelHistory(): Promise<IntakeView> {
    let jobId = "";
    await this.store.update((state) => {
      const job = state.intake.job;
      if (!job || job.status === "complete") throw new Error("no active history import");
      jobId = job.id;
      for (const item of Object.values(job.items)) {
        if (item.status === "pending" || item.status === "running" || item.status === "failed") item.status = "skipped";
      }
      job.status = "cancelled";
      state.intake.phase = "complete";
    });
    this.#dropQueuedHistory(jobId);
    return this.intakeView();
  }

  async poll(force = false, discovered?: TranscriptFile[]): Promise<void> {
    if (this.#stopped && !force) return;
    this.#inventory = discovered ?? this.discover();
    const state = this.store.snapshot();
    if (state.intake.phase === "awaiting-choice") return;
    this.#enqueueHistory(state, force);
    const blocked = new Set(
      state.intake.job?.status === "running"
        ? Object.values(state.intake.job.items)
          .filter((item) => item.status === "pending" || item.status === "running" || item.status === "failed")
          .map((item) => item.key)
        : [],
    );
    const now = Date.now();
    const liveSources = this.#inventory
      .filter((source) => !state.excludedSessions[sessionKey(source)])
      .slice(0, MAX_ACTIVE_SESSIONS);
    for (const source of liveSources) {
      if (blocked.has(sessionKey(source))) continue;
      const stored = storedOffset(state, source);
      if (stored?.ignored) continue;
      const snapshotChanged = source.kind === "snapshot" && stored?.mtimeMs !== source.mtimeMs;
      const summaryChanged = Boolean(
        source.summaryHint
        && state.sessions[source.sessionId ?? sessionIdFromPath(source.path, source.provider)]
        && stored?.summaryVersion !== source.summaryHint.version,
      );
      const offset = source.kind === "snapshot"
        ? (snapshotChanged ? 0 : source.size)
        : stored && stored.offset <= source.size ? stored.offset : 0;
      const available = source.size - offset;
      if (available <= 0 && !summaryChanged) {
        this.#pending.delete(source.path);
        continue;
      }
      const pending = this.#pending.get(source.path) ?? { firstSeen: now, latestSize: source.size };
      pending.latestSize = source.size;
      this.#pending.set(source.path, pending);
      const cooldownUntil = stored?.cooldownUntil ?? 0;
      // Existing sessions linger so a burst of transcript writes becomes one
      // semantic roll. A newly discovered session has no map entry at all, so
      // imposing the same delay makes its first reliable entry appear more
      // than a minute late before model latency is even counted.
      const firstLiveIncrement = stored === undefined;
      const ready = force || firstLiveIncrement || summaryChanged || source.kind === "snapshot" || available >= LINGER_BYTES || now - pending.firstSeen >= LINGER_MS;
      if (ready && (force || now >= cooldownUntil)) {
        this.#enqueue({ mode: "live", lane: firstLiveIncrement ? "live-new" : "live-update", source });
      }
    }
  }

  #enqueueHistory(state: ReturnType<StateStore["snapshot"]>, force = false): void {
    const job = state.intake.job;
    if (!job || job.status !== "running") return;
    const queuedHistory = this.#queue.filter((item) => item.mode === "history").length;
    let capacity = Math.max(0, HISTORY_QUEUE_BUFFER - queuedHistory);
    const items = Object.values(job.items)
      .filter((candidate) => (candidate.status === "pending" || candidate.status === "running")
        && (force || !candidate.retryAt || Date.parse(candidate.retryAt) <= Date.now()))
      .sort((left, right) => right.plannedMtimeMs - left.plannedMtimeMs);
    for (const item of items) {
      if (capacity <= 0) break;
      const source = this.#inventory.find((candidate) => sessionKey(candidate) === item.key) ?? {
        path: item.path,
        provider: item.provider,
        sessionId: item.sessionId,
        kind: item.kind,
        size: item.plannedSize,
        mtimeMs: item.plannedMtimeMs,
      };
      if (this.#enqueue({ mode: "history", lane: "history", source, historyKey: item.key, historyJobId: job.id })) capacity -= 1;
    }
  }

  #workKey(item: WorkItem): string {
    return item.mode === "history"
      ? `history:${item.historyJobId ?? ""}:${item.historyKey ?? item.source.path}`
      : `live:${item.source.path}`;
  }

  #enqueue(input: Omit<WorkItem, "sequence">): boolean {
    const item: WorkItem = { ...input, sequence: this.#sequence++ };
    const key = this.#workKey(item);
    if (this.#queued.has(key)) return false;
    this.#queued.add(key);
    this.#queue.push(item);
    const priority: Record<WorkLane, number> = { "live-new": 0, "live-update": 1, history: 2 };
    this.#queue.sort((left, right) => priority[left.lane] - priority[right.lane] || left.sequence - right.sequence);
    this.#setActivity(item, "queued");
    this.#drain();
    return true;
  }

  #drain(): void {
    while (this.#activeWorkers < MAX_ROLL_CONCURRENCY) {
      const index = this.#queue.findIndex((item) => {
        if (this.#activeSessions.has(sessionKey(item.source))) return false;
        return item.mode === "live" || this.#activeHistory < MAX_HISTORY_ROLLS;
      });
      if (index < 0) return;
      const [item] = this.#queue.splice(index, 1);
      if (!item) return;
      const logicalKey = sessionKey(item.source);
      this.#activeWorkers += 1;
      if (item.mode === "history") this.#activeHistory += 1;
      this.#activeSessions.add(logicalKey);
      this.#setActivity(item, "reading");
      void this.#run(item, logicalKey);
    }
  }

  async #run(item: WorkItem, logicalKey: string): Promise<void> {
    const key = this.#workKey(item);
    const startedAt = Date.now();
    try {
      if (item.mode === "history" && item.historyKey && item.historyJobId) {
        await this.#processHistory(item);
      } else await this.#processLive(item);
    } catch (error) {
      this.logger.error("transcript roll failed", {
        provider: item.source.provider,
        sessionId: item.source.sessionId ?? sessionIdFromPath(item.source.path, item.source.provider),
        mode: item.mode,
        durationMs: Date.now() - startedAt,
        error: String(error),
      }, logicalKey);
      if (item.mode === "history" && item.historyKey && item.historyJobId) {
        await this.#setHistoryFailure(item.historyKey, item.historyJobId, error);
        this.#dropQueuedHistory(item.historyJobId);
      } else await this.#setRetryCooldown(item.source);
    } finally {
      this.#queued.delete(key);
      this.#activities.delete(key);
      this.#pending.delete(item.source.path);
      this.#activeSessions.delete(logicalKey);
      this.#activeWorkers -= 1;
      if (item.mode === "history") this.#activeHistory -= 1;
      await this.poll(false);
      this.#drain();
    }
  }

  #setActivity(item: WorkItem, stage: WorkStage): void {
    const key = this.#workKey(item);
    const previous = this.#activities.get(key);
    const at = nowIso();
    this.#activities.set(key, {
      lane: item.lane,
      stage,
      provider: item.source.provider,
      sessionId: item.source.sessionId ?? sessionIdFromPath(item.source.path, item.source.provider),
      title: item.source.title || `${item.source.provider}:${(item.source.sessionId ?? sessionIdFromPath(item.source.path, item.source.provider)).slice(0, 8)}`,
      startedAt: previous?.startedAt ?? at,
      updatedAt: at,
    });
  }

  #dropQueuedHistory(jobId: string): void {
    const job = this.store.snapshot().intake.job;
    if (job?.id === jobId && job.status === "running") return;
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index];
      if (item?.mode !== "history" || item.historyJobId !== jobId) continue;
      this.#queued.delete(this.#workKey(item));
      this.#queue.splice(index, 1);
    }
  }

  async #serializeCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#commitTail;
    let release!: () => void;
    this.#commitTail = new Promise<void>((resolve) => { release = resolve; });
    this.#committing += 1;
    await previous;
    try {
      return await operation();
    } finally {
      this.#committing -= 1;
      release();
    }
  }

  async #invokeRoll(
    engine: EngineName,
    prompt: string,
    source: TranscriptFile,
    mode: "live" | "history",
    attempt: "initial" | "stale-retry",
  ): Promise<RollOutput> {
    const startedAt = Date.now();
    const fields = {
      engine,
      mode,
      attempt,
      provider: source.provider,
      sessionId: source.sessionId ?? sessionIdFromPath(source.path, source.provider),
    };
    if (this.logger.path) this.logger.info("roll invocation started", fields);
    const result = await this.roll(engine, prompt, this.rollDirectory);
    const wrapped = typeof result === "object" && result !== null && "output" in result
      ? result as RollEngineResult
      : null;
    const output = wrapped?.output ?? result as RollOutput;
    if (wrapped) {
      await this.store.update((state) => {
        if (!wrapped.usage) {
          state.rollUsage.unreportedCalls += 1;
          return;
        }
        state.rollUsage.inputTokens += wrapped.usage.inputTokens;
        state.rollUsage.outputTokens += wrapped.usage.outputTokens;
        state.rollUsage.totalTokens += wrapped.usage.totalTokens;
        state.rollUsage.cachedInputTokens += wrapped.usage.cachedInputTokens ?? 0;
        state.rollUsage.measuredCalls += 1;
        state.rollUsage.last = { ...wrapped.usage, engine, at: nowIso() };
      });
    }
    if (this.logger.path) this.logger.info("roll invocation completed", {
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    return output;
  }

  async #processLive(item: WorkItem): Promise<void> {
    const source = item.source;
    const before = this.store.snapshot();
    const offset = storedOffset(before, source);
    const initialOffset = source.kind === "snapshot" ? 0 : offset?.offset ?? 0;
    const summaryHint = source.summaryHint?.version !== offset?.summaryVersion
      ? source.summaryHint
      : undefined;
    const delta = readTranscriptDelta(source.path, source.provider, {
      offset: initialOffset,
      mtimeMs: source.mtimeMs,
      kind: source.kind ?? "append",
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(source.cwd ? { cwd: source.cwd } : {}),
      ...(source.title ? { title: source.title } : {}),
      ...(summaryHint ? { summaryHint } : {}),
      ...(offset?.skipUntilNewline && initialOffset > 0 ? { skipUntilNewline: true } : {}),
    });
    if (delta.nextOffset <= initialOffset && delta.bytesRead > 0 && !delta.summaryHint) return;
    if (delta.selfGenerated) {
      await this.#serializeCommit(() => this.#commitLive(delta, true));
      return;
    }
    if ((delta.lowSignal || !delta.text) && !delta.summaryHint) {
      await this.#serializeCommit(() => this.#commitLive(delta, false));
      return;
    }
    let base = this.store.snapshot();
    const snapshotOnly = delta.lowSignal || !delta.text;
    if (snapshotOnly && !base.sessions[delta.meta.sessionId]) {
      await this.#serializeCommit(() => this.#commitLive(delta, false));
      return;
    }
    this.#setActivity(item, "rolling");
    let output = await this.#invokeRoll(
      base.engine,
      buildRollPrompt(base, base.sessions[delta.meta.sessionId], delta.text, {
        ...(delta.summaryHint ? { summaryHint: delta.summaryHint } : {}),
        snapshotOnly,
      }),
      source,
      "live",
      "initial",
    );
    for (let staleRetries = 0; staleRetries <= STALE_RETRY_LIMIT; staleRetries += 1) {
      this.#setActivity(item, "validating");
      const result = await this.#serializeCommit(async () => {
        const currentOffset = storedOffset(this.store.snapshot(), source);
        if ((currentOffset?.offset ?? 0) !== initialOffset) return { done: true, current: null };
        const current = this.store.snapshot();
        if (!candidateIsFresh(base, current, delta.meta.sessionId, output, snapshotOnly)) return { done: false, current };
        this.#setActivity(item, "committing");
        await this.#commitLive(delta, false);
        await this.#apply(delta.meta, output, snapshotOnly);
        return { done: true, current: null };
      });
      if (result.done) return;
      if (staleRetries === STALE_RETRY_LIMIT || !result.current) throw new Error("live roll candidate stayed stale");
      base = result.current;
      this.#setActivity(item, "rolling");
      output = await this.#invokeRoll(
        base.engine,
        buildRollPrompt(base, base.sessions[delta.meta.sessionId], delta.text, {
          ...(delta.summaryHint ? { summaryHint: delta.summaryHint } : {}),
          snapshotOnly,
        }),
        source,
        "live",
        "stale-retry",
      );
    }
  }

  async #processHistory(work: WorkItem): Promise<void> {
    const source = work.source;
    const historyKey = work.historyKey!;
    const historyJobId = work.historyJobId!;
    const before = this.store.snapshot();
    const job = before.intake.job;
    const item = job?.items[historyKey];
    if (!job || job.id !== historyJobId || job.status !== "running" || !item || (item.status !== "pending" && item.status !== "running")) return;
    const claimed = await this.store.update((state) => {
      const currentJob = state.intake.job;
      const current = currentJob?.items[historyKey];
      if (!currentJob || currentJob.id !== historyJobId || currentJob.status !== "running" || !current) return false;
      if (current.status === "pending") current.status = "running";
      return current.status === "running" && current.cursor === item.cursor;
    });
    if (!claimed) return;
    const delta = readTranscriptDelta(source.path, source.provider, {
      offset: item.kind === "snapshot" ? 0 : item.cursor,
      ...(item.kind === "append" ? { endOffset: item.plannedSize } : {}),
      ...(item.kind === "append" ? { includeFinalLine: true } : {}),
      mtimeMs: source.mtimeMs,
      kind: item.kind,
      sessionId: item.sessionId,
      ...(source.cwd ? { cwd: source.cwd } : {}),
      ...(source.title ? { title: source.title } : {}),
      ...(item.cursor === 0 && source.summaryHint ? { summaryHint: source.summaryHint } : {}),
      ...(item.skipUntilNewline && item.cursor > 0 ? { skipUntilNewline: true } : {}),
    });
    if (delta.selfGenerated) {
      await this.#serializeCommit(async () => {
        const committed = await this.#commitHistory(historyKey, historyJobId, item.cursor, delta, "skipped");
        if (committed) await this.#markLiveIgnored(delta);
      });
      return;
    }
    if ((delta.lowSignal || !delta.text) && !delta.summaryHint) {
      await this.#serializeCommit(() => this.#commitHistory(historyKey, historyJobId, item.cursor, delta));
      return;
    }
    let base = this.store.snapshot();
    const snapshotOnly = delta.lowSignal || !delta.text;
    if (snapshotOnly && !base.sessions[delta.meta.sessionId]) {
      await this.#serializeCommit(() => this.#commitHistory(historyKey, historyJobId, item.cursor, delta));
      return;
    }
    const prompt = buildRollPrompt(base, base.sessions[delta.meta.sessionId], delta.text, {
      historical: true,
      reconcile: item.reconcile,
      ...(delta.summaryHint ? { summaryHint: delta.summaryHint } : {}),
      snapshotOnly,
    });
    this.#setActivity(work, "rolling");
    let output = await this.#invokeRoll(base.engine, prompt, source, "history", "initial");
    for (let staleRetries = 0; staleRetries <= STALE_RETRY_LIMIT; staleRetries += 1) {
      this.#setActivity(work, "validating");
      const result = await this.#serializeCommit(async () => {
        const current = this.store.snapshot();
        const currentJob = current.intake.job;
        const currentItem = currentJob?.items[historyKey];
        if (!currentJob || currentJob.id !== historyJobId || currentJob.status !== "running"
          || currentItem?.status !== "running" || currentItem.cursor !== item.cursor) {
          return { done: true, current: null };
        }
        if (!candidateIsFresh(base, current, delta.meta.sessionId, output, snapshotOnly)) return { done: false, current };
        this.#setActivity(work, "committing");
        const committed = await this.#commitHistory(historyKey, historyJobId, item.cursor, delta);
        if (committed) await this.#apply(delta.meta, output, snapshotOnly);
        return { done: true, current: null };
      });
      if (result.done) return;
      if (staleRetries === STALE_RETRY_LIMIT || !result.current) throw new Error("history roll candidate stayed stale");
      base = result.current;
      const currentItem = base.intake.job?.items[historyKey];
      this.#setActivity(work, "rolling");
      output = await this.#invokeRoll(
        base.engine,
        buildRollPrompt(base, base.sessions[delta.meta.sessionId], delta.text, {
          historical: true,
          reconcile: currentItem?.reconcile ?? item.reconcile,
          ...(delta.summaryHint ? { summaryHint: delta.summaryHint } : {}),
          snapshotOnly,
        }),
        source,
        "history",
        "stale-retry",
      );
    }
  }

  async #apply(meta: TranscriptMeta, output: RollOutput, snapshotOnly = false): Promise<void> {
    const applied = await this.runtime.applyRoll(meta, output, { snapshotOnly });
    if (applied.rejected.length) this.logger.warn("runtime rejected roll operations", { sessionId: meta.sessionId, rejected: applied.rejected });
  }

  async #commitLive(delta: FilteredDelta, ignored: boolean): Promise<void> {
    await this.store.update((state) => {
      if (sessionIsExcluded(state, delta.meta.provider, delta.meta.sessionId)) return;
      writeOffset(state, delta, ignored);
      if (!ignored) state.sessions[delta.meta.sessionId] = sessionFromMeta(delta.meta, state.sessions[delta.meta.sessionId]);
    });
  }

  async #commitHistory(
    historyKey: string,
    historyJobId: string,
    expectedCursor: number,
    delta: FilteredDelta,
    forcedStatus?: "skipped",
  ): Promise<boolean> {
    return await this.store.update((state) => {
      if (sessionIsExcluded(state, delta.meta.provider, delta.meta.sessionId)) return false;
      const job = state.intake.job;
      const item = job?.items[historyKey];
      if (!job || job.id !== historyJobId || job.status !== "running" || !item
        || item.status !== "running" || item.cursor !== expectedCursor) return false;
      item.cursor = item.kind === "snapshot" ? item.plannedSize : Math.min(item.plannedSize, delta.nextOffset);
      if (delta.skipUntilNewline) item.skipUntilNewline = true;
      else delete item.skipUntilNewline;
      if (item.kind === "snapshot") writeOffset(state, delta, false);
      if (delta.summaryHint) {
        const offset = state.offsets[delta.meta.path]
          ?? Object.values(state.offsets).find((record) =>
            record.provider === delta.meta.provider && record.sessionId === delta.meta.sessionId);
        if (offset) offset.summaryVersion = delta.summaryHint.version;
      }
      const complete = forcedStatus === "skipped" || item.kind === "snapshot" || item.cursor >= item.plannedSize;
      item.status = forcedStatus ?? (complete ? "complete" : "pending");
      delete item.error;
      delete item.retryAt;
      delete item.retryCount;
      job.lastProgressAt = nowIso();
      if (forcedStatus !== "skipped") state.sessions[delta.meta.sessionId] = sessionFromMeta(delta.meta, state.sessions[delta.meta.sessionId]);
      if (complete) state.intake.imported[historyKey] = nowIso();
      this.#settleHistoryJob(state, job);
      return true;
    });
  }

  #settleHistoryJob(state: TrailState, job: HistoryImportJob): void {
    const items = Object.values(job.items);
    if (items.some((candidate) => candidate.status === "pending" || candidate.status === "running")) return;
    if (items.some((candidate) => candidate.status === "failed")) {
      job.status = "paused";
      state.intake.phase = "importing";
      return;
    }
    job.status = "complete";
    state.intake.phase = "complete";
    state.intake.coverageStartAt = earlierIso(state.intake.coverageStartAt, job.cutoffAt);
  }

  async #markLiveIgnored(delta: FilteredDelta): Promise<void> {
    await this.store.update((state) => {
      if (!sessionIsExcluded(state, delta.meta.provider, delta.meta.sessionId)) writeOffset(state, delta, true);
    });
  }

  async #setHistoryFailure(historyKey: string, historyJobId: string, error: unknown): Promise<void> {
    await this.store.update((state) => {
      const job = state.intake.job;
      const item = job?.items[historyKey];
      if (!job || job.id !== historyJobId || job.status !== "running" || !item
        || item.status === "complete" || item.status === "skipped") return;
      const message = String(error).slice(0, 400);
      item.error = message;
      job.lastProgressAt = nowIso();
      const globalFailure = /roll engine .* (?:is not available|not-authenticated|not authenticated|authentication|未登录)/i.test(message);
      const retryCount = (item.retryCount ?? 0) + 1;
      item.retryCount = retryCount;
      if (!globalFailure && retryCount < HISTORY_RETRY_LIMIT) {
        item.status = "pending";
        item.retryAt = new Date(Date.now() + HISTORY_RETRY_BASE_MS * 2 ** (retryCount - 1)).toISOString();
        return;
      }
      item.status = "failed";
      delete item.retryAt;
      if (globalFailure) {
        job.status = "paused";
        for (const candidate of Object.values(job.items)) {
          if (candidate !== item && candidate.status === "running") candidate.status = "pending";
        }
      } else {
        this.#settleHistoryJob(state, job);
      }
    });
  }

  async #setRetryCooldown(source: TranscriptFile): Promise<void> {
    await this.store.update((state) => {
      const existing = storedOffset(state, source);
      const id = source.sessionId ?? sessionIdFromPath(source.path, source.provider);
      if (sessionIsExcluded(state, source.provider, id)) return;
      for (const [key, record] of Object.entries(state.offsets)) {
        if (key !== source.path && record.provider === source.provider && record.sessionId === id) delete state.offsets[key];
      }
      state.offsets[source.path] = {
        path: source.path,
        provider: source.provider,
        sessionId: existing?.sessionId ?? id,
        offset: existing?.offset ?? 0,
        mtimeMs: source.mtimeMs,
        cooldownUntil: Date.now() + SESSION_COOLDOWN_MS,
        ...(existing?.skipUntilNewline ? { skipUntilNewline: true } : {}),
        ...(existing?.ignored ? { ignored: true } : {}),
        ...(existing?.summaryVersion ? { summaryVersion: existing.summaryVersion } : {}),
      };
    });
  }
}

function earlierIso(current: string | null, candidate: string): string {
  return current && Date.parse(current) <= Date.parse(candidate) ? current : candidate;
}

function writeOffset(state: ReturnType<StateStore["snapshot"]>, delta: FilteredDelta, ignored: boolean): void {
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
  if (delta.summaryHint) record.summaryVersion = delta.summaryHint.version;
  for (const [key, existing] of Object.entries(state.offsets)) {
    if (key !== delta.meta.path && existing.provider === delta.meta.provider && existing.sessionId === delta.meta.sessionId) delete state.offsets[key];
  }
  state.offsets[delta.meta.path] = record;
}
