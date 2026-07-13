import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_HOST, DEFAULT_PORT, ENGINE_NAMES, MAX_POST_BYTES } from "./constants.ts";
import { ActionRouter } from "./actions.ts";
import { AssetStore } from "./assets.ts";
import { Logger } from "./logger.ts";
import { SessionMonitor } from "./monitor.ts";
import { detectEngines } from "./roll.ts";
import { StateStore } from "./state.ts";
import { TreeRuntime } from "./tree.ts";
import type { EngineName } from "./types.ts";
import { activeSessionCount, buildNowItems, renderMarkdown } from "./render.ts";
import { isRecord } from "./utils.ts";

export interface ServerDependencies {
  store: StateStore;
  runtime: TreeRuntime;
  actions: ActionRouter;
  monitor: SessionMonitor;
  assets?: AssetStore;
  logger?: Logger;
}

export interface ServerOptions {
  hostname?: string;
  port?: number;
  stateDirectory: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function normalizedPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function allowedOrigin(origin: string | null, requestUrl: URL): boolean {
  if (!origin || origin === "null") return false;
  try {
    const value = new URL(origin);
    return value.protocol === "http:" &&
      isLoopbackHostname(value.hostname) &&
      normalizedPort(value) === normalizedPort(requestUrl);
  } catch {
    return false;
  }
}

export function validJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export async function parseJsonObject(request: Request, requestUrl: URL): Promise<Record<string, unknown>> {
  if (!allowedOrigin(request.headers.get("origin"), requestUrl)) throw new HttpError(403, "origin is not allowed");
  if (!validJsonMediaType(request.headers.get("content-type"))) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const rawLength = request.headers.get("content-length");
  if (!rawLength || !/^\d+$/.test(rawLength)) throw new HttpError(411, "Content-Length is required");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_POST_BYTES) {
    throw new HttpError(413, "request body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_POST_BYTES || bytes.byteLength !== length) {
    throw new HttpError(400, "Content-Length does not match the request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new HttpError(400, "request body must be a JSON object");
  return parsed;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function ensureCapabilityToken(directory: string): { token: string; path: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "capability.token");
  if (existsSync(path)) {
    try {
      const token = readFileSync(path, "utf8").trim();
      if (/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
        chmodSync(path, 0o600);
        return { token, path };
      }
    } catch {}
  }
  const token = randomBytes(32).toString("base64url");
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  return { token, path };
}

function archivedRows(state: ReturnType<StateStore["snapshot"]>) {
  return state.archived.flatMap((id) => {
    const root = state.nodes[id];
    if (!root) return [];
    return [{
      id,
      label: root.label,
      updatedAt: root.updatedAt,
      sessions: Object.values(state.sessions).filter((session) => session.rootId === id).length,
    }];
  });
}

export class MaintrailHttpServer {
  readonly hostname: string;
  readonly requestedPort: number;
  readonly assets: AssetStore;
  readonly logger: Logger;
  readonly token: string;
  readonly server: ReturnType<typeof Bun.serve>;

  constructor(readonly dependencies: ServerDependencies, options: ServerOptions) {
    this.hostname = options.hostname ?? DEFAULT_HOST;
    if (this.hostname !== "127.0.0.1") throw new Error("Maintrail must bind to 127.0.0.1");
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.assets = dependencies.assets ?? new AssetStore();
    this.logger = dependencies.logger ?? new Logger(join(options.stateDirectory, "server.log"));
    this.token = ensureCapabilityToken(options.stateDirectory).token;
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      fetch: (request, server) => this.handle(request, server),
      error: (error) => {
        this.logger.error("http handler failed", { error: String(error) });
        return text("internal server error", 500);
      },
    });
  }

  get url(): string {
    return `http://${this.hostname}:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  async handle(request: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (!isLoopbackHostname(requestUrl.hostname)) return text("invalid host", 403);
    const client = server.requestIP(request);
    if (client && client.address !== "127.0.0.1" && client.address !== "::1" && client.address !== "::ffff:127.0.0.1") {
      return text("loopback clients only", 403);
    }
    try {
      if (requestUrl.pathname === "/" && request.method === "GET") return this.index();
      if (requestUrl.pathname === "/favicon.ico" && request.method === "GET") return new Response(null, { status: 204 });
      if (requestUrl.pathname.startsWith("/assets/") && request.method === "GET") {
        return this.asset(requestUrl.pathname.slice("/assets/".length));
      }
      if (!requestUrl.pathname.startsWith("/api/")) return text("not found", 404);
      if (!secureEquals(request.headers.get("x-maintrail-token") ?? "", this.token)) {
        return json({ error: "invalid capability token" }, 401);
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/snapshot") return this.snapshot();
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body = await parseJsonObject(request, requestUrl);
      return await this.post(requestUrl.pathname, body);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      this.logger.error("api request failed", { path: requestUrl.pathname, error: String(error) }, requestUrl.pathname);
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  index(): Response {
    const source = this.assets.get("index.html");
    if (!source) return text("index asset unavailable", 500);
    const nonce = randomBytes(18).toString("base64url");
    const body = source.body
      .replaceAll("__MAINTRAIL_TOKEN__", this.token)
      .replaceAll("__MAINTRAIL_NONCE__", nonce)
      .replaceAll("__MAINTRAIL_ASSET_VERSION__", String(this.assets.version()));
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": source.contentType,
        "Content-Security-Policy": [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "font-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join("; "),
        "Cross-Origin-Opener-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  }

  asset(name: string): Response {
    const asset = this.assets.get(name);
    if (!asset) return text("asset not found", 404);
    return new Response(asset.body, {
      headers: {
        "Cache-Control": this.assets.development ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Type": asset.contentType,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  snapshot(): Response {
    const state = this.dependencies.store.snapshot();
    return json({
      revision: state.revision,
      updatedAt: state.updatedAt,
      markdown: renderMarkdown(state),
      now: buildNowItems(state),
      activeSessions: activeSessionCount(state),
      git: this.dependencies.monitor.gitChips(),
      archived: archivedRows(state),
      engine: state.engine,
      engines: detectEngines().map(({ name, available, reason }) => ({ name, available, ...(reason ? { reason } : {}) })),
      assetVersion: this.assets.version(),
    });
  }

  async post(path: string, body: Record<string, unknown>): Promise<Response> {
    if (path === "/api/jump") {
      if (typeof body.sessionId !== "string") throw new HttpError(400, "sessionId is required");
      const result = await this.dependencies.actions.jump(body.sessionId);
      return json(result, result.ok ? 200 : 409);
    }
    if (path === "/api/say") {
      if (typeof body.sessionId !== "string" || typeof body.text !== "string") {
        throw new HttpError(400, "sessionId and text are required");
      }
      const result = await this.dependencies.actions.say(body.sessionId, body.text);
      return json(result, result.ok ? 200 : 409);
    }
    if (path === "/api/archive" || path === "/api/restore") {
      if (typeof body.rootId !== "string") throw new HttpError(400, "rootId is required");
      const ok = path === "/api/archive"
        ? await this.dependencies.runtime.archive(body.rootId)
        : await this.dependencies.runtime.restore(body.rootId);
      if (!ok) throw new HttpError(404, "unknown mainline");
      return json({ ok: true });
    }
    if (path === "/api/engine") {
      if (typeof body.engine !== "string" || !(ENGINE_NAMES as readonly string[]).includes(body.engine)) {
        throw new HttpError(400, "unknown roll engine");
      }
      const engine = body.engine as EngineName;
      const availability = detectEngines().find((entry) => entry.name === engine);
      if (!availability?.available) {
        throw new HttpError(409, `roll engine ${engine} is not available${availability?.reason ? ` (${availability.reason})` : ""}`);
      }
      await this.dependencies.store.update((state) => { state.engine = engine; });
      return json({ ok: true, engine });
    }
    throw new HttpError(404, "unknown API endpoint");
  }
}
