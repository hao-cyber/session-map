import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL, installedExecutablePath, launchArguments, launchdPlist } from "../src/launchd.ts";

describe("launchd distribution", () => {
  test("uses source files under Bun but a stable user bin for compiled releases", () => {
    const source = launchArguments("/tmp/state", "/opt/bun/bin/bun");
    expect(source[0]).toBe("/opt/bun/bin/bun");
    expect(source[1]).toEndWith("/src/cli.ts");
    expect(launchArguments("/tmp/state", "/Volumes/Downloads/sessionmap")[0]).toBe(
      join(homedir(), ".local", "bin", "sessionmap"),
    );
    expect(installedExecutablePath()).toBe(join(homedir(), ".local", "bin", "sessionmap"));
  });

  test("emits a persistent private-state service with the CLI search path", () => {
    const plist = launchdPlist("/tmp/state & map");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("/tmp/state &amp; map");
    expect(plist).not.toContain("/tmp/state & map</string>");
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(LAUNCHD_LABEL).toBe("com.haocyber.sessionmap.service");
    expect(LEGACY_LAUNCHD_LABEL).toBe("io.maintrail.service");
  });

  test("generates a Homebrew 6 compatible minimum macOS dependency", () => {
    const releaseScript = readFileSync(new URL("../scripts/release-macos.ts", import.meta.url), "utf8");
    expect(releaseScript).toContain("depends_on macos: :ventura");
    expect(releaseScript).not.toContain('depends_on macos: \">= :ventura\"');
    expect(releaseScript).not.toContain('"io.maintrail.service"');
  });
});
