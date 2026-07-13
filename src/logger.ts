import { mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export class Logger {
  readonly #last = new Map<string, number>();
  constructor(readonly path?: string) {}

  info(message: string, fields?: Record<string, unknown>): void {
    this.#write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.#write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>, rateKey = message): void {
    const now = Date.now();
    const last = this.#last.get(rateKey) ?? 0;
    if (now - last < 60_000) return;
    this.#last.set(rateKey, now);
    this.#write("error", message, fields);
  }

  #write(level: string, message: string, fields?: Record<string, unknown>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
    if (level === "error") console.error(line);
    else console.log(line);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.path).size > 10 * 1024 * 1024) renameSync(this.path, `${this.path}.1`);
      } catch {}
      appendFileSync(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {}
  }
}
