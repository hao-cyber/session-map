import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { dlopen } from "bun:ffi";
import {
  APP_NAME,
  ASK_KINDS,
  ENGINE_NAMES,
  MAINLINE_NAME_CHARS,
  NODE_STATES,
  NODE_TYPES,
  PROVIDERS,
  SCHEMA_VERSION,
} from "./constants.ts";
import { Logger } from "./logger.ts";
import type {
  AskKind,
  EngineName,
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
    archived: [],
    engine,
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
    const session: SessionRecord = {
      id,
      provider,
      path: typeof raw.path === "string" ? raw.path : "",
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      title: truncateChars(normalizeText(raw.title) || `${provider}:${id.slice(0, 8)}`, 100),
      lastUser: truncateChars(typeof raw.lastUser === "string" ? raw.lastUser : "", 2_000),
      mainline: hintedRoot ? state.nodes[hintedRoot]!.label : null,
      rootId: hintedRoot,
      cursor,
      ask: {
        kind: enumValue(ASK_KINDS, askRaw.kind, "none") as AskKind,
        hint: truncateChars(normalizeText(askRaw.hint), 16),
      },
      status: enumValue(SESSION_STATUSES, raw.status, "unknown"),
      terminalOpen: raw.terminalOpen === true,
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
    if (cursor !== raw.cursor || hintedRoot !== raw.rootId || session.mainline !== raw.mainline) repaired = true;
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
    state.offsets[key] = record;
  }

  if (input.schemaVersion !== SCHEMA_VERSION) repaired = true;
  state.schemaVersion = SCHEMA_VERSION;
  return { state, repaired };
}

export class StateStore {
  readonly statePath: string;
  #state: TrailState;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly logger = new Logger(join(directory, "server.log")),
  ) {
    this.statePath = join(directory, "state.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#state = this.#load();
  }

  snapshot(): TrailState {
    return structuredClone(this.#state);
  }

  async update<T>(mutator: (draft: TrailState) => T): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    const run = this.#tail.then(() => {
      try {
        const draft = structuredClone(this.#state);
        const value = mutator(draft);
        draft.revision += 1;
        draft.updatedAt = nowIso();
        const repaired = repairState(draft, draft.updatedAt).state;
        repaired.revision = draft.revision;
        repaired.updatedAt = draft.updatedAt;
        this.#write(repaired);
        this.#state = repaired;
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    this.#tail = run.catch(() => undefined);
    return result;
  }

  #load(): TrailState {
    if (!existsSync(this.statePath)) {
      const empty = createEmptyState();
      this.#write(empty);
      return empty;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      const corruptPath = `${this.statePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.statePath, corruptPath);
      } catch {}
      this.logger.error("state quarantined after parse failure", {
        corruptPath,
        error: String(error),
      });
      const empty = createEmptyState();
      this.#write(empty);
      return empty;
    }
    const { state, repaired } = repairState(parsed);
    if (repaired) {
      state.revision += 1;
      state.updatedAt = nowIso();
      this.#write(state);
      this.logger.warn("state repaired during load");
    }
    return state;
  }

  #write(state: TrailState): void {
    const tempPath = join(
      this.directory,
      `.state-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    const data = `${JSON.stringify(state, null, 2)}\n`;
    let fd: number | undefined;
    try {
      writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(tempPath, 0o600);
      fd = openSync(tempPath, "r");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.statePath);
      chmodSync(this.statePath, 0o600);
      try {
        const dirFd = openSync(this.directory, "r");
        fsyncSync(dirFd);
        closeSync(dirFd);
      } catch {}
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    }
  }
}

export class InstanceLock {
  readonly path: string;
  #held = false;
  #fd: number | null = null;
  #nativeFlock: ((fd: number, operation: number) => number) | null | undefined;

  constructor(readonly directory: string) {
    this.path = join(directory, ".instance.lock");
  }

  acquire(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (this.#held) return;
    const fd = openSync(this.path, "a+", 0o600);
    chmodSync(this.path, 0o600);
    const flock = this.#flock();
    if (!flock) {
      closeSync(fd);
      throw new Error("kernel flock is unavailable on this platform");
    }
    // LOCK_EX | LOCK_NB. The kernel releases this lock even after an abrupt exit.
    if (flock(fd, 2 | 4) !== 0) {
      closeSync(fd);
      let pid = "unknown";
      try {
        const owner = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number") pid = String(owner.pid);
      } catch {}
      throw new Error(`${APP_NAME} is already running (pid ${pid})`);
    }
    const owner = `${JSON.stringify({ pid: process.pid, app: APP_NAME, acquiredAt: nowIso() })}\n`;
    ftruncateSync(fd, 0);
    writeSync(fd, owner, 0, "utf8");
    fsyncSync(fd);
    this.#fd = fd;
    this.#held = true;
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    const fd = this.#fd;
    this.#fd = null;
    if (fd === null) return;
    try {
      this.#flock()?.(fd, 8); // LOCK_UN
    } finally {
      closeSync(fd);
    }
  }

  #flock(): ((fd: number, operation: number) => number) | null {
    if (this.#nativeFlock !== undefined) return this.#nativeFlock;
    try {
      const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
        flock: { args: ["i32", "i32"], returns: "i32" },
      });
      this.#nativeFlock = (fd, operation) => library.symbols.flock(fd, operation);
    } catch {
      this.#nativeFlock = null;
    }
    return this.#nativeFlock;
  }
}
