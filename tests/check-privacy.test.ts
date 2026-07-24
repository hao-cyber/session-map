import { describe, expect, test } from "bun:test";
import { inspectText, isForbiddenPath } from "../scripts/check-privacy.ts";

describe("isForbiddenPath", () => {
  test("blocks runtime state and capture directories", () => {
    expect(isForbiddenPath("state.json")).toBe(true);
    expect(isForbiddenPath("capability.token")).toBe(true);
    expect(isForbiddenPath("artifacts/ui/desktop.png")).toBe(true);
    expect(isForbiddenPath("screenshots/standalone-web.png")).toBe(true);
    expect(isForbiddenPath(".sessionmap/state.json")).toBe(true);
    expect(isForbiddenPath(".maintrail/capability.token")).toBe(true);
    expect(isForbiddenPath("credentials/signing.p12")).toBe(true);
    expect(isForbiddenPath("fixtures/session.jsonl")).toBe(true);
    expect(isForbiddenPath("cache/state.sqlite")).toBe(true);
    expect(isForbiddenPath(".env")).toBe(true);
  });

  test("blocks local UI baseline captures that look like runtime paths", () => {
    expect(isForbiddenPath(".sessionmap-ui-baseline.png")).toBe(true);
    expect(isForbiddenPath(".sessionmap-ui-baseline.jpg")).toBe(true);
    expect(isForbiddenPath(".maintrail-demo-capture.png")).toBe(true);
    expect(isForbiddenPath("web/.sessionmap-ui-baseline.png")).toBe(true);
    expect(isForbiddenPath("tmp/ui-baseline.png")).toBe(true);
    expect(isForbiddenPath("docs/assets/reading-hierarchy-baseline.webp")).toBe(true);
  });

  test("allows ordinary source, docs, and curated product assets", () => {
    expect(isForbiddenPath("packages/core/src/state-store.ts")).toBe(false);
    expect(isForbiddenPath("docs/modules/migration-release.md")).toBe(false);
    expect(isForbiddenPath("packages/web/src/sessionmap-icon.svg")).toBe(false);
    expect(isForbiddenPath("docs/assets/maintrail-overview.png")).toBe(false);
    expect(isForbiddenPath("package.json")).toBe(false);
    expect(isForbiddenPath(".env.example")).toBe(false);
  });
});

describe("inspectText", () => {
  test("detects provider and generic credential shapes", () => {
    const githubToken = ["ghp_", "A".repeat(36)].join("");
    const bearerToken = ["Bearer ", "b".repeat(32)].join("");
    const connectionString = ["postgres://", "user", ":", "password", "@db.example.test/app"].join("");
    const findings = inspectText("fixture", [githubToken, bearerToken, connectionString].join("\n"));

    expect(findings).toContain("fixture: contains a GitHub token-shaped value");
    expect(findings).toContain("fixture: contains an authorization credential-shaped value");
    expect(findings).toContain("fixture: contains a credential-bearing connection string");
  });

  test("allows placeholders and public connection strings without credentials", () => {
    expect(inspectText("fixture", "Bearer $TOKEN\npostgres://localhost/app\n/Users/example/project")).toEqual([]);
  });
});
