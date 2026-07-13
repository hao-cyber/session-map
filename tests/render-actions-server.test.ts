import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ActionRouter, resumeCommand, shellQuote, validSessionId } from "../src/actions.ts";
import { AssetStore } from "../src/assets.ts";
import { SessionMonitor } from "../src/monitor.ts";
import { matchOrcaSession, stripSpinner, type OrcaSnapshot } from "../src/orca.ts";
import { activeSessionCount, buildNowItems, renderMarkdown } from "../src/render.ts";
import { MaintrailHttpServer, allowedOrigin, ensureCapabilityToken, validJsonMediaType } from "../src/server.ts";
import { StateStore } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import { cleanup, sessionRecord, temporaryDirectory, transcriptMeta } from "./helpers.ts";

const directories: string[] = [];
const servers: MaintrailHttpServer[] = [];
function directory(): string {
  const value = temporaryDirectory();
  directories.push(value);
  return value;
}
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop());
  directories.splice(0).forEach(cleanup);
});

describe("safe rendering and attention ordering", () => {
  test("renders model-controlled Markdown and HTML as literal text", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("s", process.cwd()), {
      mainline: "[x](javascript:alert(1)) <b>x</b>",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "note", label: "<img src=x>" }],
    });
    const markdown = renderMarkdown(store.snapshot());
    expect(markdown).not.toContain("[x](javascript:");
    expect(markdown).not.toContain("<b>x</b>");
    expect(markdown).not.toContain("<img src=x>");
    expect(markdown).toContain("&#91;x&#93;&#40;javascript:alert&#40;1&#41;&#41;");
    expect(markdown).toContain("&lt;img src=x&gt;");
  });

  test("groups three closed sibling leaves without deleting their details", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("s", process.cwd());
    await runtime.applyRoll(meta, { mainline: "History", ask: { kind: "none", hint: "" }, ops: [
      { op: "grow", parent: "mainline", type: "attempt", label: "路一" },
      { op: "grow", parent: "mainline", type: "attempt", label: "路二" },
      { op: "grow", parent: "mainline", type: "attempt", label: "路三" },
      { op: "grow", parent: "mainline", type: "task", label: "当前方向" },
    ] });
    const children = store.snapshot().nodes[store.snapshot().roots[0]!]!.children;
    await runtime.applyRoll(meta, { mainline: "History", ask: { kind: "none", hint: "" }, ops: children.slice(0, 3).map((node, index) => ({ op: "close", node, state: index === 1 ? "dead" : "resolved", note: "原因保留" })) });
    const markdown = renderMarkdown(store.snapshot());
    expect(markdown).toContain("历史：已完成 2 · 死路 1");
    expect(markdown).toContain("路一");
    expect(markdown).toContain("路二");
  });

  test("prioritizes decisions before replies, blockers, and busy work", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("decision", process.cwd()), { mainline: "Decide", ask: { kind: "decision", hint: "选方案" }, ops: [] });
    await runtime.applyRoll(transcriptMeta("reply", process.cwd()), { mainline: "Reply", ask: { kind: "reply", hint: "回一句" }, ops: [] });
    await store.update((state) => {
      state.sessions.decision!.terminalOpen = true;
      state.sessions.reply!.terminalOpen = true;
      state.sessions.reply!.status = "busy";
    });
    const items = buildNowItems(store.snapshot());
    expect(items.map((item) => item.kind).slice(0, 2)).toEqual(["decision", "reply"]);
    expect(activeSessionCount(store.snapshot())).toBe(2);
  });
});

describe("action safety and Orca matching", () => {
  test("validates session ids and quotes resume commands", () => {
    const cwd = directory();
    expect(validSessionId("safe-id_1.2")).toBeTrue();
    expect(validSessionId("bad; rm -rf")).toBeFalse();
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
    const session = sessionRecord("safe-id", cwd);
    expect(resumeCommand(session)).toBe(`cd ${shellQuote(cwd)} && claude --resume 'safe-id'`);
    expect(() => resumeCommand({ ...session, id: "bad;id" })).toThrow("invalid session id");
  });

  test("matches Orca by exact prompt then paneKey to terminal handle", () => {
    const session = sessionRecord("s", "/repo");
    session.lastUser = "same full prompt";
    const snapshot: OrcaSnapshot = {
      available: true,
      agents: [{ paneKey: "tab:leaf", state: "working", agentType: "claude", prompt: "same full prompt", taskTitle: "Other", updatedAt: Date.now(), worktreePath: "/repo" }],
      terminals: [{ handle: "terminal-handle", paneKey: "tab:leaf", title: "Terminal", connected: true, writable: true, worktreePath: "/repo" }],
    };
    expect(matchOrcaSession(session, snapshot).terminal?.handle).toBe("terminal-handle");
    expect(stripSpinner("⠋  Useful title")).toBe("Useful title");
  });
});

describe("local HTTP security boundary", () => {
  test("creates and reuses a 0600 capability token", () => {
    const root = directory();
    const first = ensureCapabilityToken(root);
    const second = ensureCapabilityToken(root);
    expect(first.token).toBe(second.token);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(first.token.length).toBeGreaterThanOrEqual(43);
  });

  test("validates loopback origins and JSON media types structurally", () => {
    const target = new URL("http://127.0.0.1:4317/api/archive");
    expect(allowedOrigin("http://localhost:4317", target)).toBeTrue();
    expect(allowedOrigin("http://127.0.0.1:9999", target)).toBeFalse();
    expect(allowedOrigin("https://127.0.0.1:4317", target)).toBeFalse();
    expect(allowedOrigin("http://evil.example:4317", target)).toBeFalse();
    expect(validJsonMediaType("application/json; charset=utf-8")).toBeTrue();
    expect(validJsonMediaType("text/plain")).toBeFalse();
  });

  test("requires the capability token on every API read", async () => {
    const { server, token } = await runningServer();
    expect((await fetch(`${server.url}/api/snapshot`)).status).toBe(401);
    const response = await fetch(`${server.url}/api/snapshot`, { headers: { "X-Maintrail-Token": token } });
    expect(response.status).toBe(200);
    expect((await response.json()).markdown).toContain("Maintrail");
  });

  test("injects the token with a nonce and serves only enumerated local assets", async () => {
    const { server, token } = await runningServer();
    const root = await fetch(server.url);
    const html = await root.text();
    expect(html).toContain(`window.MAINTRAIL_TOKEN = "${token}"`);
    expect(html).not.toContain("__MAINTRAIL_NONCE__");
    expect(root.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(`${server.url}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${server.url}/assets/unknown.js`)).status).toBe(404);
  });

  test("rejects evil origins, wrong media types, and non-object JSON", async () => {
    const { server, token } = await runningServer();
    const headers = { "X-Maintrail-Token": token };
    const evil = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { ...headers, Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(evil.status).toBe(403);
    const wrongType = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { ...headers, Origin: server.url, "Content-Type": "text/plain" }, body: "{}" });
    expect(wrongType.status).toBe(415);
    const array = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { ...headers, Origin: server.url, "Content-Type": "application/json" }, body: "[]" });
    expect(array.status).toBe(400);
  });

  test("archives and restores through an authorized click-equivalent POST", async () => {
    const fixture = await runningServer(true);
    const headers = { "X-Maintrail-Token": fixture.token, Origin: fixture.server.url, "Content-Type": "application/json" };
    const archived = await fetch(`${fixture.server.url}/api/archive`, { method: "POST", headers, body: JSON.stringify({ rootId: fixture.rootId }) });
    expect(archived.status).toBe(200);
    expect(fixture.store.snapshot().archived).toContain(fixture.rootId);
    const restored = await fetch(`${fixture.server.url}/api/restore`, { method: "POST", headers, body: JSON.stringify({ rootId: fixture.rootId }) });
    expect(restored.status).toBe(200);
    expect(fixture.store.snapshot().archived).not.toContain(fixture.rootId);
  });
});

async function runningServer(withMainline = false): Promise<{
  server: MaintrailHttpServer;
  token: string;
  store: StateStore;
  rootId: string;
}> {
  const root = directory();
  const store = new StateStore(root);
  const runtime = new TreeRuntime(store);
  let rootId = "";
  if (withMainline) {
    rootId = (await runtime.applyRoll(transcriptMeta("api-session", root), { mainline: "API work", ask: { kind: "none", hint: "" }, ops: [] })).rootId;
  }
  const monitor = new SessionMonitor(store);
  const server = new MaintrailHttpServer({
    store,
    runtime,
    actions: new ActionRouter(store),
    monitor,
    assets: new AssetStore(),
  }, { stateDirectory: root, port: 0 });
  servers.push(server);
  return { server, token: server.token, store, rootId };
}
