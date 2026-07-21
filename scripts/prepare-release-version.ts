import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

export function nextBetaVersion(latestTag: string): string {
  const match = latestTag.match(BETA_TAG);
  if (!match) throw new Error(`latest release is not an incrementable beta tag: ${latestTag}`);
  const next = Number(match[4]) + 1;
  if (!Number.isSafeInteger(next)) throw new Error(`beta sequence is too large: ${latestTag}`);
  return `${match[1]}.${match[2]}.${match[3]}-beta.${next}`;
}

export function writePackageVersion(path: string, version: string): void {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (pkg.name !== "sessionmap" || typeof pkg.version !== "string") {
    throw new Error("root package.json does not contain the SessionMap product version");
  }
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

if (import.meta.main) {
  const latestTag = process.argv[2];
  if (!latestTag) throw new Error("usage: prepare-release-version.ts <latest-tag> [package.json]");
  const version = nextBetaVersion(latestTag);
  writePackageVersion(resolve(process.argv[3] ?? "package.json"), version);
  console.log(version);
}
