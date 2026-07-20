import { readFileSync } from "node:fs";

const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "pipe" });
if (listed.exitCode !== 0) throw new Error(new TextDecoder().decode(listed.stderr).trim() || "git ls-files failed");

const paths = new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);
const forbiddenPaths = paths.filter((path) =>
  /(^|\/)(artifacts|screenshots|\.sessionmap|\.maintrail)(\/|$)/.test(path)
  || /(^|\/)state\.json$/.test(path)
);
const findings: string[] = forbiddenPaths.map((path) => `${path}: private runtime or capture path is tracked`);
const allowedUserSegments = new Set(["$CONSOLE_USER", "a", "example", "runner", "Shared"]);

for (const path of paths) {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  const source = new TextDecoder().decode(bytes);
  for (const match of source.matchAll(/\/Users\/([^/\s"'<>]+)/g)) {
    const segment = match[1];
    if (segment && !allowedUserSegments.has(segment)) {
      findings.push(`${path}: contains a concrete macOS home path (` + "/Users/" + `${segment})`);
    }
  }
  if (/AKIA[0-9A-Z]{16}/.test(source)) findings.push(`${path}: contains an AWS access key-shaped value`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) findings.push(`${path}: contains a private key block`);
  if (/\bsk-[A-Za-z0-9_-]{32,}\b/.test(source)) findings.push(`${path}: contains an API key-shaped value`);
}

if (findings.length) throw new Error(`Privacy check failed:\n${[...new Set(findings)].map((item) => `- ${item}`).join("\n")}`);
console.log(`Privacy check passed for ${paths.length} tracked or candidate repository files.`);
