import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("offline browser bundle", () => {
  test("parses the vanilla browser entry as JavaScript", () => {
    const source = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(() => new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(source)).not.toThrow();
  });

  test("contains no external CDN or telemetry endpoint", () => {
    const files = ["web/index.html", "web/app.js", "web/styles.css"];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/https?:\/\//);
      expect(source.toLowerCase()).not.toContain("analytics");
    }
  });

  test("uses one semantic branch color instead of a rainbow palette", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(app).toContain('color: () => "#aab2be"');
    expect(css).toContain("--branch: #aab2be");
    expect(css).toContain(".overview-canvas .markmap-link { stroke: var(--branch) !important;");
    // Regression: invisible markmap measurement boxes must not cover child rows.
    expect(css).toContain(".overview-canvas foreignObject { overflow: hidden; }");
    expect(css).not.toContain(".overview-canvas foreignObject { overflow: visible; }");
  });

  test("keeps directory scrolling and local viewport navigation separate from disclosure", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(app).toContain("async function toggleNodeById(id)");
    expect(app).toContain("async function toggleDirectoryDisclosure(row)");
    expect(app).toContain("function pinDirectoryAnchor(anchor)");
    expect(app).toContain('control.textContent = expanded ? "收起" : "脉络"');
    expect(app).toContain("manualFold[id] = next");
    expect(app).toContain("saveManualFold()");
    expect(app).not.toContain("applySemanticZoom");
    expect(app).not.toContain('mm.zoom.on("zoom.sessionmap"');
    expect(app).not.toMatch(/transform\.k\s*[<>]/);

    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    expect(html).toContain('id="directory"');
    expect(html).toContain("主题与 Session 目录");
    expect(html).not.toContain('id="mindmap"');
    expect(html).not.toContain("拖动画布");
    expect(html).not.toContain('id="fit-button"');

    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(css).toContain('.thought-summary[aria-expanded="true"]::after { content: "收起"; }');
    expect(css).not.toContain("#mindmap");
    expect(css).not.toContain(".lod-legend");
  });

  test("separates session disclosure from terminal navigation", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(app).toContain("const SESSION_CLICK_DELAY_MS = 350");
    expect(app).toContain("function scheduleSessionToggle(row)");
    expect(app).toContain("function setDisclosurePending(nodeId, pending)");
    expect(app).toContain('row.classList.toggle("is-disclosure-pending", pending)');
    expect(app).toContain('row.dataset.action === "session"');
    expect(app).toContain("cancelSessionToggle(row.dataset.nodeId)");
    expect(app).toContain("await jump(row.dataset.sessionId)");
    expect(app).toContain("const pendingJumps = new Set()");
    expect(app).toContain("pendingJumps.has(sessionId)");
    expect(app).toContain('button.dataset.pendingLabel || "正在前往…"');
    expect(app).not.toContain('toast("正在切回 session…")');
    expect(app).toContain("payload?.error || payload?.message");
    expect(app).toMatch(/svg\.addEventListener\("dblclick",[\s\S]*?\}, true\);/);

    const render = readFileSync(resolve(root, "src", "render.ts"), "utf8");
    expect(render).toContain('data-action="session"');
    expect(render).toContain('data-inline-action="jump-session"');
  });

  test("keeps the work mainline visible in every Now item", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(app).toContain('mainline.className = "now-mainline"');
    expect(app).toContain("mainline.textContent = item.mainline");
    expect(app).toContain("item.detail && item.detail !== item.mainline");
    expect(css).toContain(".now-mainline");
  });

  test("bootstraps a one-time open ticket and gives expired credentials a recovery action", () => {
    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    const cli = readFileSync(resolve(root, "src", "cli.ts"), "utf8");
    expect(html).toContain('fragment.get("open")');
    expect(html).not.toContain('fragment.get("cap")');
    expect(app).toContain('fetch("/api/open/exchange"');
    expect(app).toContain('post("/api/open/ready"');
    expect(app).toContain("await exchangeOpenTicket()");
    expect(app).toContain("clearOpenHandshake()");
    expect(app).toContain("const hasPendingExchange = window.SESSIONMAP_OPEN_TICKET");
    expect(app).toContain("if (hasPendingExchange) await exchangeOpenTicket()");
    expect(app).toContain('headers.set("X-SessionMap-Token"');
    expect(app).not.toContain("x-maintrail-token");
    expect(app).toContain("访问凭据已失效 · 请重新运行 sessionmap open");
    expect(cli).toContain("--browser APP");
  });

  test("versions every browser entry asset so immutable caches cannot mix releases", () => {
    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    const styles = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      expect(match[1]).toContain("?v=__SESSIONMAP_ASSET_VERSION__");
    }
    for (const match of styles.matchAll(/url\("(\/assets\/[^"]+)"\)/g)) {
      expect(match[1]).toContain("?v=__SESSIONMAP_ASSET_VERSION__");
    }
  });
});
