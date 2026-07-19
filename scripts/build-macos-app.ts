import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Package = { version: string };
const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Package;
const requestedArchitecture = process.env.SESSIONMAP_APP_ARCH ?? (process.arch === "arm64" ? "arm64" : "x86_64");
const architecture = requestedArchitecture === "x64" ? "x86_64" : requestedArchitecture;
if (architecture !== "arm64" && architecture !== "x86_64") {
  throw new Error(`Unsupported macOS architecture: ${architecture}`);
}

const outputRoot = resolve(process.env.SESSIONMAP_APP_OUTDIR ?? join(root, "dist"));
const app = join(outputRoot, "SessionMap.app");
const contents = join(app, "Contents");
const macOS = join(contents, "MacOS");
const resources = join(contents, "Resources");
const backendDirectory = join(resources, "bin");
const scratch = join(root, "dist", `swift-${architecture}`);
const generated = join(root, "dist", `app-assets-${architecture}`);
const backend = resolve(process.env.SESSIONMAP_BACKEND_PATH ?? join(root, "dist", `sessionmap-${architecture}`));

async function run(command: string[], env?: Record<string, string>): Promise<string> {
  const processResult = Bun.spawn(command, {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${stderr || stdout}`);
  return stdout.trim();
}

async function buildBackend(): Promise<void> {
  if (process.env.SESSIONMAP_BACKEND_PATH) return;
  const target = architecture === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
  await run([process.execPath, "run", join(root, "scripts", "build.ts")], {
    SESSIONMAP_TARGET: target,
    SESSIONMAP_OUTFILE: backend,
  });
}

async function buildNativeExecutable(): Promise<string> {
  const common = [
    "/usr/bin/swift", "build",
    "--package-path", join(root, "native"),
    "--configuration", "release",
    "--arch", architecture,
    "--scratch-path", scratch,
  ];
  await run(common);
  const binPath = await run([...common, "--show-bin-path"]);
  return join(binPath, "SessionMap");
}

async function buildIcon(): Promise<string> {
  const iconset = join(generated, "SessionMap.iconset");
  const master = join(generated, "SessionMap-1024.png");
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  await run([
    "/usr/bin/sips", "-s", "format", "png",
    join(root, "native", "Resources", "AppIcon.svg"),
    "--out", master,
  ]);
  const variants = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ] as const;
  for (const [name, size] of variants) {
    await run(["/usr/bin/sips", "-z", String(size), String(size), master, "--out", join(iconset, name)]);
  }
  const icon = join(generated, "SessionMap.icns");
  await run(["/usr/bin/iconutil", "--convert", "icns", "--output", icon, iconset]);
  return icon;
}

await buildBackend();
const [nativeExecutable, icon] = await Promise.all([buildNativeExecutable(), buildIcon()]);

rmSync(app, { recursive: true, force: true });
mkdirSync(macOS, { recursive: true });
mkdirSync(backendDirectory, { recursive: true });
copyFileSync(nativeExecutable, join(macOS, "SessionMap"));
chmodSync(join(macOS, "SessionMap"), 0o755);
copyFileSync(backend, join(backendDirectory, "sessionmap"));
chmodSync(join(backendDirectory, "sessionmap"), 0o755);
copyFileSync(icon, join(resources, "SessionMap.icns"));
copyFileSync(join(root, "LICENSE"), join(resources, "LICENSE"));

const buildNumber = process.env.SESSIONMAP_BUILD_NUMBER ?? "1";
const info = readFileSync(join(root, "native", "Info.plist"), "utf8")
  .replaceAll("__SESSIONMAP_VERSION__", pkg.version)
  .replaceAll("__SESSIONMAP_BUILD__", buildNumber);
writeFileSync(join(contents, "Info.plist"), info, "utf8");
await run(["/usr/bin/plutil", "-lint", join(contents, "Info.plist")]);

if (process.env.SESSIONMAP_ADHOC_SIGN !== "0") {
  await run([
    "/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime",
    "--entitlements", join(root, "scripts", "macos-entitlements.plist"),
    join(backendDirectory, "sessionmap"),
  ]);
  await run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", app]);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
}

const appSize = Number((await run(["/usr/bin/du", "-sk", app])).split(/\s+/, 1)[0] ?? 0) / 1024;
console.log(`Built ${app} for ${architecture} (${appSize.toFixed(1)} MiB)`);
console.log(`Native executable: ${basename(nativeExecutable)} (${(statSync(nativeExecutable).size / 1024 / 1024).toFixed(1)} MiB)`);
console.log(`Backend executable: ${basename(backend)} (${(statSync(backend).size / 1024 / 1024).toFixed(1)} MiB)`);
