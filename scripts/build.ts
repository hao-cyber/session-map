import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
const target = process.env.SESSIONMAP_TARGET;
const output = resolve(process.env.SESSIONMAP_OUTFILE ?? resolve(import.meta.dir, "..", "dist", "sessionmap"));

mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });

const command = [
  process.execPath,
  "build",
  resolve(import.meta.dir, "..", "apps", "cli", "src", "cli.ts"),
  "--compile",
  "--minify",
  `--outfile=${output}`,
  `--define=__SESSIONMAP_VERSION__=${JSON.stringify(pkg.version)}`,
];
if (target) command.push(`--target=${target}`);

const processResult = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await processResult.exited;
if (exitCode !== 0) process.exit(exitCode);
chmodSync(output, 0o755);

const smoke = Bun.spawn([output, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, smokeCode] = await Promise.all([
  new Response(smoke.stdout).text(),
  new Response(smoke.stderr).text(),
  smoke.exited,
]);
if (smokeCode !== 0 || stdout.trim() !== pkg.version) {
  throw new Error(`compiled executable smoke test failed: ${stderr || stdout}`);
}
console.log(`Built ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MiB)`);
