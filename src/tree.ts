import {
  ASK_KINDS,
  MAX_OPS,
  NODE_LABEL_CHARS,
  NODE_TYPES,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
  SESSION_TRAIL_ITEMS,
} from "./constants.ts";
import type {
  ApplyResult,
  AskKind,
  RollOutput,
  SessionRecord,
  SessionSnapshot,
  TrailNode,
  TrailState,
  TranscriptMeta,
} from "./types.ts";
import { StateStore } from "./state.ts";
import {
  canonicalMainline,
  canonicalNodeLabel,
  canonicalNote,
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

function makeNode(parent: string | null, type: TrailNode["type"], label: string, at: string): TrailNode {
  return {
    id: `n_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    label,
    type,
    state: "active",
    parent,
    children: [],
    createdAt: at,
    updatedAt: at,
  };
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
    lastTranscriptAt: new Date(meta.mtimeMs).toISOString(),
    lastStatusAt: at,
    updatedAt: at,
  };
}

export class TreeRuntime {
  constructor(readonly store: StateStore) {}

  async applyRoll(meta: TranscriptMeta, rawOutput: RollOutput): Promise<ApplyResult> {
    return this.store.update((state) => {
      const at = nowIso();
      const mainline = canonicalMainline(rawOutput.mainline);
      if (!mainline) throw new Error("roll output has an empty mainline");

      let rootId = state.mainlineIndex[mainline];
      if (!rootId) {
        const root = makeNode(null, "goal", mainline, at);
        rootId = root.id;
        state.nodes[root.id] = root;
        state.roots.push(root.id);
        state.mainlineIndex[mainline] = root.id;
      }

      const previous = state.sessions[meta.sessionId] ?? createSession(meta, at);
      const reattached = Boolean(previous.rootId && previous.rootId !== rootId);
      const session: SessionRecord = {
        ...previous,
        provider: meta.provider,
        path: meta.path,
        cwd: meta.cwd || previous.cwd,
        title: meta.title || previous.title,
        lastUser: meta.lastUser || previous.lastUser,
        mainline,
        rootId,
        cursor: previous.rootId === rootId && previous.cursor ? previous.cursor : rootId,
        ask: validAsk(rawOutput.ask),
        snapshot: validSnapshot(rawOutput.snapshot, previous.snapshot, meta.title || previous.title, at),
        lastTranscriptAt: new Date(meta.mtimeMs).toISOString(),
        updatedAt: at,
      };
      state.sessions[meta.sessionId] = session;

      const rejected: string[] = [];
      let accepted = 0;
      let newestNode: string | null = null;
      let explicitRefocus = false;
      const allowed = subtreeIds(state, rootId);
      const operations = Array.isArray(rawOutput.ops) ? rawOutput.ops.slice(0, MAX_OPS) : [];
      if (Array.isArray(rawOutput.ops) && rawOutput.ops.length > MAX_OPS) {
        rejected.push(`ops beyond runtime limit ${MAX_OPS}`);
      }

      operations.forEach((unknownOp, index) => {
        const reject = (reason: string): void => {
          rejected.push(`op[${index}]: ${reason}`);
        };
        if (!isRecord(unknownOp) || typeof unknownOp.op !== "string") {
          reject("malformed operation");
          return;
        }
        const op = unknownOp.op;
        if (reattached && !["grow", "refocus"].includes(op)) {
          reject("reattach round is read-only for existing nodes");
          return;
        }

        if (op === "grow") {
          const rootReference = unknownOp.parent === "mainline"
            || (typeof unknownOp.parent === "string" && canonicalMainline(unknownOp.parent) === mainline);
          const parentId = rootReference ? rootId : unknownOp.parent;
          if (typeof parentId !== "string" || !allowed.has(parentId)) {
            reject("parent is outside the assigned mainline");
            return;
          }
          if (typeof unknownOp.type !== "string" || !(NODE_TYPES as readonly string[]).includes(unknownOp.type)) {
            reject("invalid node type");
            return;
          }
          const originalLabel = normalizeText(unknownOp.label);
          const label = canonicalNodeLabel(originalLabel);
          if (!label || Array.from(originalLabel).length > NODE_LABEL_CHARS) {
            reject(`label must contain 1-${NODE_LABEL_CHARS} characters`);
            return;
          }
          const node = makeNode(parentId, unknownOp.type as TrailNode["type"], label, at);
          state.nodes[node.id] = node;
          state.nodes[parentId]!.children.push(node.id);
          state.nodes[parentId]!.updatedAt = at;
          allowed.add(node.id);
          newestNode = node.id;
          accepted += 1;
          return;
        }

        const nodeId = unknownOp.node;
        if (typeof nodeId !== "string" || !allowed.has(nodeId)) {
          reject("node is outside the assigned mainline");
          return;
        }
        const node = state.nodes[nodeId];
        if (!node) {
          reject("node does not exist");
          return;
        }

        if (op === "close") {
          if (nodeId === rootId) {
            reject("mainline roots cannot be closed by roll ops");
            return;
          }
          if (typeof unknownOp.state !== "string" || !["resolved", "dead"].includes(unknownOp.state)) {
            reject("close state must be resolved or dead");
            return;
          }
          if (node.state === "resolved" || node.state === "dead") {
            reject("closed nodes preserve their recorded outcome; grow a revised direction instead");
            return;
          }
          node.state = unknownOp.state as "resolved" | "dead";
          const note = canonicalNote(unknownOp.note);
          if (note) node.note = note;
          node.updatedAt = at;
          accepted += 1;
          return;
        }
        if (op === "block") {
          if (node.state === "resolved" || node.state === "dead") {
            reject("closed nodes cannot be blocked; grow a revised direction instead");
            return;
          }
          const note = canonicalNote(unknownOp.note);
          if (!note) {
            reject("block requires a note");
            return;
          }
          node.state = "waiting";
          node.blockedNote = note;
          node.updatedAt = at;
          accepted += 1;
          return;
        }
        if (op === "unblock") {
          if (node.state !== "waiting") {
            reject("only waiting nodes can be unblocked");
            return;
          }
          node.state = "active";
          delete node.blockedNote;
          node.updatedAt = at;
          accepted += 1;
          return;
        }
        if (op === "rename") {
          if (nodeId === rootId) {
            reject("mainline roots cannot be renamed by roll ops");
            return;
          }
          const originalLabel = normalizeText(unknownOp.label);
          const label = canonicalNodeLabel(originalLabel);
          if (!label || Array.from(originalLabel).length > NODE_LABEL_CHARS) {
            reject(`label must contain 1-${NODE_LABEL_CHARS} characters`);
            return;
          }
          node.label = label;
          node.updatedAt = at;
          accepted += 1;
          return;
        }
        if (op === "refocus") {
          session.cursor = nodeId;
          explicitRefocus = true;
          accepted += 1;
          return;
        }
        reject("unknown operation");
      });

      if (!explicitRefocus && newestNode) session.cursor = newestNode;
      state.nodes[rootId]!.updatedAt = at;
      return { mainline, rootId, reattached, accepted, rejected };
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
}

export { subtreeIds };
