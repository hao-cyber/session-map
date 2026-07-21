import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Logger } from "./logger.ts";
import { createEmptyState, repairState } from "./state-repair.ts";
import type { TrailState } from "./types.ts";
import { nowIso } from "./utils.ts";

export function containingGitWorktree(path: string): string | null {
  let current = resolve(path);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export class StateStore {
  readonly statePath: string;
  #state: TrailState;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly logger = new Logger(join(directory, "server.log")),
  ) {
    const worktree = containingGitWorktree(directory);
    if (worktree) {
      throw new Error(`SessionMap state directory must stay outside Git worktrees: ${worktree}`);
    }
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
