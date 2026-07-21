import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function parseChecksums(source: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of source.split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) checksums.set(match[2]!, match[1]!);
  }
  return checksums;
}

export function renderHomebrewFormula(version: string, checksums: Map<string, string>): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid release version: ${version}`);
  const armAsset = `sessionmap-${version}-darwin-arm64.tar.gz`;
  const intelAsset = `sessionmap-${version}-darwin-x86_64.tar.gz`;
  const armSha = checksums.get(armAsset);
  const intelSha = checksums.get(intelAsset);
  if (!armSha || !SHA256_PATTERN.test(armSha)) throw new Error(`missing checksum for ${armAsset}`);
  if (!intelSha || !SHA256_PATTERN.test(intelSha)) throw new Error(`missing checksum for ${intelAsset}`);
  const release = `https://github.com/hao-cyber/session-map/releases/download/v${version}`;
  return `class Sessionmap < Formula
  desc "Persistent thinking map for parallel AI coding agents"
  homepage "https://github.com/hao-cyber/session-map"
  license "MIT"

  depends_on macos: :ventura

  on_macos do
    on_arm do
      url "${release}/${armAsset}"
      sha256 "${armSha}"
    end

    on_intel do
      url "${release}/${intelAsset}"
      sha256 "${intelSha}"
    end
  end

  def install
    bin.install "sessionmap"
    pkgshare.install "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "third-party-licenses"
  end

  def caveats
    <<~EOS
      Install or repair the user service after installation or upgrade:
        sessionmap install

      Then open SessionMap with:
        sessionmap open
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/sessionmap --version")
  end
end
`;
}

function parseOptions(argv: string[]): { version: string; checksums: string; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("expected --version, --checksums, and --output");
    values.set(name, value);
  }
  const version = values.get("--version")?.replace(/^v/, "");
  const checksums = values.get("--checksums");
  const output = values.get("--output");
  if (!version || !checksums || !output) throw new Error("expected --version, --checksums, and --output");
  return { version, checksums: resolve(checksums), output: resolve(output) };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const checksums = parseChecksums(readFileSync(options.checksums, "utf8"));
  writeFileSync(options.output, renderHomebrewFormula(options.version, checksums));
  console.log(`Updated ${options.output} for v${options.version}.`);
}
