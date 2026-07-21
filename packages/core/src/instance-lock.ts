import {
  chmodSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { dlopen } from "bun:ffi";
import { APP_NAME } from "./constants.ts";
import { nowIso } from "./utils.ts";

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
