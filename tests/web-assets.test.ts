import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("offline browser bundle", () => {
  test("makes history intake and manual checking explicit without turning refresh into a reset", () => {
    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(html).toContain('id="intake-panel"');
    expect(html).toContain('id="check-now-button"');
    expect(html).toContain("新对话会从现在起持续整理");
    expect(html).toContain("不导入历史");
    expect(app).toContain('post("/api/intake/check"');
    expect(app).toContain('"/api/intake/start"');
    expect(app).toContain("后台最多 ${job.maxParallel || 2} 路并行");
    expect(app).not.toContain("localStorage.setItem(\"sessionmap.intake");
  });

  test("parses the vanilla browser entry as JavaScript", () => {
    const source = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(() => new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(source)).not.toThrow();
  });

  test("contains no external CDN or telemetry endpoint", () => {
    const files = ["web/index.html", "web/app.js", "web/styles.css", "web/manifest.webmanifest", "web/sessionmap-icon.svg", "web/brand-mark.svg"];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
      expect(source.toLowerCase()).not.toContain("analytics");
    }
  });

  test("uses complete neutral provider labels instead of unverified logo artwork", () => {
    const render = readFileSync(resolve(root, "src", "render.ts"), "utf8");
    const assets = readFileSync(resolve(root, "src", "assets.ts"), "utf8");
    expect(render).toContain('claude: "Claude"');
    expect(render).toContain('codex: "Codex"');
    expect(render).toContain('kimi: "Kimi"');
    expect(render).toContain('grok: "Grok"');
    expect(render).toContain('minimax: "MiniMax"');
    expect(render).toContain('aria-label="Provider：');
    expect(render).not.toContain("PROVIDER_ICONS");
    expect(assets).not.toContain("provider-claude.svg");
    expect(assets).not.toContain("provider-codex.svg");
    expect(assets).not.toContain("provider-kimi.svg");
    expect(assets).not.toContain("provider-grok.svg");
    expect(assets).not.toContain("provider-minimax.svg");
  });

  test("installs the same loopback map as a standalone web app", () => {
    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(root, "web", "manifest.webmanifest"), "utf8"));
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("/assets/sessionmap-icon.svg?v=__SESSIONMAP_ASSET_VERSION__");
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#f5f3ed",
    });
    expect(manifest.icons[0]).toMatchObject({ type: "image/svg+xml", purpose: "any maskable" });
    expect(readFileSync(resolve(root, "web", "app.js"), "utf8")).not.toContain("serviceWorker");
  });

  test("uses one semantic branch color instead of a rainbow palette", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(css).toContain("--branch: #a8a195");
    expect(css).toContain("rgba(168, 161, 149, 0.38)");
    expect(css).not.toContain("markmap-link");
    expect(app).not.toContain("markmapOptions");
  });

  test("keeps directory scrolling and outline disclosure free of canvas navigation", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(app).toContain("async function toggleDirectoryDisclosure(row)");
    expect(app).toContain("function pinDirectoryAnchor(anchor)");
    expect(app).toContain("function buildOutline(container, topic)");
    expect(app).toContain("function outlineDefaultFold(data)");
    expect(app).toContain("manualFold[id] = !expanded");
    expect(app).toContain("saveManualFold()");
    expect(app).not.toContain("mountOverview");
    expect(app).not.toContain("bindOverviewEvents");
    expect(app).not.toContain("applySemanticZoom");
    expect(app).not.toMatch(/transform\.k\s*[<>]/);

    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    expect(html).toContain('id="directory"');
    expect(html).toContain('id="attention-index-list"');
    expect(html).toContain('id="topic-index-list"');
    expect(html).toContain("工作线目录");
    expect(html).not.toContain('id="now-bar"');
    expect(html).toContain("主题与 Session 目录");
    expect(html).not.toContain('id="mindmap"');
    expect(html).not.toContain("拖动画布");
    expect(html).not.toContain('id="fit-button"');

    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(app).toContain('label.textContent = expanded ? "收起脉络" : "脉络"');
    expect(app).toContain('topicFoldKey = "sessionmap.topic-fold.v1"');
    expect(app).toContain('fold.className = "topic-fold"');
    expect(app).toContain("saveTopicFold()");
    expect(css).toContain(".topic-section.is-folded .topic-fold-count { display: inline; }");
    expect(css).not.toContain("#mindmap");
    expect(css).not.toContain(".lod-legend");
    expect(app).toContain("function renderTopicIndex()");
    expect(app).toContain("function syncTopicIndexSelection()");
    expect(app).toContain("function renderSessionContexts(workspaces)");
    expect(app).toContain("section?.scrollIntoView");
  });

  test("keeps session rows as jump entries while the topic owns lineage disclosure", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(app).not.toContain("scheduleSessionLocate");
    expect(app).not.toContain("locateSessionLineage");
    expect(app).not.toContain("is-locate-pending");
    expect(app).not.toContain('data-inline-action="locate-lineage"');
    expect(app).toContain("function toggleTopicFold(section)");
    expect(app).toContain('data-inline-action="fold-topic"');
    expect(app).toContain('const sessions = section.querySelector(":scope > .topic-body > .session-list")');
    expect(app).toContain("sessions.hidden = next");
    expect(app).toContain('lineageAction.classList.add("topic-lineage-action")');
    expect(app).toContain("overview.hidden = !expanded");
    expect(app).toContain("await jump(row.dataset.sessionId)");
    expect(app).toContain("const pendingJumps = new Set()");
    expect(app).toContain("pendingJumps.has(sessionId)");
    expect(app).toContain('button.dataset.pendingLabel || "正在前往…"');
    expect(app).not.toContain('toast("正在切回 session…")');
    expect(app).toContain("payload?.error || payload?.message");

    const render = readFileSync(resolve(root, "src", "render.ts"), "utf8");
    expect(render).toContain('data-action="none"');
    expect(render).not.toContain('data-inline-action="locate-lineage"');
    expect(render).toContain('data-inline-action="jump-session"');
    expect(render).not.toContain('class="topic-jump-action"');
    expect(render).toContain('session.status === "closed" ? "恢复终端" : "回到终端"');
    expect(render).not.toContain('data-kind="snapshot"');
    expect(render).toContain('data-action="fold-topic"');
    expect(render).toContain('"terminal-restore" : "terminal-return"');
    expect(render).not.toContain('"rotate-ccw" : "play"');
  });

  test("integrates actionable priority into the directory instead of a Now bar", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    const css = readFileSync(resolve(root, "web", "styles.css"), "utf8");
    expect(app).toContain("function renderAttention(items)");
    expect(app).toContain('item.kind === "decision" || item.kind === "reply" || item.kind === "blocker"');
    expect(app).toContain('mainline.className = "attention-mainline"');
    expect(app).toContain("mainline.textContent = item.mainline");
    expect(app).toContain("item.detail && item.detail !== item.mainline");
    expect(app).not.toContain("renderNow(");
    expect(css).toContain(".attention-mainline");
    expect(css).not.toContain(".now-bar");
  });

  test("opens directly in any local browser and uses tickets only for CLI ready acknowledgement", () => {
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
    expect(app).not.toContain('headers.set("X-SessionMap-Token"');
    expect(app).not.toContain("SESSIONMAP_TOKEN");
    expect(html).not.toContain("sessionmap.capability.v1");
    expect(app).not.toContain("x-maintrail-token");
    expect(app).toContain("打开回执已失效 · 正在直接读取本机数据");
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
