import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const cli = resolve(import.meta.dir, "..", "apps", "runtime", "src", "cli.ts");

async function run(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([Bun.which("bun") || "bun", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI help", () => {
  test("prints useful guidance instead of starting a service when no command is given", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Getting started:");
    expect(result.stdout).toContain("sessionmap install");
    expect(result.stdout).toContain("sessionmap open");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("no analytics or telemetry");
    expect(result.stdout).not.toContain("SessionMap is available at");
  });

  test("keeps --help as the same explicit entry", async () => {
    const result = await run("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sessionmap                Show this help");
  });
});
