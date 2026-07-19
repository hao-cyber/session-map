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
    expect(css).toContain(".markmap-link { stroke: var(--branch) !important;");
    // Regression: invisible markmap measurement boxes must not cover child rows.
    expect(css).toContain("#mindmap foreignObject { overflow: hidden; }");
    expect(css).not.toContain("#mindmap foreignObject { overflow: visible; }");
  });

  test("keeps viewport navigation separate from user-controlled disclosure", () => {
    const app = readFileSync(resolve(root, "web", "app.js"), "utf8");
    expect(app).toContain("async function toggleNodeById(id)");
    expect(app).toContain("manualFold[id] = next");
    expect(app).toContain("saveManualFold()");
    expect(app).not.toContain("applySemanticZoom");
    expect(app).not.toContain('mm.zoom.on("zoom.sessionmap"');
    expect(app).not.toMatch(/transform\.k\s*[<>]/);

    const html = readFileSync(resolve(root, "web", "index.html"), "utf8");
    expect(html).toContain("拖动画布");
    expect(html).toContain("滚轮缩放");
    expect(html).toContain("点击展开");
    expect(html).not.toContain("<span>全景</span><i></i><span>转折</span>");
  });
});
