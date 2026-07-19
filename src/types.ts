import type {
  ASK_KINDS,
  ENGINE_NAMES,
  NODE_STATES,
  NODE_TYPES,
  PROVIDERS,
} from "./constants.ts";

export type NodeType = (typeof NODE_TYPES)[number];
export type NodeState = (typeof NODE_STATES)[number];
export type AskKind = (typeof ASK_KINDS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type EngineName = (typeof ENGINE_NAMES)[number];
export type SessionStatus = "busy" | "idle" | "recent" | "closed" | "unknown";

export interface TrailNode {
  id: string;
  label: string;
  type: NodeType;
  state: NodeState;
  parent: string | null;
  children: string[];
  createdAt: string;
  updatedAt: string;
  note?: string;
  blockedNote?: string;
}

export interface SessionAsk {
  kind: AskKind;
  hint: string;
}

export interface SessionSnapshot {
  summary: string;
  progress: string;
  trail: string[];
  at: string;
}

export interface SessionRecord {
  id: string;
  provider: Provider;
  path: string;
  cwd: string;
  title: string;
  lastUser: string;
  mainline: string | null;
  rootId: string | null;
  cursor: string | null;
  ask: SessionAsk;
  snapshot: SessionSnapshot;
  status: SessionStatus;
  terminalOpen: boolean;
  terminalHandle?: string;
  paneKey?: string;
  pid?: number;
  firstSeenAt: string;
  lastTranscriptAt: string;
  lastStatusAt: string;
  updatedAt: string;
}

export interface OffsetRecord {
  path: string;
  provider: Provider;
  sessionId: string;
  offset: number;
  mtimeMs: number;
  cooldownUntil: number;
  skipUntilNewline?: boolean;
  ignored?: boolean;
}

export interface TrailState {
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nodes: Record<string, TrailNode>;
  roots: string[];
  mainlineIndex: Record<string, string>;
  sessions: Record<string, SessionRecord>;
  offsets: Record<string, OffsetRecord>;
  archived: string[];
  engine: EngineName;
}

export type GrowOp = {
  op: "grow";
  parent: string;
  type: NodeType;
  label: string;
};
export type CloseOp = {
  op: "close";
  node: string;
  state: "resolved" | "dead";
  note?: string;
};
export type BlockOp = { op: "block"; node: string; note: string };
export type UnblockOp = { op: "unblock"; node: string };
export type RenameOp = { op: "rename"; node: string; label: string };
export type RefocusOp = { op: "refocus"; node: string };
export type RollOp = GrowOp | CloseOp | BlockOp | UnblockOp | RenameOp | RefocusOp;

export interface RollOutput {
  mainline: string;
  ask: SessionAsk;
  snapshot?: unknown;
  ops: unknown[];
}

export interface TranscriptMeta {
  provider: Provider;
  sessionId: string;
  path: string;
  cwd: string;
  title: string;
  lastUser: string;
  mtimeMs: number;
}

export interface FilteredDelta {
  meta: TranscriptMeta;
  text: string;
  nextOffset: number;
  lowSignal: boolean;
  selfGenerated: boolean;
  skipUntilNewline: boolean;
  parseErrors: number;
  bytesRead: number;
}

export interface ApplyResult {
  mainline: string;
  rootId: string;
  reattached: boolean;
  accepted: number;
  rejected: string[];
}

export interface EngineAvailability {
  name: EngineName;
  available: boolean;
  path: string | null;
  reason?: "checking" | "not-installed" | "not-authenticated" | "auth-check-failed" | "recent-failure";
}

export interface GitChip {
  cwd: string;
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
}

export interface NowItem {
  kind: "decision" | "reply" | "blocker" | "busy" | "recent";
  label: string;
  detail: string;
  mainline: string;
  sessionId?: string;
  at: string;
}
