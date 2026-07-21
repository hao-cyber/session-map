import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "8.30.1";
const artifacts = {
  arm64: {
    name: `gitleaks_${version}_darwin_arm64.tar.gz`,
    sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  },
  x64: {
    name: `gitleaks_${version}_darwin_x64.tar.gz`,
    sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  },
} as const;

if (process.platform !== "darwin" || !(process.arch in artifacts)) {
  throw new Error(`Gitleaks check supports macOS arm64/x64, received ${process.platform}/${process.arch}`);
}

const artifact = artifacts[process.arch as keyof typeof artifacts];
const scratch = mkdtempSync(join(tmpdir(), "sessionmap-gitleaks-"));

try {
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/${artifact.name}`);
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  const actualHash = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(`Gitleaks archive checksum mismatch: expected ${artifact.sha256}, received ${actualHash}`);
  }

  const archive = join(scratch, artifact.name);
  await Bun.write(archive, archiveBytes);
  const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", scratch], { stdout: "inherit", stderr: "inherit" });
  if (extracted.exitCode !== 0) throw new Error(`Gitleaks extraction failed (${extracted.exitCode})`);

  const binary = join(scratch, "gitleaks");
  chmodSync(binary, 0o755);
  const scan = Bun.spawnSync([
    binary,
    "git",
    "--redact",
    "--no-banner",
    "--verbose",
    "--log-opts=--all",
    ".",
  ], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (scan.exitCode !== 0) throw new Error(`Gitleaks found a secret or failed (${scan.exitCode})`);
  console.log(`Gitleaks ${version} passed for all reachable Git history.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
