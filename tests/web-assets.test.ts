import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AssetStore } from "@sessionmap/cli/assets.ts";

const root = resolve(import.meta.dir, "..");
const appSources = ["bootstrap.js", "directory.js", "intake.js", "actions.js", "lifecycle.js"];
const styleSources = ["foundation.css", "map.css", "intake.css", "indexes.css", "topics.css", "overlays.css"];

function readWebBundle(kind: "app" | "styles"): string {
  const sources = kind === "app" ? appSources : styleSources;
  return sources.map((source) => readFileSync(resolve(root, "packages", "web", "src", kind, source), "utf8")).join("");
}

describe("offline browser bundle", () => {
  test("assembles responsibility slices into the two stable public assets", () => {
    const assets = new AssetStore();
    const app = assets.get("app.js");
    const styles = assets.get("styles.css");
    expect(app?.parts).toEqual(appSources.map((source) => `app/${source}`));
    expect(styles?.parts).toEqual(styleSources.map((source) => `styles/${source}`));
    expect(app?.body).toBe(readWebBundle("app"));
    expect(styles?.body).toBe(readWebBundle("styles"));
  });

  test("makes history intake and manual checking explicit without turning refresh into a reset", () => {
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const app = readWebBundle("app");
    expect(html).toContain('id="intake-panel"');
    expect(html).toContain('id="check-now-button"');
    expect(html).toContain("新对话会从现在起持续整理");
    expect(html).toContain("不导入历史");
    expect(app).toContain('post("/api/intake/check"');
    expect(app).toContain('"/api/intake/start"');
    expect(app).toContain("历史最多 ${job.maxParallel || 2} 路并行");
    expect(app).not.toContain("localStorage.setItem(\"sessionmap.intake");
  });

  test("opens local help from the brand without adding another product surface", () => {
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const app = readWebBundle("app");
    const css = readWebBundle("styles");
    expect(html).toContain('id="help-button"');
    expect(html).toContain('aria-controls="help-dialog"');
    expect(html).toContain('id="help-dialog"');
    expect(html).toContain("三秒找回当时的自己");
    expect(html).toContain("使用情况统计或遥测");
    expect(app).toContain("helpDialog.showModal()");
    expect(app).toContain("helpDialog.close()");
    expect(css).toContain(".help-dialog::backdrop");
  });

  test("parses the vanilla browser entry as JavaScript", () => {
    const source = readWebBundle("app");
    expect(() => new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(source)).not.toThrow();
  });

  test("contains no external CDN or telemetry endpoint", () => {
    const files = [
      "packages/web/src/index.html",
      ...appSources.map((source) => `packages/web/src/app/${source}`),
      ...styleSources.map((source) => `packages/web/src/styles/${source}`),
      "packages/web/src/manifest.webmanifest",
      "packages/web/src/sessionmap-icon.svg",
      "packages/web/src/brand-mark.svg",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
      expect(source.toLowerCase()).not.toContain("analytics");
    }
  });

  test("uses complete neutral provider labels instead of unverified logo artwork", () => {
    const render = readFileSync(resolve(root, "packages", "core", "src", "render.ts"), "utf8");
    const assets = readFileSync(resolve(root, "apps", "cli", "src", "assets.ts"), "utf8");
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
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(root, "packages", "web", "src", "manifest.webmanifest"), "utf8"));
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
    expect(readWebBundle("app")).not.toContain("serviceWorker");
  });

  test("uses one semantic branch color instead of a rainbow palette", () => {
    const app = readWebBundle("app");
    const css = readWebBundle("styles");
    expect(css).toContain("--branch: #a8a195");
    expect(css).toContain("rgba(168, 161, 149, 0.38)");
    expect(css).not.toContain("markmap-link");
    expect(app).not.toContain("markmapOptions");
  });

  test("keeps directory scrolling and outline disclosure free of canvas navigation", () => {
    const app = readWebBundle("app");
    expect(app).toContain("async function toggleDirectoryDisclosure(row)");
    expect(app).toContain("function pinDirectoryAnchor(anchor)");
    expect(app).toContain("function buildOutline(container, topic)");
    expect(app).toContain("function outlineDefaultFold(data)");
    expect(app).toContain('element.querySelector(".cursor")');
    expect(app).toContain('wrap.classList.add("is-current-node")');
    expect(app).toContain("manualFold[id] = !expanded");
    expect(app).toContain("saveManualFold()");
    expect(app).not.toContain("mountOverview");
    expect(app).not.toContain("bindOverviewEvents");
    expect(app).not.toContain("applySemanticZoom");
    expect(app).not.toMatch(/transform\.k\s*[<>]/);

    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    expect(html).toContain('id="directory"');
    expect(html).toContain('id="attention-index-list"');
    expect(html).toContain('id="topic-index-list"');
    expect(html).toContain("工作线目录");
    expect(html).not.toContain('id="now-bar"');
    expect(html).toContain("主题与 Session 目录");
    expect(html).not.toContain('id="mindmap"');
    expect(html).not.toContain("拖动画布");
    expect(html).not.toContain('id="fit-button"');

    const css = readWebBundle("styles");
    expect(app).toContain('label.textContent = expanded ? "收起脉络" : "查看脉络"');
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
    const app = readWebBundle("app");
    expect(app).not.toContain("scheduleSessionLocate");
    expect(app).not.toContain("locateSessionLineage");
    expect(app).not.toContain("is-locate-pending");
    expect(app).not.toContain('data-inline-action="locate-lineage"');
    expect(app).toContain("function toggleTopicFold(section)");
    expect(app).toContain('data-inline-action="fold-topic"');
    expect(app).toContain('const sessions = section.querySelector(":scope > .topic-body > .session-list")');
    expect(app).toContain("sessions.hidden = next");
    expect(app).toContain('lineageAction.classList.add("topic-lineage-action")');
    expect(app).toContain('topicStatus.className = "topic-status"');
    expect(app).toContain('outline.setAttribute("role", "region")');
    expect(app).toContain('row.setAttribute("aria-controls", outlineId)');
    expect(app).toContain('row.setAttribute("aria-controls", list.id)');
    expect(app).toContain("decorateRows(container)");
    expect(app).not.toContain('outline.setAttribute("role", "tree")');
    expect(app).toContain('if (name.startsWith("state-")) topicStatus.classList.add(name)');
    expect(app).toContain('const stateWord = headerRow.querySelector(".state-word")');
    expect(app).toContain("headerLayout.append(lineageAction)");
    expect(app).toContain("headerLayout.append(topicStatus)");
    expect(app.indexOf("headerLayout.append(lineageAction)")).toBeLessThan(app.indexOf("headerLayout.append(topicStatus)"));
    expect(app).toContain("overview.hidden = !expanded");
    expect(app).toContain("await jump(row.dataset.sessionId)");
    expect(app).toContain("const pendingJumps = new Set()");
    expect(app).toContain("pendingJumps.has(sessionId)");
    expect(app).toContain('button.dataset.pendingLabel || "正在前往…"');
    expect(app).not.toContain('toast("正在切回 session…")');
    expect(app).toContain("payload?.error || payload?.message");

    const render = readFileSync(resolve(root, "packages", "core", "src", "render.ts"), "utf8");
    expect(render).toContain('data-action="none"');
    expect(render).not.toContain('data-inline-action="locate-lineage"');
    expect(render).toContain('data-inline-action="jump-session"');
    expect(render).not.toContain('class="topic-jump-action"');
    expect(render).toContain('session.status === "closed" ? "恢复终端" : "回到终端"');
    expect(render).not.toContain('data-kind="snapshot"');
    expect(render).toContain('<span class="thought-kicker">查看脉络</span>');
    expect(render).toContain('<span class="thought-focus">');
    expect(render).not.toContain('class="thought-focus" hidden');
    expect(render).toContain('class="node-type-label"');
    expect(render).toContain('data-action="fold-topic"');
    expect(render).toContain('"terminal-restore" : "terminal-return"');
    expect(render).not.toContain('"rotate-ccw" : "play"');

    const css = readWebBundle("styles");
    expect(css).toContain('.topic-lineage-action[aria-expanded="true"]');
    expect(css).toContain(".topic-status .state-word { margin-left: 0; }");
    expect(css).not.toContain(".topic-body::before");
    expect(css).not.toContain(".session-entry::before");
    expect(css).not.toContain(".topic-overview::before");
    expect(css).toContain(".outline-node > .outline-children");
    expect(css).toContain(".outline-node > .outline-children > .outline-node::before");
    expect(css).toContain(".outline-node.is-current-node > .fm-node");
    expect(app).toContain("function outlineCurrentCount(data)");
    expect(app).toContain('`⌖ ${currentCount} 个当前落点`');
    expect(css).toContain(".outline-node .type-mark {\n  display: none;\n}");
  });

  test("integrates actionable priority into the directory instead of a Now bar", () => {
    const app = readWebBundle("app");
    const css = readWebBundle("styles");
    expect(app).toContain("function renderAttention(items)");
    expect(app).toContain('item.kind === "decision" || item.kind === "reply" || item.kind === "blocker"');
    expect(app).toContain('mainline.className = "attention-mainline"');
    expect(app).toContain("mainline.textContent = item.mainline");
    expect(app).toContain("item.detail && item.detail !== item.mainline");
    expect(app).not.toContain("renderNow(");
    expect(css).toContain(".attention-mainline");
    expect(css).toContain('border-left-color: var(--decision)');
    expect(css).toContain(".session-decision .session-jump-action");
    expect(css).toContain(".directory .fm-session.session-waiting");
    expect(css).toContain(".topic-header .fm-mainline { flex: 1 1 100%");
    expect(css).toContain("bottom: 5px;");
    expect(css).not.toContain(".now-bar");
  });

  test("shows exact Roll token usage as quiet chrome instead of a cost dashboard", () => {
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const app = readWebBundle("app");
    const css = readWebBundle("styles");
    expect(html).toContain('id="roll-usage"');
    expect(app).toContain("renderRollUsage(data.rollUsage)");
    expect(app).toContain("当前 Roll CLI 未返回可验证的 token usage");
    expect(css).toContain(".roll-usage");
  });

  test("keeps the desktop workline index compact without shrinking its hit targets below the reading contract", () => {
    const css = readWebBundle("styles");
    expect(css).toContain("grid-template-columns: 220px minmax(0, 1fr)");
    expect(css).toMatch(/\.attention-item\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/#topic-index-list button\s*\{[^}]*min-height:\s*34px/s);
  });

  test("uses one compact vertical rhythm for topic ownership instead of stacked empty gaps", () => {
    const css = readWebBundle("styles");
    expect(css).toMatch(/\.topic-section\s*\{[^}]*margin:\s*0 0 20px/s);
    expect(css).toMatch(/\.topic-header\s*\{[^}]*padding:\s*4px 0/s);
    expect(css).toMatch(/\.topic-body\s*\{[^}]*padding:\s*0 0 0 24px/s);
    expect(css).toContain(".session-list { margin-top: 0; }");
    expect(css).toContain(".intake-panel:not([hidden]) + .directory { padding-top: 12px; }");
  });

  test("opens directly in any local browser and uses tickets only for CLI ready acknowledgement", () => {
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const app = readWebBundle("app");
    const cli = readFileSync(resolve(root, "apps", "cli", "src", "cli.ts"), "utf8");
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
    const html = readFileSync(resolve(root, "packages", "web", "src", "index.html"), "utf8");
    const styles = readWebBundle("styles");
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      expect(match[1]).toContain("?v=__SESSIONMAP_ASSET_VERSION__");
    }
    for (const match of styles.matchAll(/url\("(\/assets\/[^"]+)"\)/g)) {
      expect(match[1]).toContain("?v=__SESSIONMAP_ASSET_VERSION__");
    }
  });
});
