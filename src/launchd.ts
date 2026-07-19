import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrateLegacyState } from "./migration.ts";
import { runText } from "./monitor.ts";
import { defaultStateDirectory, legacyStateDirectory, sleep } from "./utils.ts";

export const LAUNCHD_LABEL = "com.haocyber.sessionmap.service";
export const LEGACY_LAUNCHD_LABEL = "io.maintrail.service";
export const SERVICE_START_TIMEOUT_MS = 30_000;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringArray(values: string[]): string {
  return `<array>${values.map((value) => `<string>${xml(value)}</string>`).join("")}</array>`;
}

function isBunExecutable(executable: string): boolean {
  return executable.endsWith("/bun") || executable.endsWith("/bun-debug");
}

export function installedExecutablePath(): string {
  return join(homedir(), ".local", "bin", "sessionmap");
}

export function launchArguments(stateDirectory: string, executable = process.execPath): string[] {
  if (executable.endsWith("/bun") || executable.endsWith("/bun-debug")) {
    return [executable, resolve(import.meta.dir, "cli.ts"), "serve", "--no-open", "--state-dir", stateDirectory];
  }
  return [installedExecutablePath(), "serve", "--no-open", "--state-dir", stateDirectory];
}

function installCompiledExecutable(): void {
  if (isBunExecutable(process.execPath)) return;
  const destination = installedExecutablePath();
  if (resolve(process.execPath) === resolve(destination)) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(process.execPath, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, destination);
}

export function launchdPlist(stateDirectory: string): string {
  const home = homedir();
  const path = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, "bin"),
    join(home, ".grok", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>${stringArray(launchArguments(stateDirectory))}
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(home)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(join(stateDirectory, "server.log"))}</string>
</dict></plist>
`;
}

function rotateAtStartup(path: string): void {
  try {
    if (statSync(path).size > 10 * 1024 * 1024) renameSync(path, `${path}.1`);
  } catch {}
}

export function launchAgentPath(label = LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

async function waitForService(timeoutMs = SERVICE_START_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4317/health", { signal: AbortSignal.timeout(750) });
      if (response.ok && (await response.json() as { name?: string }).name === "SessionMap") return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

export async function installLaunchAgent(stateDirectory: string): Promise<string> {
  installCompiledExecutable();
  const path = launchAgentPath();
  const legacyPath = launchAgentPath(LEGACY_LAUNCHD_LABEL);
  const legacyInstalled = existsSync(legacyPath);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const previousPlist = existsSync(path) ? readFileSync(path, "utf8") : null;
  let migration: { migrated: boolean } = { migrated: false };
  try {
    // Freeze the legacy writer before copying its append-only offsets and
    // tree. Every following migration/install step lives inside this rollback
    // boundary so even malformed legacy JSON cannot leave the old service off.
    if (legacyInstalled) await runText(["/bin/launchctl", "bootout", domain, legacyPath], 10_000);

    const shouldMigrate = resolve(stateDirectory) === defaultStateDirectory();
    migration = shouldMigrate
      ? migrateLegacyState(legacyStateDirectory(), stateDirectory)
      : { migrated: false };
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    rotateAtStartup(join(stateDirectory, "server.log"));
    mkdirSync(dirname(path), { recursive: true });
    const next = launchdPlist(stateDirectory);
    if (previousPlist !== next) {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, next, { encoding: "utf8", mode: 0o644 });
      renameSync(temporary, path);
      chmodSync(path, 0o644);
    }
    await runText(["/bin/launchctl", "bootout", domain, path], 10_000);
    const loaded = await runText(["/bin/launchctl", "bootstrap", domain, path], 10_000);
    if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.text.trim()}`);
    if (!await waitForService()) throw new Error("SessionMap service did not become healthy");
  } catch (error) {
    await runText(["/bin/launchctl", "bootout", domain, path], 10_000);
    if (migration.migrated) rmSync(stateDirectory, { recursive: true, force: true });
    try {
      if (previousPlist === null) rmSync(path, { force: true });
      else {
        const rollback = `${path}.${process.pid}.rollback`;
        writeFileSync(rollback, previousPlist, { encoding: "utf8", mode: 0o644 });
        renameSync(rollback, path);
        chmodSync(path, 0o644);
      }
    } catch {}
    if (legacyInstalled) await runText(["/bin/launchctl", "bootstrap", domain, legacyPath], 10_000);
    throw error;
  }
  if (legacyInstalled) rmSync(legacyPath, { force: true });
  rmSync(join(homedir(), ".local", "bin", "maintrail"), { force: true });
  return path;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  let removed = false;
  for (const path of [launchAgentPath(), launchAgentPath(LEGACY_LAUNCHD_LABEL)]) {
    if (!existsSync(path)) continue;
    await runText(["/bin/launchctl", "bootout", domain, path], 10_000);
    rmSync(path, { force: true });
    removed = true;
  }
  return removed;
}
