import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

type Package = { version: string };
const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Package;
const release = join(root, "dist", "release");
const entitlements = join(root, "scripts", "macos-entitlements.plist");

async function run(command: string[], env?: Record<string, string>): Promise<string> {
  const processResult = Bun.spawn(command, {
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${stderr || stdout}`);
  return stdout;
}

function firstIdentity(list: string, kind: string): string | null {
  const row = list.split("\n").find((line) => line.includes(kind));
  return row?.match(/"([^"]+)"/)?.[1] ?? null;
}

async function build(target: string, output: string): Promise<void> {
  await run([process.execPath, "run", join(root, "scripts", "build.ts")], {
    MAINTRAIL_TARGET: target,
    MAINTRAIL_OUTFILE: output,
  });
}

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
const arm = join(release, "arm64", "maintrail");
const intel = join(release, "x64", "maintrail");
await Promise.all([
  build("bun-darwin-arm64", arm),
  build("bun-darwin-x64", intel),
]);

const identities = await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
const applicationIdentity = process.env.APPLE_SIGNING_IDENTITY || firstIdentity(identities, "Developer ID Application");
const allowUnsigned = process.env.MAINTRAIL_ALLOW_UNSIGNED === "1";
if (!applicationIdentity && !allowUnsigned) {
  throw new Error("No Developer ID Application identity found. Install the certificate, set APPLE_SIGNING_IDENTITY, or explicitly set MAINTRAIL_ALLOW_UNSIGNED=1.");
}
const installerIdentity = process.env.APPLE_INSTALLER_IDENTITY || firstIdentity(identities, "Developer ID Installer");
const variants = [
  { architecture: "arm64", executable: arm },
  { architecture: "x64", executable: intel },
];
const artifacts: string[] = [];

for (const variant of variants) {
  chmodSync(variant.executable, 0o755);
  if (applicationIdentity) {
    await run([
      "/usr/bin/codesign",
      "--force",
      "--sign", applicationIdentity,
      "--options", "runtime",
      "--entitlements", entitlements,
      "--timestamp",
      variant.executable,
    ]);
    await run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", variant.executable]);
  }
  const zip = join(release, `maintrail-${pkg.version}-macos-${variant.architecture}.zip`);
  // Flatten to one predictable `maintrail` entry; the Mach-O code signature is
  // internal and does not depend on Finder metadata or AppleDouble files.
  await run(["/usr/bin/zip", "-q", "-X", "-j", zip, variant.executable]);
  artifacts.push(zip);

  if (applicationIdentity && installerIdentity) {
    const packageRoot = join(release, `pkg-root-${variant.architecture}`);
    const binDirectory = join(packageRoot, "usr", "local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    copyFileSync(variant.executable, join(binDirectory, "maintrail"));
    chmodSync(join(binDirectory, "maintrail"), 0o755);
    const componentPkg = join(release, `Maintrail-${pkg.version}-macos-${variant.architecture}.pkg`);
    await run([
      "/usr/bin/pkgbuild",
      "--root", packageRoot,
      "--identifier", "io.maintrail.cli",
      "--version", pkg.version,
      "--install-location", "/",
      "--sign", installerIdentity,
      componentPkg,
    ]);
    artifacts.push(componentPkg);
  }
}

if (process.env.MAINTRAIL_NOTARIZE === "1") {
  const profile = process.env.MAINTRAIL_NOTARY_PROFILE;
  if (!profile) throw new Error("MAINTRAIL_NOTARY_PROFILE is required when MAINTRAIL_NOTARIZE=1");
  for (const artifact of artifacts) {
    await run(["/usr/bin/xcrun", "notarytool", "submit", artifact, "--keychain-profile", profile, "--wait"]);
    if (artifact.endsWith(".pkg")) {
      await run(["/usr/bin/xcrun", "stapler", "staple", artifact]);
      await run(["/usr/sbin/spctl", "--assess", "--type", "install", "--verbose=2", artifact]);
    }
  }
}

const checksums: string[] = [];
for (const artifact of artifacts) {
  const digest = (await run(["/usr/bin/shasum", "-a", "256", artifact])).trim().split(/\s+/)[0];
  checksums.push(`${digest}  ${basename(artifact)}`);
}
writeFileSync(join(release, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`Release artifacts:\n${artifacts.map((item) => `- ${item}`).join("\n")}`);
