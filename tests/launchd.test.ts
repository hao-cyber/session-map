import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  installLaunchAgent,
  LAUNCHD_LABEL,
  LEGACY_LAUNCHD_LABEL,
  SERVICE_START_TIMEOUT_MS,
  installedExecutablePath,
  launchAgentPath,
  launchArguments,
  launchdPlist,
} from "@sessionmap/runtime/launchd.ts";
import { createEmptyState } from "@sessionmap/core/state-repair.ts";
import { defaultStateDirectory, legacyStateDirectory } from "@sessionmap/core/utils.ts";
import { cleanup, temporaryDirectory } from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

function legacyFixture(): { root: string; home: string; current: string; legacy: string; executable: string } {
  const root = temporaryDirectory("sessionmap-launchd-");
  roots.push(root);
  const home = join(root, "home");
  const current = defaultStateDirectory(home);
  const legacy = legacyStateDirectory(home);
  const executable = join(root, "sessionmap-next");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(legacy, "state.json"), JSON.stringify(createEmptyState("codex")), { mode: 0o600 });
  writeFileSync(launchAgentPath(LEGACY_LAUNCHD_LABEL, home), "legacy plist");
  writeFileSync(join(home, ".local", "bin", "maintrail"), "legacy binary");
  writeFileSync(executable, "new binary", { mode: 0o755 });
  return { root, home, current, legacy, executable };
}

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
    expect(SERVICE_START_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  test("publishes a healthy migrated service before cleaning legacy entry points", async () => {
    const fixture = legacyFixture();
    const commands: string[][] = [];
    const path = await installLaunchAgent(fixture.current, {
      homeDirectory: fixture.home,
      executable: fixture.executable,
      userId: 123,
      runCommand: async (command) => {
        commands.push(command);
        return { ok: true, text: "" };
      },
      waitForHealthy: async () => true,
    });

    expect(path).toBe(launchAgentPath(LAUNCHD_LABEL, fixture.home));
    expect(existsSync(join(fixture.current, "state.json"))).toBeTrue();
    expect(existsSync(join(fixture.legacy, "state.json"))).toBeTrue();
    expect(existsSync(launchAgentPath(LEGACY_LAUNCHD_LABEL, fixture.home))).toBeFalse();
    expect(existsSync(join(fixture.home, ".local", "bin", "maintrail"))).toBeFalse();
    expect(readFileSync(installedExecutablePath(fixture.home), "utf8")).toBe("new binary");
    expect(commands.some((command) => command[1] === "bootout" && command.at(-1)?.includes(LEGACY_LAUNCHD_LABEL))).toBeTrue();
    expect(commands.some((command) => command[1] === "bootstrap" && command.at(-1) === path)).toBeTrue();
  });

  test("restores state, plist, binary, and previous service when health fails", async () => {
    const fixture = legacyFixture();
    const path = launchAgentPath(LAUNCHD_LABEL, fixture.home);
    const previousPlist = "previous SessionMap plist";
    writeFileSync(path, previousPlist);
    writeFileSync(installedExecutablePath(fixture.home), "old binary", { mode: 0o755 });
    const commands: string[][] = [];

    await expect(installLaunchAgent(fixture.current, {
      homeDirectory: fixture.home,
      executable: fixture.executable,
      userId: 123,
      runCommand: async (command) => {
        commands.push(command);
        return { ok: true, text: "" };
      },
      waitForHealthy: async () => false,
    })).rejects.toThrow("did not become healthy");

    expect(existsSync(fixture.current)).toBeFalse();
    expect(existsSync(join(fixture.legacy, "state.json"))).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe(previousPlist);
    expect(readFileSync(installedExecutablePath(fixture.home), "utf8")).toBe("old binary");
    expect(existsSync(launchAgentPath(LEGACY_LAUNCHD_LABEL, fixture.home))).toBeTrue();
    expect(existsSync(join(fixture.home, ".local", "bin", "maintrail"))).toBeTrue();
    const bootstraps = commands.filter((command) => command[1] === "bootstrap");
    expect(bootstraps.at(-1)?.at(-1)).toBe(path);
  });

  test("aborts before migration when the legacy writer cannot be frozen", async () => {
    const fixture = legacyFixture();
    await expect(installLaunchAgent(fixture.current, {
      homeDirectory: fixture.home,
      executable: fixture.executable,
      userId: 123,
      runCommand: async (command) => command.at(-1)?.includes(LEGACY_LAUNCHD_LABEL) && command[1] === "bootout"
        ? { ok: false, text: "permission denied" }
        : { ok: true, text: "" },
      waitForHealthy: async () => true,
    })).rejects.toThrow("could not freeze legacy Maintrail writer");

    expect(existsSync(fixture.current)).toBeFalse();
    expect(existsSync(join(fixture.legacy, "state.json"))).toBeTrue();
    expect(existsSync(launchAgentPath(LEGACY_LAUNCHD_LABEL, fixture.home))).toBeTrue();
  });

  test("removes a state directory created by a failed fresh install", async () => {
    const fixture = legacyFixture();
    rmSync(launchAgentPath(LEGACY_LAUNCHD_LABEL, fixture.home));
    await expect(installLaunchAgent(fixture.current, {
      homeDirectory: fixture.home,
      executable: fixture.executable,
      userId: 123,
      runCommand: async () => ({ ok: true, text: "" }),
      waitForHealthy: async () => false,
    })).rejects.toThrow("did not become healthy");
    expect(existsSync(fixture.current)).toBeFalse();
  });

});
