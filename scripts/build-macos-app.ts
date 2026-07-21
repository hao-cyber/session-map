import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
const output = resolve(process.env.SESSIONMAP_APP_OUT ?? resolve(root, "dist", "SessionMap.app"));
const source = resolve(root, "apps", "desktop", "src", "SessionMapApp.swift");
const infoTemplate = resolve(root, "apps", "desktop", "src", "Info.plist");
const iconSource = resolve(root, "apps", "web", "src", "sessionmap-icon.svg");
const contents = resolve(output, "Contents");
const macos = resolve(contents, "MacOS");
const resources = resolve(contents, "Resources");
const scratch = resolve(root, "dist", ".sessionmap-app-build");

function run(command: string[], quiet = false): void {
  const child = Bun.spawnSync(command, { stdin: "ignore", stdout: quiet ? "ignore" : "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new Error(`${basename(command[0] ?? "command")} failed (${child.exitCode})`);
}

rmSync(output, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
mkdirSync(scratch, { recursive: true });

const requested = (process.env.SESSIONMAP_APP_ARCHS || (process.arch === "arm64" ? "arm64" : "x86_64"))
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");
if (!requested.length) throw new Error("SESSIONMAP_APP_ARCHS must contain arm64 or x86_64");

const slices: string[] = [];
for (const architecture of requested) {
  const slice = resolve(scratch, `SessionMap-${architecture}`);
  run([
    "/usr/bin/swiftc",
    "-parse-as-library",
    "-target", `${architecture}-apple-macos13.0`,
    "-O",
    "-whole-module-optimization",
    "-framework", "AppKit",
    "-framework", "WebKit",
    source,
    "-o", slice,
  ]);
  slices.push(slice);
}
const executable = resolve(macos, "SessionMap");
if (slices.length === 1) copyFileSync(slices[0]!, executable);
else run(["/usr/bin/lipo", "-create", ...slices, "-output", executable]);
chmodSync(executable, 0o755);

const build = (process.env.GITHUB_RUN_NUMBER || "1").replaceAll(/[^0-9]/g, "") || "1";
const info = readFileSync(infoTemplate, "utf8")
  .replaceAll("__SESSIONMAP_VERSION__", pkg.version)
  .replaceAll("__SESSIONMAP_BUILD__", build);
writeFileSync(resolve(contents, "Info.plist"), info);
copyFileSync(resolve(root, "LICENSE"), resolve(resources, "LICENSE"));

const embeddedCli = process.env.SESSIONMAP_APP_CLI;
if (embeddedCli) {
  const bin = resolve(resources, "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(resolve(embeddedCli), resolve(bin, "sessionmap"));
  chmodSync(resolve(bin, "sessionmap"), 0o755);
}

const iconset = resolve(scratch, "SessionMap.iconset");
const master = resolve(scratch, "SessionMap-1024.png");
mkdirSync(iconset, { recursive: true });
run(["/usr/bin/sips", "-s", "format", "png", iconSource, "--out", master], true);
run(["/usr/bin/sips", "-z", "1024", "1024", master, "--out", master], true);
for (const [points, pixels] of [[16, 16], [16, 32], [32, 32], [32, 64], [128, 128], [128, 256], [256, 256], [256, 512], [512, 512], [512, 1024]] as const) {
  const suffix = pixels === points ? "" : "@2x";
  run(["/usr/bin/sips", "-z", String(pixels), String(pixels), master, "--out", resolve(iconset, `icon_${points}x${points}${suffix}.png`)], true);
}
run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", resolve(resources, "SessionMap.icns")]);

run(["/usr/bin/plutil", "-lint", resolve(contents, "Info.plist")]);
if (process.env.SESSIONMAP_APP_SKIP_SIGN !== "1") {
  run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", output]);
  run(["/usr/bin/codesign", "--verify", "--strict", "--deep", output]);
}
rmSync(scratch, { recursive: true, force: true });
console.log(`Built ${output} (${(directorySize(output) / 1024 / 1024).toFixed(1)} MiB)`);

function directorySize(path: string): number {
  const child = Bun.spawnSync(["/usr/bin/du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const value = Number(new TextDecoder().decode(child.stdout).trim().split(/\s+/, 1)[0]);
  if (Number.isFinite(value)) return value * 1024;
  return statSync(path).size;
}
