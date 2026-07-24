import { basename } from "node:path";
import {
  ASK_KINDS,
  ENGINE_NAMES,
  MAINLINE_NAME_CHARS,
  NODE_STATES,
  NODE_TYPES,
  PROVIDERS,
  SCHEMA_VERSION,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
  SESSION_TRAIL_ITEMS,
} from "./constants.ts";
import type {
  AskKind,
  EngineName,
  HistoryImportItem,
  HistoryItemStatus,
  HistoryJobStatus,
  IntakePhase,
  OffsetRecord,
  Provider,
  SessionRecord,
  SessionStatus,
  TrailNode,
  TrailState,
} from "./types.ts";
import {
  canonicalMainline,
  canonicalNodeLabel,
  controlSafe,
  isRecord,
  normalizeText,
  nowIso,
  truncateChars,
} from "./utils.ts";

const SESSION_STATUSES: SessionStatus[] = ["busy", "idle", "recent", "closed", "unknown"];
const INTAKE_PHASES: IntakePhase[] = ["awaiting-choice", "importing", "complete"];
const HISTORY_JOB_STATUSES: HistoryJobStatus[] = ["running", "paused", "complete", "cancelled"];
const HISTORY_ITEM_STATUSES: HistoryItemStatus[] = ["pending", "running", "complete", "skipped", "failed"];

export function createEmptyState(engine: EngineName = "claude", at = nowIso()): TrailState {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    nodes: {},
    roots: [],
    mainlineIndex: {},
    sessions: {},
    offsets: {},
    excludedSessions: {},
    intake: {
      phase: "awaiting-choice",
      coverageStartAt: null,
      lastDiscoveryAt: null,
      imported: {},
      job: null,
    },
    archived: [],
    engine,
    rollUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      measuredCalls: 0,
      unreportedCalls: 0,
      last: null,
    },
  };
}

function validIso(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function enumValue<T extends readonly string[]>(values: T, value: unknown, fallback: T[number]): T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

function finiteNonnegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? controlSafe(value) : undefined;
}

function descendants(nodes: Record<string, TrailNode>, rootId: string): Set<string> {
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || result.has(id) || !nodes[id]) continue;
    result.add(id);
    stack.push(...nodes[id].children);
  }
  return result;
}

export function repairState(input: unknown, at = nowIso()): { state: TrailState; repaired: boolean } {
  if (!isRecord(input)) return { state: createEmptyState(), repaired: true };
  let repaired = false;
  const state = createEmptyState(
    enumValue(ENGINE_NAMES, input.engine, "claude") as EngineName,
    validIso(input.createdAt, at),
  );
  state.revision = Math.floor(finiteNonnegative(input.revision));
  state.updatedAt = validIso(input.updatedAt, at);

  const rawRollUsage = isRecord(input.rollUsage) ? input.rollUsage : null;
  if (!rawRollUsage) repaired = true;
  else {
    state.rollUsage.inputTokens = Math.floor(finiteNonnegative(rawRollUsage.inputTokens));
    state.rollUsage.outputTokens = Math.floor(finiteNonnegative(rawRollUsage.outputTokens));
    state.rollUsage.totalTokens = Math.floor(finiteNonnegative(rawRollUsage.totalTokens));
    state.rollUsage.cachedInputTokens = Math.floor(finiteNonnegative(rawRollUsage.cachedInputTokens));
    state.rollUsage.measuredCalls = Math.floor(finiteNonnegative(rawRollUsage.measuredCalls));
    state.rollUsage.unreportedCalls = Math.floor(finiteNonnegative(rawRollUsage.unreportedCalls));
    const last = isRecord(rawRollUsage.last) ? rawRollUsage.last : null;
    if (last) {
      const inputTokens = Math.floor(finiteNonnegative(last.inputTokens));
      const outputTokens = Math.floor(finiteNonnegative(last.outputTokens));
      const totalTokens = Math.floor(finiteNonnegative(last.totalTokens, inputTokens + outputTokens));
      state.rollUsage.last = {
        engine: enumValue(ENGINE_NAMES, last.engine, state.engine) as EngineName,
        inputTokens,
        outputTokens,
        totalTokens,
        at: validIso(last.at, at),
        ...(finiteNonnegative(last.cachedInputTokens) > 0
          ? { cachedInputTokens: Math.floor(finiteNonnegative(last.cachedInputTokens)) }
          : {}),
      };
    }
  }

  const rawNodes = isRecord(input.nodes) ? input.nodes : {};
  if (rawNodes !== input.nodes) repaired = true;
  for (const [id, raw] of Object.entries(rawNodes)) {
    if (!isRecord(raw) || !id || id.length > 160) {
      repaired = true;
      continue;
    }
    // Parentage is repaired below, so a node may still turn out to be a root.
    // Preserve the wider mainline identity limit until the forest is known.
    const label = truncateChars(normalizeText(raw.label), MAINLINE_NAME_CHARS) || "未命名节点";
    const node: TrailNode = {
      id,
      label,
      type: enumValue(NODE_TYPES, raw.type, "note"),
      state: enumValue(NODE_STATES, raw.state, "active"),
      parent: typeof raw.parent === "string" ? raw.parent : null,
      children: Array.isArray(raw.children)
        ? raw.children.filter((child): child is string => typeof child === "string")
        : [],
      createdAt: validIso(raw.createdAt, at),
      updatedAt: validIso(raw.updatedAt, at),
    };
    const note = optionalString(raw, "note");
    const blockedNote = optionalString(raw, "blockedNote");
    if (note) node.note = truncateChars(note, 160);
    if (blockedNote) node.blockedNote = truncateChars(blockedNote, 160);
    state.nodes[id] = node;
    if (label !== raw.label || node.children.length !== (Array.isArray(raw.children) ? raw.children.length : 0)) {
      repaired = true;
    }
  }

  // Merge explicit children and valid parent hints, then rebuild a single-parent forest.
  for (const node of Object.values(state.nodes)) {
    const filtered = Array.from(new Set(node.children)).filter(
      (child) => child !== node.id && Boolean(state.nodes[child]),
    );
    if (filtered.length !== node.children.length) repaired = true;
    node.children = filtered;
  }
  for (const node of Object.values(state.nodes)) {
    if (node.parent && state.nodes[node.parent] && node.parent !== node.id) {
      const parent = state.nodes[node.parent]!;
      if (!parent.children.includes(node.id)) {
        parent.children.push(node.id);
        repaired = true;
      }
    } else if (node.parent !== null) {
      node.parent = null;
      repaired = true;
    }
  }

  const claimed = new Map<string, string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visiting.add(id);
    const node = state.nodes[id];
    if (!node) return;
    const kept: string[] = [];
    for (const child of node.children) {
      if (visiting.has(child) || claimed.has(child)) {
        repaired = true;
        continue;
      }
      claimed.set(child, id);
      kept.push(child);
      walk(child);
    }
    node.children = kept;
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(state.nodes)) walk(id);
  for (const node of Object.values(state.nodes)) {
    const parent = claimed.get(node.id) ?? null;
    if (node.parent !== parent) repaired = true;
    node.parent = parent;
  }

  const rawRoots = Array.isArray(input.roots)
    ? input.roots.filter((id): id is string => typeof id === "string" && Boolean(state.nodes[id]))
    : [];
  const rootOrder = Array.from(new Set(rawRoots));
  for (const node of Object.values(state.nodes)) {
    if (node.parent === null && !rootOrder.includes(node.id)) rootOrder.push(node.id);
  }
  state.roots = rootOrder.filter((id) => state.nodes[id]?.parent === null);
  if (state.roots.length !== rawRoots.length) repaired = true;

  const rootSet = new Set(state.roots);
  for (const node of Object.values(state.nodes)) {
    if (rootSet.has(node.id)) continue;
    const label = canonicalNodeLabel(node.label) || "未命名节点";
    if (label !== node.label) repaired = true;
    node.label = label;
  }

  // Root labels are mainline identities. Preserve both objects if corruption created a collision.
  const usedNames = new Set<string>();
  for (const rootId of state.roots) {
    const root = state.nodes[rootId]!;
    root.type = "goal";
    let name = canonicalMainline(root.label) || "未命名主线";
    if (usedNames.has(name)) {
      const base = truncateChars(name, 42);
      let suffix = 2;
      while (usedNames.has(`${base} · ${suffix}`)) suffix += 1;
      name = `${base} · ${suffix}`;
      repaired = true;
    }
    if (root.label !== name) repaired = true;
    root.label = name;
    usedNames.add(name);
    state.mainlineIndex[name] = rootId;
  }

  const rawArchived = Array.isArray(input.archived)
    ? input.archived.filter((id): id is string => typeof id === "string")
    : [];
  state.archived = Array.from(new Set(rawArchived)).filter((id) => state.roots.includes(id));
  if (state.archived.length !== rawArchived.length) repaired = true;

  const rawSessions = isRecord(input.sessions) ? input.sessions : {};
  for (const [key, raw] of Object.entries(rawSessions)) {
    if (!isRecord(raw)) {
      repaired = true;
      continue;
    }
    const id = normalizeText(raw.id) || key;
    const provider = enumValue(PROVIDERS, raw.provider, "claude") as Provider;
    const hintedRoot = typeof raw.rootId === "string" && state.roots.includes(raw.rootId)
      ? raw.rootId
      : typeof raw.mainline === "string"
        ? state.mainlineIndex[canonicalMainline(raw.mainline)] ?? null
        : null;
    const allowed = hintedRoot ? descendants(state.nodes, hintedRoot) : new Set<string>();
    const cursor = typeof raw.cursor === "string" && allowed.has(raw.cursor) ? raw.cursor : hintedRoot;
    const askRaw = isRecord(raw.ask) ? raw.ask : {};
    const snapshotRaw = isRecord(raw.snapshot) ? raw.snapshot : {};
    const fallbackTitle = truncateChars(normalizeText(raw.title) || `${provider}:${id.slice(0, 8)}`, 100);
    const summary = truncateChars(
      normalizeText(snapshotRaw.summary) || normalizeText(raw.summary) || fallbackTitle,
      SESSION_SUMMARY_CHARS,
    );
    const progress = truncateChars(
      normalizeText(snapshotRaw.progress) || normalizeText(raw.progress),
      SESSION_PROGRESS_CHARS,
    );
    const trail = Array.isArray(snapshotRaw.trail)
      ? snapshotRaw.trail
        .filter((item): item is string => typeof item === "string")
        .map((item) => truncateChars(normalizeText(item), SESSION_TRAIL_ITEM_CHARS))
        .filter(Boolean)
        .slice(0, SESSION_TRAIL_ITEMS)
      : [];
    const firstSeenFallback = validIso(raw.lastTranscriptAt, validIso(raw.updatedAt, at));
    const firstSeenAt = validIso(raw.firstSeenAt, firstSeenFallback);
    const session: SessionRecord = {
      id,
      provider,
      path: typeof raw.path === "string" ? raw.path : "",
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      title: fallbackTitle,
      lastUser: truncateChars(typeof raw.lastUser === "string" ? raw.lastUser : "", 2_000),
      mainline: hintedRoot ? state.nodes[hintedRoot]!.label : null,
      rootId: hintedRoot,
      cursor,
      ask: {
        kind: enumValue(ASK_KINDS, askRaw.kind, "none") as AskKind,
        hint: truncateChars(normalizeText(askRaw.hint), 16),
      },
      snapshot: {
        summary,
        progress,
        trail,
        at: validIso(snapshotRaw.at, validIso(raw.updatedAt, at)),
      },
      status: enumValue(SESSION_STATUSES, raw.status, "unknown"),
      terminalOpen: raw.terminalOpen === true,
      firstSeenAt,
      lastTranscriptAt: validIso(raw.lastTranscriptAt, at),
      lastStatusAt: validIso(raw.lastStatusAt, at),
      updatedAt: validIso(raw.updatedAt, at),
    };
    const terminalHandle = optionalString(raw, "terminalHandle");
    const paneKey = optionalString(raw, "paneKey");
    if (terminalHandle) session.terminalHandle = terminalHandle;
    if (paneKey) session.paneKey = paneKey;
    if (typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid > 0) session.pid = raw.pid;
    state.sessions[id] = session;
    if (
      cursor !== raw.cursor || hintedRoot !== raw.rootId || session.mainline !== raw.mainline
      || firstSeenAt !== raw.firstSeenAt
      || !isRecord(raw.snapshot) || summary !== snapshotRaw.summary || progress !== (snapshotRaw.progress ?? "")
      || trail.length !== (Array.isArray(snapshotRaw.trail) ? snapshotRaw.trail.length : 0)
    ) repaired = true;
  }

  const rawOffsets = isRecord(input.offsets) ? input.offsets : {};
  for (const [key, raw] of Object.entries(rawOffsets)) {
    if (!isRecord(raw)) {
      repaired = true;
      continue;
    }
    const path = typeof raw.path === "string" && raw.path ? raw.path : key;
    const record: OffsetRecord = {
      path,
      provider: enumValue(PROVIDERS, raw.provider, "claude") as Provider,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : basename(path, ".jsonl"),
      offset: Math.floor(finiteNonnegative(raw.offset)),
      mtimeMs: finiteNonnegative(raw.mtimeMs),
      cooldownUntil: finiteNonnegative(raw.cooldownUntil),
    };
    if (raw.skipUntilNewline === true) record.skipUntilNewline = true;
    if (raw.ignored === true) record.ignored = true;
    const summaryVersion = optionalString(raw, "summaryVersion");
    if (summaryVersion) record.summaryVersion = truncateChars(summaryVersion, 128);
    state.offsets[key] = record;
  }

  const rawExcludedSessions = isRecord(input.excludedSessions) ? input.excludedSessions : {};
  if (rawExcludedSessions !== input.excludedSessions) repaired = true;
  for (const [key, value] of Object.entries(rawExcludedSessions)) {
    if (!key || key.length > 320 || typeof value !== "string") {
      repaired = true;
      continue;
    }
    state.excludedSessions[key] = validIso(value, at);
  }

  const durableObjectsExist = state.roots.length > 0
    || Object.keys(state.sessions).length > 0
    || Object.keys(state.offsets).length > 0
    || Object.keys(state.excludedSessions).length > 0;
  const rawIntake = isRecord(input.intake) ? input.intake : null;
  if (!rawIntake) {
    state.intake.phase = durableObjectsExist ? "complete" : "awaiting-choice";
    repaired = true;
  } else {
    state.intake.phase = enumValue(INTAKE_PHASES, rawIntake.phase, durableObjectsExist ? "complete" : "awaiting-choice");
    state.intake.coverageStartAt = typeof rawIntake.coverageStartAt === "string"
      ? validIso(rawIntake.coverageStartAt, at)
      : null;
    state.intake.lastDiscoveryAt = typeof rawIntake.lastDiscoveryAt === "string"
      ? validIso(rawIntake.lastDiscoveryAt, at)
      : null;
    const imported = isRecord(rawIntake.imported) ? rawIntake.imported : {};
    for (const [key, value] of Object.entries(imported)) {
      if (!key || key.length > 320 || typeof value !== "string") {
        repaired = true;
        continue;
      }
      state.intake.imported[key] = validIso(value, at);
    }
    const rawJob = isRecord(rawIntake.job) ? rawIntake.job : null;
    if (rawJob) {
      const id = typeof rawJob.id === "string" && rawJob.id.length <= 160 ? rawJob.id : crypto.randomUUID();
      const items: Record<string, HistoryImportItem> = {};
      const rawItems = isRecord(rawJob.items) ? rawJob.items : {};
      for (const [key, raw] of Object.entries(rawItems)) {
        if (!isRecord(raw) || !key || key.length > 320) {
          repaired = true;
          continue;
        }
        const path = typeof raw.path === "string" ? raw.path : "";
        const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
        if (!path || !sessionId) {
          repaired = true;
          continue;
        }
        const item: HistoryImportItem = {
          key,
          provider: enumValue(PROVIDERS, raw.provider, "claude") as Provider,
          sessionId,
          path,
          kind: raw.kind === "snapshot" ? "snapshot" : "append",
          plannedSize: Math.floor(finiteNonnegative(raw.plannedSize)),
          plannedMtimeMs: finiteNonnegative(raw.plannedMtimeMs),
          cursor: Math.floor(finiteNonnegative(raw.cursor)),
          status: enumValue(HISTORY_ITEM_STATUSES, raw.status, "pending"),
          reconcile: raw.reconcile === true,
        };
        if (raw.skipUntilNewline === true) item.skipUntilNewline = true;
        const error = optionalString(raw, "error");
        if (error) item.error = truncateChars(error, 400);
        const retryCount = Math.floor(finiteNonnegative(raw.retryCount));
        if (retryCount) item.retryCount = retryCount;
        if (typeof raw.retryAt === "string") item.retryAt = validIso(raw.retryAt, at);
        items[key] = item;
      }
      state.intake.job = {
        id,
        createdAt: validIso(rawJob.createdAt, at),
        cutoffAt: validIso(rawJob.cutoffAt, at),
        highWaterAt: validIso(rawJob.highWaterAt, at),
        lastProgressAt: validIso(rawJob.lastProgressAt, typeof rawJob.createdAt === "string" ? rawJob.createdAt : at),
        status: enumValue(HISTORY_JOB_STATUSES, rawJob.status, "paused"),
        items,
      };
      if (state.intake.phase === "importing" && state.intake.job.status === "complete") {
        state.intake.phase = "complete";
        repaired = true;
      }
    } else if (rawIntake.job !== null && rawIntake.job !== undefined) {
      repaired = true;
    }
    if (state.intake.phase === "importing" && !state.intake.job) {
      state.intake.phase = durableObjectsExist ? "complete" : "awaiting-choice";
      repaired = true;
    }
  }

  if (input.schemaVersion !== SCHEMA_VERSION) repaired = true;
  state.schemaVersion = SCHEMA_VERSION;
  return { state, repaired };
}
