import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import INDEX_HTML_IMPORT from "../web/index.html" with { type: "text" };
import APP_JS_IMPORT from "../web/app.js" with { type: "text" };
import STYLES_CSS_IMPORT from "../web/styles.css" with { type: "text" };
import D3_JS_IMPORT from "../web/vendor/d3.min.js" with { type: "text" };
import MARKMAP_LIB_JS_IMPORT from "../web/vendor/markmap-lib.js" with { type: "text" };
import MARKMAP_VIEW_JS_IMPORT from "../web/vendor/markmap-view.js" with { type: "text" };
import ARCHIVE_SVG_IMPORT from "../web/vendor/icons/archive.svg" with { type: "text" };
import CHECK_SVG_IMPORT from "../web/vendor/icons/check-circle-2.svg" with { type: "text" };
import CHEVRON_SVG_IMPORT from "../web/vendor/icons/chevron-down.svg" with { type: "text" };
import ALERT_SVG_IMPORT from "../web/vendor/icons/circle-alert.svg" with { type: "text" };
import CLOCK_SVG_IMPORT from "../web/vendor/icons/clock-3.svg" with { type: "text" };
import CROSSHAIR_SVG_IMPORT from "../web/vendor/icons/crosshair.svg" with { type: "text" };
import GIT_SVG_IMPORT from "../web/vendor/icons/git-branch.svg" with { type: "text" };
import MESSAGE_SVG_IMPORT from "../web/vendor/icons/message-circle.svg" with { type: "text" };
import MOON_SVG_IMPORT from "../web/vendor/icons/moon.svg" with { type: "text" };
import PLAY_SVG_IMPORT from "../web/vendor/icons/play.svg" with { type: "text" };
import ROTATE_SVG_IMPORT from "../web/vendor/icons/rotate-ccw.svg" with { type: "text" };
import SEND_SVG_IMPORT from "../web/vendor/icons/send.svg" with { type: "text" };
import X_SVG_IMPORT from "../web/vendor/icons/x.svg" with { type: "text" };
import ZOOM_SVG_IMPORT from "../web/vendor/icons/zoom-in.svg" with { type: "text" };

// Bun embeds text imports into compiled executables. The casts bridge TypeScript's
// generic HTML module type without changing the runtime representation.
const INDEX_HTML = INDEX_HTML_IMPORT as unknown as string;
const APP_JS = APP_JS_IMPORT as unknown as string;
const STYLES_CSS = STYLES_CSS_IMPORT as unknown as string;
const D3_JS = D3_JS_IMPORT as unknown as string;
const MARKMAP_LIB_JS = MARKMAP_LIB_JS_IMPORT as unknown as string;
const MARKMAP_VIEW_JS = MARKMAP_VIEW_JS_IMPORT as unknown as string;
const ARCHIVE_SVG = ARCHIVE_SVG_IMPORT as unknown as string;
const CHECK_SVG = CHECK_SVG_IMPORT as unknown as string;
const CHEVRON_SVG = CHEVRON_SVG_IMPORT as unknown as string;
const ALERT_SVG = ALERT_SVG_IMPORT as unknown as string;
const CLOCK_SVG = CLOCK_SVG_IMPORT as unknown as string;
const CROSSHAIR_SVG = CROSSHAIR_SVG_IMPORT as unknown as string;
const GIT_SVG = GIT_SVG_IMPORT as unknown as string;
const MESSAGE_SVG = MESSAGE_SVG_IMPORT as unknown as string;
const MOON_SVG = MOON_SVG_IMPORT as unknown as string;
const PLAY_SVG = PLAY_SVG_IMPORT as unknown as string;
const ROTATE_SVG = ROTATE_SVG_IMPORT as unknown as string;
const SEND_SVG = SEND_SVG_IMPORT as unknown as string;
const X_SVG = X_SVG_IMPORT as unknown as string;
const ZOOM_SVG = ZOOM_SVG_IMPORT as unknown as string;

export type Asset = { body: string; contentType: string; source: string };

const EMBEDDED: Record<string, Asset> = {
  "index.html": { body: INDEX_HTML, contentType: "text/html; charset=utf-8", source: "index.html" },
  "app.js": { body: APP_JS, contentType: "text/javascript; charset=utf-8", source: "app.js" },
  "styles.css": { body: STYLES_CSS, contentType: "text/css; charset=utf-8", source: "styles.css" },
  "vendor/d3.min.js": { body: D3_JS, contentType: "text/javascript; charset=utf-8", source: "vendor/d3.min.js" },
  "vendor/markmap-lib.js": { body: MARKMAP_LIB_JS, contentType: "text/javascript; charset=utf-8", source: "vendor/markmap-lib.js" },
  "vendor/markmap-view.js": { body: MARKMAP_VIEW_JS, contentType: "text/javascript; charset=utf-8", source: "vendor/markmap-view.js" },
  "vendor/icons/archive.svg": { body: ARCHIVE_SVG, contentType: "image/svg+xml", source: "vendor/icons/archive.svg" },
  "vendor/icons/check-circle-2.svg": { body: CHECK_SVG, contentType: "image/svg+xml", source: "vendor/icons/check-circle-2.svg" },
  "vendor/icons/chevron-down.svg": { body: CHEVRON_SVG, contentType: "image/svg+xml", source: "vendor/icons/chevron-down.svg" },
  "vendor/icons/circle-alert.svg": { body: ALERT_SVG, contentType: "image/svg+xml", source: "vendor/icons/circle-alert.svg" },
  "vendor/icons/clock-3.svg": { body: CLOCK_SVG, contentType: "image/svg+xml", source: "vendor/icons/clock-3.svg" },
  "vendor/icons/crosshair.svg": { body: CROSSHAIR_SVG, contentType: "image/svg+xml", source: "vendor/icons/crosshair.svg" },
  "vendor/icons/git-branch.svg": { body: GIT_SVG, contentType: "image/svg+xml", source: "vendor/icons/git-branch.svg" },
  "vendor/icons/message-circle.svg": { body: MESSAGE_SVG, contentType: "image/svg+xml", source: "vendor/icons/message-circle.svg" },
  "vendor/icons/moon.svg": { body: MOON_SVG, contentType: "image/svg+xml", source: "vendor/icons/moon.svg" },
  "vendor/icons/play.svg": { body: PLAY_SVG, contentType: "image/svg+xml", source: "vendor/icons/play.svg" },
  "vendor/icons/rotate-ccw.svg": { body: ROTATE_SVG, contentType: "image/svg+xml", source: "vendor/icons/rotate-ccw.svg" },
  "vendor/icons/send.svg": { body: SEND_SVG, contentType: "image/svg+xml", source: "vendor/icons/send.svg" },
  "vendor/icons/x.svg": { body: X_SVG, contentType: "image/svg+xml", source: "vendor/icons/x.svg" },
  "vendor/icons/zoom-in.svg": { body: ZOOM_SVG, contentType: "image/svg+xml", source: "vendor/icons/zoom-in.svg" },
};

export class AssetStore {
  readonly webRoot: string;
  readonly development: boolean;

  constructor() {
    this.webRoot = resolve(join(dirname(import.meta.path), "..", "web"));
    this.development = process.env.MAINTRAIL_DEV === "1" && existsSync(join(this.webRoot, "index.html"));
  }

  get(name: string): Asset | null {
    const embedded = EMBEDDED[name];
    if (!embedded) return null;
    if (!this.development) return embedded;
    try {
      const candidate = realpathSync(join(this.webRoot, embedded.source));
      const root = realpathSync(this.webRoot);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
      return { ...embedded, body: readFileSync(candidate, "utf8") };
    } catch {
      return embedded;
    }
  }

  version(): number {
    if (this.development) {
      let latest = 0;
      for (const asset of Object.values(EMBEDDED)) {
        try {
          latest = Math.max(latest, statSync(join(this.webRoot, asset.source)).mtimeMs);
        } catch {}
      }
      if (latest) return Math.floor(latest);
    }
    return Math.abs(Number(Bun.hash(INDEX_HTML)));
  }
}
