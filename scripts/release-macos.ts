import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

type Package = { version: string };
type Variant = {
  archiveArchitecture: "arm64" | "x64";
  swiftArchitecture: "arm64" | "x86_64";
};

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Package;
const release = join(root, "dist", "release");
const entitlements = join(root, "scripts", "macos-entitlements.plist");
const notarize = process.env.SESSIONMAP_NOTARIZE === "1";
const allowUnsigned = process.env.SESSIONMAP_ALLOW_UNSIGNED === "1";
const variants: Variant[] = [
  { archiveArchitecture: "arm64", swiftArchitecture: "arm64" },
  { archiveArchitecture: "x64", swiftArchitecture: "x86_64" },
];

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
  return stdout.trim();
}

function firstIdentity(list: string, kind: string): string | null {
  const row = list.split("\n").find((line) => line.includes(kind));
  return row?.match(/"([^"]+)"/)?.[1] ?? null;
}

async function zipApp(app: string, output: string): Promise<void> {
  rmSync(output, { force: true });
  await run([
    "/usr/bin/ditto", "-c", "-k", "--keepParent", "--sequesterRsrc",
    app,
    output,
  ]);
}

async function signApp(app: string, identity: string): Promise<void> {
  const backend = join(app, "Contents", "Resources", "bin", "sessionmap");
  await run([
    "/usr/bin/codesign", "--force", "--sign", identity,
    "--options", "runtime",
    "--entitlements", entitlements,
    "--timestamp",
    backend,
  ]);
  await run([
    "/usr/bin/codesign", "--force", "--sign", identity,
    "--options", "runtime",
    "--timestamp",
    app,
  ]);
}

async function buildVariant(variant: Variant, applicationIdentity: string | null): Promise<string> {
  const buildDirectory = join(release, `build-${variant.archiveArchitecture}`);
  await run([process.execPath, "run", join(root, "scripts", "build-macos-app.ts")], {
    SESSIONMAP_APP_ARCH: variant.swiftArchitecture,
    SESSIONMAP_APP_OUTDIR: buildDirectory,
    SESSIONMAP_ADHOC_SIGN: applicationIdentity ? "0" : "1",
  });
  const app = join(buildDirectory, "SessionMap.app");
  if (applicationIdentity) await signApp(app, applicationIdentity);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);

  if (notarize) {
    const profile = process.env.SESSIONMAP_NOTARY_PROFILE;
    if (!profile) throw new Error("SESSIONMAP_NOTARY_PROFILE is required when SESSIONMAP_NOTARIZE=1");
    const submission = join(release, `.notary-${variant.archiveArchitecture}.zip`);
    await zipApp(app, submission);
    await run([
      "/usr/bin/xcrun", "notarytool", "submit", submission,
      "--keychain-profile", profile,
      "--wait",
    ]);
    await run(["/usr/bin/xcrun", "stapler", "staple", app]);
    await run(["/usr/bin/xcrun", "stapler", "validate", app]);
    await run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", app]);
    rmSync(submission, { force: true });
  }

  const archive = join(
    release,
    `SessionMap-${pkg.version}-macOS-${variant.archiveArchitecture}.zip`,
  );
  await zipApp(app, archive);
  return archive;
}

function caskSource(armSha: string, intelSha: string): string {
  return `cask "sessionmap" do
  arch arm: "arm64", intel: "x64"

  version "${pkg.version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "https://github.com/hao-cyber/sessionmap/releases/download/v#{version}/SessionMap-#{version}-macOS-#{arch}.zip"
  name "SessionMap"
  desc "Persistent thinking map for parallel AI coding agents"
  homepage "https://github.com/hao-cyber/sessionmap"

  depends_on macos: :ventura

  app "SessionMap.app"
  binary "#{appdir}/SessionMap.app/Contents/Resources/bin/sessionmap"

  uninstall launchctl: "com.haocyber.sessionmap.service",
            quit:      "com.haocyber.sessionmap"

  zap trash: [
    "~/Library/Application Support/SessionMap",
    "~/Library/LaunchAgents/com.haocyber.sessionmap.service.plist",
  ]
end
`;
}

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const identities = await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
const applicationIdentity = process.env.APPLE_SIGNING_IDENTITY ||
  firstIdentity(identities, "Developer ID Application");
if (!applicationIdentity && !allowUnsigned) {
  throw new Error(
    "No Developer ID Application identity found. Install the certificate, set APPLE_SIGNING_IDENTITY, or explicitly set SESSIONMAP_ALLOW_UNSIGNED=1.",
  );
}
if (notarize && !applicationIdentity) {
  throw new Error("Developer ID signing is required before notarization");
}

const artifacts = await Promise.all(
  variants.map((variant) => buildVariant(variant, applicationIdentity)),
);
const digests = new Map<string, string>();
const checksumLines: string[] = [];
for (const artifact of artifacts) {
  const digest = (await run(["/usr/bin/shasum", "-a", "256", artifact])).split(/\s+/, 1)[0]!;
  digests.set(basename(artifact), digest);
  checksumLines.push(`${digest}  ${basename(artifact)}`);
}
writeFileSync(join(release, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

const armName = `SessionMap-${pkg.version}-macOS-arm64.zip`;
const intelName = `SessionMap-${pkg.version}-macOS-x64.zip`;
writeFileSync(
  join(release, "sessionmap.rb"),
  caskSource(digests.get(armName)!, digests.get(intelName)!),
);

console.log(`Release artifacts:\n${artifacts.map((item) => `- ${item}`).join("\n")}`);
console.log(`- ${join(release, "SHA256SUMS")}`);
console.log(`- ${join(release, "sessionmap.rb")}`);
