import { readFileSync } from "node:fs";

const decoder = new TextDecoder();
const allowedUserSegments = new Set(["$CONSOLE_USER", "a", "example", "runner", "Shared"]);
const historyCandidatePattern = [
  "/Users/",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
  "sk-[A-Za-z0-9_-]{32,}",
].join("|");

function isForbiddenPath(path: string): boolean {
  return /(^|\/)(artifacts|screenshots|\.sessionmap|\.maintrail)(\/|$)/.test(path)
    || /(^|\/)state\.json$/.test(path)
    || /(^|\/)capability\.token$/.test(path);
}

function inspectText(label: string, source: string, findings: string[]): void {
  for (const match of source.matchAll(/\/Users\/([^/\s"'<>]+)/g)) {
    const segment = match[1];
    if (segment && !allowedUserSegments.has(segment)) {
      findings.push(`${label}: contains a concrete macOS home path`);
    }
  }
  if (/AKIA[0-9A-Z]{16}/.test(source)) findings.push(`${label}: contains an AWS access key-shaped value`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) findings.push(`${label}: contains a private key block`);
  if (/\bsk-[A-Za-z0-9_-]{32,}\b/.test(source)) findings.push(`${label}: contains an API key-shaped value`);
}

const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "pipe" });
if (listed.exitCode !== 0) throw new Error(decoder.decode(listed.stderr).trim() || "git ls-files failed");

const paths = decoder.decode(listed.stdout).split("\0").filter(Boolean);
const forbiddenPaths = paths.filter(isForbiddenPath);
const findings: string[] = forbiddenPaths.map((path) => `${path}: private runtime or capture path is tracked`);

for (const path of paths) {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  inspectText(path, decoder.decode(bytes), findings);
}

const revisions = Bun.spawnSync(["git", "rev-list", "--all"], { stdout: "pipe", stderr: "pipe" });
if (revisions.exitCode !== 0) throw new Error(decoder.decode(revisions.stderr).trim() || "git rev-list failed");
const commits = decoder.decode(revisions.stdout).trim().split("\n").filter(Boolean);

for (const commit of commits) {
  const tree = Bun.spawnSync(["git", "ls-tree", "-r", "-z", "--name-only", commit], { stdout: "pipe", stderr: "pipe" });
  if (tree.exitCode !== 0) throw new Error(decoder.decode(tree.stderr).trim() || `git ls-tree failed for ${commit}`);
  for (const path of decoder.decode(tree.stdout).split("\0").filter(Boolean)) {
    if (isForbiddenPath(path)) findings.push(`${commit.slice(0, 12)}:${path}: private runtime or capture path exists in Git history`);
  }

  const matched = Bun.spawnSync(["git", "grep", "-I", "-l", "-E", historyCandidatePattern, commit, "--"], { stdout: "pipe", stderr: "pipe" });
  if (matched.exitCode !== 0 && matched.exitCode !== 1) {
    throw new Error(decoder.decode(matched.stderr).trim() || `git grep failed for ${commit}`);
  }
  for (const entry of decoder.decode(matched.stdout).trim().split("\n").filter(Boolean)) {
    const prefix = `${commit}:`;
    const path = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
    const shown = Bun.spawnSync(["git", "show", `${commit}:${path}`], { stdout: "pipe", stderr: "pipe" });
    if (shown.exitCode !== 0) throw new Error(decoder.decode(shown.stderr).trim() || `git show failed for ${commit}:${path}`);
    inspectText(`${commit.slice(0, 12)}:${path}`, decoder.decode(shown.stdout), findings);
  }
}

if (findings.length) throw new Error(`Privacy check failed:\n${[...new Set(findings)].map((item) => `- ${item}`).join("\n")}`);
console.log(`Privacy check passed for ${paths.length} tracked or candidate files across ${commits.length} reachable commits.`);
