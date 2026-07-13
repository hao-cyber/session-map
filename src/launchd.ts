import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runText } from "./monitor.ts";

export const LAUNCHD_LABEL = "io.maintrail.service";

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
  return join(homedir(), ".local", "bin", "maintrail");
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

export function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export async function installLaunchAgent(stateDirectory: string): Promise<string> {
  installCompiledExecutable();
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  rotateAtStartup(join(stateDirectory, "server.log"));
  const path = launchAgentPath();
  mkdirSync(dirname(path), { recursive: true });
  const next = launchdPlist(stateDirectory);
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (old !== next) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, next, { encoding: "utf8", mode: 0o644 });
    renameSync(temporary, path);
    chmodSync(path, 0o644);
  }
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await runText(["/bin/launchctl", "bootout", domain, path], 10_000);
  const loaded = await runText(["/bin/launchctl", "bootstrap", domain, path], 10_000);
  if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.text.trim()}`);
  return path;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  const path = launchAgentPath();
  if (!existsSync(path)) return false;
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await runText(["/bin/launchctl", "bootout", domain, path], 10_000);
  rmSync(path, { force: true });
  return true;
}
