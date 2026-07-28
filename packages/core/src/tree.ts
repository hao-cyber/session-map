import {
  ASK_KINDS,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
  SESSION_TRAIL_ITEMS,
} from "./constants.ts";
import type {
  ApplyResult,
  AskKind,
  DeleteSessionResult,
  RollOutput,
  SessionRecord,
  SessionSnapshot,
  TrailState,
  TranscriptMeta,
} from "./types.ts";
import { StateStore } from "./state-store.ts";
import { applyRollOperations, makeTrailNode } from "./tree-roll.ts";
import {
  canonicalMainline,
  isRecord,
  normalizeText,
  nowIso,
} from "./utils.ts";

function subtreeIds(state: TrailState, rootId: string): Set<string> {
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || result.has(id) || !state.nodes[id]) continue;
    result.add(id);
    stack.push(...state.nodes[id].children);
  }
  return result;
}

export function sessionIdentity(provider: SessionRecord["provider"], sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function sessionIsExcluded(
  state: Pick<TrailState, "excludedSessions">,
  provider: SessionRecord["provider"],
  sessionId: string,
): boolean {
  return Boolean(state.excludedSessions[sessionIdentity(provider, sessionId)]);
}

function validAsk(raw: unknown): { kind: AskKind; hint: string } {
  if (!isRecord(raw)) return { kind: "none", hint: "" };
  const kind = typeof raw.kind === "string" && (ASK_KINDS as readonly string[]).includes(raw.kind)
    ? (raw.kind as AskKind)
    : "none";
  return { kind, hint: Array.from(normalizeText(raw.hint)).slice(0, 16).join("") };
}

function validSnapshot(
  raw: unknown,
  previous: SessionSnapshot,
  fallbackTitle: string,
  at: string,
): SessionSnapshot {
  if (!isRecord(raw)) return previous;
  const summary = Array.from(normalizeText(raw.summary)).slice(0, SESSION_SUMMARY_CHARS).join("")
    || previous.summary
    || Array.from(normalizeText(fallbackTitle)).slice(0, SESSION_SUMMARY_CHARS).join("");
  const progress = Array.from(normalizeText(raw.progress)).slice(0, SESSION_PROGRESS_CHARS).join("")
    || previous.progress;
  const trail = Array.isArray(raw.trail)
    ? raw.trail
      .filter((item): item is string => typeof item === "string")
      .map((item) => Array.from(normalizeText(item)).slice(0, SESSION_TRAIL_ITEM_CHARS).join(""))
      .filter(Boolean)
      .slice(0, SESSION_TRAIL_ITEMS)
    : previous.trail;
  return { summary, progress, trail, at };
}

function createSession(meta: TranscriptMeta, at: string): SessionRecord {
  return {
    id: meta.sessionId,
    provider: meta.provider,
    path: meta.path,
    cwd: meta.cwd,
    title: meta.title,
    lastUser: meta.lastUser,
    mainline: null,
    rootId: null,
    cursor: null,
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: Array.from(normalizeText(meta.title)).slice(0, SESSION_SUMMARY_CHARS).join("")
        || `${meta.provider}:${meta.sessionId.slice(0, 8)}`,
      progress: "等待首次语义快照",
      trail: [],
      at,
    },
    status: "unknown",
    terminalOpen: false,
    firstSeenAt: at,
    lastTranscriptAt: new Date(meta.mtimeMs).toISOString(),
    lastStatusAt: at,
    updatedAt: at,
  };
}

export class TreeRuntime {
  constructor(readonly store: StateStore) {}

  async applyRoll(
    meta: TranscriptMeta,
    rawOutput: RollOutput,
    options: { snapshotOnly?: boolean } = {},
  ): Promise<ApplyResult> {
    return this.store.update((state) => {
      if (sessionIsExcluded(state, meta.provider, meta.sessionId)) {
        return { mainline: "", rootId: "", reattached: false, accepted: 0, rejected: ["session is excluded"] };
      }
      const at = nowIso();
      const previous = state.sessions[meta.sessionId];
      if (options.snapshotOnly) {
        if (!previous?.mainline || !previous.rootId || !state.nodes[previous.rootId]) {
          return { mainline: "", rootId: "", reattached: false, accepted: 0, rejected: ["summary hint cannot create a session"] };
        }
        const rejected: string[] = [];
        if (canonicalMainline(rawOutput.mainline) !== previous.mainline) rejected.push("summary hint cannot reattach a session");
        if (Array.isArray(rawOutput.ops) && rawOutput.ops.length) rejected.push("summary hint cannot modify permanent lineage");
        if (isRecord(rawOutput.ask)
          && (rawOutput.ask.kind !== previous.ask.kind || normalizeText(rawOutput.ask.hint) !== previous.ask.hint)) {
          rejected.push("summary hint cannot change ask state");
        }
        state.sessions[meta.sessionId] = {
          ...previous,
          path: meta.path,
          cwd: meta.cwd || previous.cwd,
          title: meta.title || previous.title,
          lastUser: meta.lastUser || previous.lastUser,
          snapshot: validSnapshot(rawOutput.snapshot, previous.snapshot, meta.title || previous.title, at),
          updatedAt: at,
        };
        return {
          mainline: previous.mainline,
          rootId: previous.rootId,
          reattached: false,
          accepted: 0,
          rejected,
        };
      }
      const mainline = canonicalMainline(rawOutput.mainline);
      if (!mainline) throw new Error("roll output has an empty mainline");

      let rootId = state.mainlineIndex[mainline];
      if (!rootId) {
        const root = makeTrailNode(null, "goal", mainline, at);
        rootId = root.id;
        state.nodes[root.id] = root;
        state.roots.push(root.id);
        state.mainlineIndex[mainline] = root.id;
      }

      const currentSession = previous ?? createSession(meta, at);
      const reattached = Boolean(currentSession.rootId && currentSession.rootId !== rootId);
      const session: SessionRecord = {
        ...currentSession,
        provider: meta.provider,
        path: meta.path,
        cwd: meta.cwd || currentSession.cwd,
        title: meta.title || currentSession.title,
        lastUser: meta.lastUser || currentSession.lastUser,
        mainline,
        rootId,
        cursor: currentSession.rootId === rootId && currentSession.cursor ? currentSession.cursor : rootId,
        ask: validAsk(rawOutput.ask),
        snapshot: validSnapshot(rawOutput.snapshot, currentSession.snapshot, meta.title || currentSession.title, at),
        lastTranscriptAt: new Date(meta.mtimeMs).toISOString(),
        updatedAt: at,
      };
      state.sessions[meta.sessionId] = session;
      const applied = applyRollOperations({
        state,
        session,
        rootId,
        mainline,
        rawOperations: rawOutput.ops,
        reattached,
        at,
      });
      state.nodes[rootId]!.updatedAt = at;
      return { mainline, rootId, reattached, ...applied };
    });
  }

  async archive(rootId: string): Promise<boolean> {
    return this.store.update((state) => {
      if (!state.roots.includes(rootId)) return false;
      if (!state.archived.includes(rootId)) state.archived.push(rootId);
      return true;
    });
  }

  async restore(rootId: string): Promise<boolean> {
    return this.store.update((state) => {
      if (!state.roots.includes(rootId)) return false;
      state.archived = state.archived.filter((id) => id !== rootId);
      return true;
    });
  }


  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    return this.store.update((state) => {
      const session = state.sessions[sessionId];
      if (!session) return { ok: false, removedRoot: false, remainingSessions: 0 };
      const identity = sessionIdentity(session.provider, session.id);
      state.excludedSessions[identity] = nowIso();
      delete state.sessions[sessionId];
      for (const [path, offset] of Object.entries(state.offsets)) {
        if (offset.provider === session.provider && offset.sessionId === session.id) delete state.offsets[path];
      }
      delete state.intake.imported[identity];
      const job = state.intake.job;
      if (job) {
        for (const [key, item] of Object.entries(job.items)) {
          if (item.provider === session.provider && item.sessionId === session.id) delete job.items[key];
        }
        const pending = Object.values(job.items).some((item) =>
          item.status === "pending" || item.status === "running" || item.status === "failed"
        );
        if (!pending && (job.status === "running" || job.status === "paused")) {
          job.status = "complete";
          state.intake.phase = "complete";
        }
      }

      const rootId = session.rootId;
      const remainingSessions = rootId
        ? Object.values(state.sessions).filter((candidate) => candidate.rootId === rootId).length
        : 0;
      if (!rootId || remainingSessions > 0 || !state.nodes[rootId]) {
        return { ok: true, removedRoot: false, remainingSessions };
      }
      const ids = subtreeIds(state, rootId);
      for (const id of ids) delete state.nodes[id];
      state.roots = state.roots.filter((id) => id !== rootId);
      state.archived = state.archived.filter((id) => id !== rootId);
      for (const [name, id] of Object.entries(state.mainlineIndex)) {
        if (id === rootId) delete state.mainlineIndex[name];
      }
      return { ok: true, removedRoot: true, remainingSessions: 0 };
    });
  }
}

export { subtreeIds };
