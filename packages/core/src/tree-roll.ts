import { MAX_OPS, NODE_LABEL_CHARS, NODE_TYPES } from "./constants.ts";
import type { SessionRecord, TrailNode, TrailState } from "./types.ts";
import { canonicalMainline, canonicalNodeLabel, canonicalNote, isRecord, normalizeText } from "./utils.ts";

export function makeTrailNode(parent: string | null, type: TrailNode["type"], label: string, at: string): TrailNode {
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

export function applyRollOperations(options: {
  state: TrailState;
  session: SessionRecord;
  rootId: string;
  mainline: string;
  rawOperations: unknown;
  reattached: boolean;
  at: string;
}): { accepted: number; rejected: string[] } {
  const { state, session, rootId, mainline, reattached, at } = options;
  const rejected: string[] = [];
  let accepted = 0;
  let newestNode: string | null = null;
  let explicitRefocus = false;
  const allowed = subtreeIds(state, rootId);
  const operations = Array.isArray(options.rawOperations) ? options.rawOperations.slice(0, MAX_OPS) : [];
  if (Array.isArray(options.rawOperations) && options.rawOperations.length > MAX_OPS) {
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
      const node = makeTrailNode(parentId, unknownOp.type as TrailNode["type"], label, at);
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
      const note = canonicalNote(unknownOp.note);
      if (!note) {
        reject("close requires a note");
        return;
      }
      node.state = unknownOp.state as "resolved" | "dead";
      node.note = note;
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
      if (node.state === "resolved" || node.state === "dead") {
        reject("closed nodes preserve their recorded label; grow a revised direction instead");
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
  return { accepted, rejected };
}
