import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import INDEX_HTML_IMPORT from "@sessionmap/web/index.html" with { type: "text" };
import APP_BOOTSTRAP_IMPORT from "@sessionmap/web/app/bootstrap.js" with { type: "text" };
import APP_DIRECTORY_IMPORT from "@sessionmap/web/app/directory.js" with { type: "text" };
import APP_INTAKE_IMPORT from "@sessionmap/web/app/intake.js" with { type: "text" };
import APP_ACTIONS_IMPORT from "@sessionmap/web/app/actions.js" with { type: "text" };
import APP_LIFECYCLE_IMPORT from "@sessionmap/web/app/lifecycle.js" with { type: "text" };
import STYLES_FOUNDATION_IMPORT from "@sessionmap/web/styles/foundation.css" with { type: "text" };
import STYLES_MAP_IMPORT from "@sessionmap/web/styles/map.css" with { type: "text" };
import STYLES_INTAKE_IMPORT from "@sessionmap/web/styles/intake.css" with { type: "text" };
import STYLES_INDEXES_IMPORT from "@sessionmap/web/styles/indexes.css" with { type: "text" };
import STYLES_TOPICS_IMPORT from "@sessionmap/web/styles/topics.css" with { type: "text" };
import STYLES_OVERLAYS_IMPORT from "@sessionmap/web/styles/overlays.css" with { type: "text" };
import MANIFEST_IMPORT from "@sessionmap/web/manifest.webmanifest" with { type: "text" };
import SESSIONMAP_ICON_IMPORT from "@sessionmap/web/sessionmap-icon.svg" with { type: "text" };
import BRAND_MARK_IMPORT from "@sessionmap/web/brand-mark.svg" with { type: "text" };
import MARKMAP_LIB_JS_IMPORT from "@sessionmap/web/vendor/markmap-lib.js" with { type: "text" };
import ARCHIVE_SVG_IMPORT from "@sessionmap/web/vendor/icons/archive.svg" with { type: "text" };
import CHECK_SVG_IMPORT from "@sessionmap/web/vendor/icons/check-circle-2.svg" with { type: "text" };
import CHEVRON_SVG_IMPORT from "@sessionmap/web/vendor/icons/chevron-down.svg" with { type: "text" };
import ALERT_SVG_IMPORT from "@sessionmap/web/vendor/icons/circle-alert.svg" with { type: "text" };
import CLOCK_SVG_IMPORT from "@sessionmap/web/vendor/icons/clock-3.svg" with { type: "text" };
import CROSSHAIR_SVG_IMPORT from "@sessionmap/web/vendor/icons/crosshair.svg" with { type: "text" };
import GIT_SVG_IMPORT from "@sessionmap/web/vendor/icons/git-branch.svg" with { type: "text" };
import LOCATE_LINEAGE_SVG_IMPORT from "@sessionmap/web/vendor/icons/locate-lineage.svg" with { type: "text" };
import MESSAGE_SVG_IMPORT from "@sessionmap/web/vendor/icons/message-circle.svg" with { type: "text" };
import MOON_SVG_IMPORT from "@sessionmap/web/vendor/icons/moon.svg" with { type: "text" };
import SEND_SVG_IMPORT from "@sessionmap/web/vendor/icons/send.svg" with { type: "text" };
import TERMINAL_RESTORE_SVG_IMPORT from "@sessionmap/web/vendor/icons/terminal-restore.svg" with { type: "text" };
import TERMINAL_RETURN_SVG_IMPORT from "@sessionmap/web/vendor/icons/terminal-return.svg" with { type: "text" };
import X_SVG_IMPORT from "@sessionmap/web/vendor/icons/x.svg" with { type: "text" };
import ZOOM_SVG_IMPORT from "@sessionmap/web/vendor/icons/zoom-in.svg" with { type: "text" };

// Bun embeds text imports into compiled executables. The casts bridge TypeScript's
// generic HTML module type without changing the runtime representation.
const INDEX_HTML = INDEX_HTML_IMPORT as unknown as string;
const APP_SOURCES = ["app/bootstrap.js", "app/directory.js", "app/intake.js", "app/actions.js", "app/lifecycle.js"];
const STYLE_SOURCES = [
  "styles/foundation.css",
  "styles/map.css",
  "styles/intake.css",
  "styles/indexes.css",
  "styles/topics.css",
  "styles/overlays.css",
];
const APP_JS = [APP_BOOTSTRAP_IMPORT, APP_DIRECTORY_IMPORT, APP_INTAKE_IMPORT, APP_ACTIONS_IMPORT, APP_LIFECYCLE_IMPORT]
  .map((value) => value as unknown as string)
  .join("");
const STYLES_CSS = [
  STYLES_FOUNDATION_IMPORT,
  STYLES_MAP_IMPORT,
  STYLES_INTAKE_IMPORT,
  STYLES_INDEXES_IMPORT,
  STYLES_TOPICS_IMPORT,
  STYLES_OVERLAYS_IMPORT,
]
  .map((value) => value as unknown as string)
  .join("");
const MANIFEST = MANIFEST_IMPORT as unknown as string;
const SESSIONMAP_ICON = SESSIONMAP_ICON_IMPORT as unknown as string;
const BRAND_MARK = BRAND_MARK_IMPORT as unknown as string;
const MARKMAP_LIB_JS = MARKMAP_LIB_JS_IMPORT as unknown as string;
const ARCHIVE_SVG = ARCHIVE_SVG_IMPORT as unknown as string;
const CHECK_SVG = CHECK_SVG_IMPORT as unknown as string;
const CHEVRON_SVG = CHEVRON_SVG_IMPORT as unknown as string;
const ALERT_SVG = ALERT_SVG_IMPORT as unknown as string;
const CLOCK_SVG = CLOCK_SVG_IMPORT as unknown as string;
const CROSSHAIR_SVG = CROSSHAIR_SVG_IMPORT as unknown as string;
const GIT_SVG = GIT_SVG_IMPORT as unknown as string;
const LOCATE_LINEAGE_SVG = LOCATE_LINEAGE_SVG_IMPORT as unknown as string;
const MESSAGE_SVG = MESSAGE_SVG_IMPORT as unknown as string;
const MOON_SVG = MOON_SVG_IMPORT as unknown as string;
const SEND_SVG = SEND_SVG_IMPORT as unknown as string;
const TERMINAL_RESTORE_SVG = TERMINAL_RESTORE_SVG_IMPORT as unknown as string;
const TERMINAL_RETURN_SVG = TERMINAL_RETURN_SVG_IMPORT as unknown as string;
const X_SVG = X_SVG_IMPORT as unknown as string;
const ZOOM_SVG = ZOOM_SVG_IMPORT as unknown as string;

export type Asset = { body: string; contentType: string; source: string; parts?: readonly string[] };

const EMBEDDED: Record<string, Asset> = {
  "index.html": { body: INDEX_HTML, contentType: "text/html; charset=utf-8", source: "index.html" },
  "app.js": { body: APP_JS, contentType: "text/javascript; charset=utf-8", source: APP_SOURCES[0]!, parts: APP_SOURCES },
  "styles.css": { body: STYLES_CSS, contentType: "text/css; charset=utf-8", source: STYLE_SOURCES[0]!, parts: STYLE_SOURCES },
  "manifest.webmanifest": { body: MANIFEST, contentType: "application/manifest+json; charset=utf-8", source: "manifest.webmanifest" },
  "sessionmap-icon.svg": { body: SESSIONMAP_ICON, contentType: "image/svg+xml", source: "sessionmap-icon.svg" },
  "brand-mark.svg": { body: BRAND_MARK, contentType: "image/svg+xml", source: "brand-mark.svg" },
  "vendor/markmap-lib.js": { body: MARKMAP_LIB_JS, contentType: "text/javascript; charset=utf-8", source: "vendor/markmap-lib.js" },
  "vendor/icons/archive.svg": { body: ARCHIVE_SVG, contentType: "image/svg+xml", source: "vendor/icons/archive.svg" },
  "vendor/icons/check-circle-2.svg": { body: CHECK_SVG, contentType: "image/svg+xml", source: "vendor/icons/check-circle-2.svg" },
  "vendor/icons/chevron-down.svg": { body: CHEVRON_SVG, contentType: "image/svg+xml", source: "vendor/icons/chevron-down.svg" },
  "vendor/icons/circle-alert.svg": { body: ALERT_SVG, contentType: "image/svg+xml", source: "vendor/icons/circle-alert.svg" },
  "vendor/icons/clock-3.svg": { body: CLOCK_SVG, contentType: "image/svg+xml", source: "vendor/icons/clock-3.svg" },
  "vendor/icons/crosshair.svg": { body: CROSSHAIR_SVG, contentType: "image/svg+xml", source: "vendor/icons/crosshair.svg" },
  "vendor/icons/git-branch.svg": { body: GIT_SVG, contentType: "image/svg+xml", source: "vendor/icons/git-branch.svg" },
  "vendor/icons/locate-lineage.svg": { body: LOCATE_LINEAGE_SVG, contentType: "image/svg+xml", source: "vendor/icons/locate-lineage.svg" },
  "vendor/icons/message-circle.svg": { body: MESSAGE_SVG, contentType: "image/svg+xml", source: "vendor/icons/message-circle.svg" },
  "vendor/icons/moon.svg": { body: MOON_SVG, contentType: "image/svg+xml", source: "vendor/icons/moon.svg" },
  "vendor/icons/send.svg": { body: SEND_SVG, contentType: "image/svg+xml", source: "vendor/icons/send.svg" },
  "vendor/icons/terminal-restore.svg": { body: TERMINAL_RESTORE_SVG, contentType: "image/svg+xml", source: "vendor/icons/terminal-restore.svg" },
  "vendor/icons/terminal-return.svg": { body: TERMINAL_RETURN_SVG, contentType: "image/svg+xml", source: "vendor/icons/terminal-return.svg" },
  "vendor/icons/x.svg": { body: X_SVG, contentType: "image/svg+xml", source: "vendor/icons/x.svg" },
  "vendor/icons/zoom-in.svg": { body: ZOOM_SVG, contentType: "image/svg+xml", source: "vendor/icons/zoom-in.svg" },
};

const EMBEDDED_VERSION = (() => {
  const hash = createHash("sha256");
  for (const [name, asset] of Object.entries(EMBEDDED).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update("\0").update(asset.body).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
})();

export class AssetStore {
  readonly webRoot: string;
  readonly development: boolean;

  constructor() {
    this.webRoot = resolve(join(dirname(import.meta.path), "..", "..", "..", "packages", "web", "src"));
    this.development = process.env.SESSIONMAP_DEV === "1" && existsSync(join(this.webRoot, "index.html"));
  }

  get(name: string): Asset | null {
    const embedded = EMBEDDED[name];
    if (!embedded) return null;
    if (!this.development) return embedded;
    try {
      const root = realpathSync(this.webRoot);
      const candidates = (embedded.parts ?? [embedded.source]).map((source) => realpathSync(join(this.webRoot, source)));
      if (candidates.some((candidate) => candidate !== root && !candidate.startsWith(`${root}${sep}`))) return null;
      return { ...embedded, body: candidates.map((candidate) => readFileSync(candidate, "utf8")).join("") };
    } catch {
      return embedded;
    }
  }

  version(): string {
    if (this.development) {
      let latest = 0;
      for (const asset of Object.values(EMBEDDED)) {
        try {
          for (const source of asset.parts ?? [asset.source]) {
            latest = Math.max(latest, statSync(join(this.webRoot, source)).mtimeMs);
          }
        } catch {}
      }
      if (latest) return String(Math.floor(latest));
    }
    return EMBEDDED_VERSION;
  }
}
