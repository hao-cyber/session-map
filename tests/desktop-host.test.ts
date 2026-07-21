import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("stateless macOS map host", () => {
  test("loads only the loopback map and delegates lifecycle to the CLI", () => {
    const source = readFileSync(resolve(root, "apps/desktop/src/SessionMapApp.swift"), "utf8");
    expect(source).toContain('URL(string: "http://127.0.0.1:4317/")');
    expect(source).toContain('candidates.append((NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/sessionmap"))');
    expect(source).toContain('let installed = self.run(cli, ["install"])');
    expect(source).toContain("application.delegate = delegate");
    expect(source).toContain("application.run()");
    expect(source).toContain('url.host == "127.0.0.1"');
    expect(source).toContain("NSWorkspace.shared.open(url)");
    expect(source).not.toContain("state.json");
    expect(source).not.toContain("capability.token");
    expect(source).not.toContain("WKScriptMessageHandler");
    expect(source).not.toContain("evaluateJavaScript");
  });

  test("packages one thin App beside the single CLI service", () => {
    const postinstall = readFileSync(resolve(root, "scripts/macos/postinstall"), "utf8");
    const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    const info = readFileSync(resolve(root, "apps/desktop/src/Info.plist"), "utf8");
    expect(postinstall.indexOf('"$SYSTEM_BINARY" install')).toBeLessThan(postinstall.indexOf('open "/Applications/SessionMap.app"'));
    expect(release).toContain('ditto "dist/SessionMap.app" "$PACKAGE_ROOT/Applications/SessionMap.app"');
    expect(release).toContain("SESSIONMAP_APP_ARCHS=arm64,x86_64");
    expect(info).toContain("<key>LSMultipleInstancesProhibited</key><true/>");
    expect(info).toContain("<key>NSAllowsLocalNetworking</key><true/>");
  });
});
