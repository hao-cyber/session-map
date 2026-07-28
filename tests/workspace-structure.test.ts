import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

function sourceFiles(directory: string): string[] {
  const absolute = resolve(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourceFiles(relative);
    return /\.(?:ts|js|swift|html|css)$/.test(entry.name) ? [relative] : [];
  });
}

function imports(path: string): string[] {
  const source = readFileSync(resolve(root, path), "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map(
    (match) => match[2]!,
  );
}

describe("private workspace boundaries", () => {
  test("keeps one root release version and only private source workspaces", () => {
    const product = json("package.json");
    expect(product.private).toBe(true);
    expect(product.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(product.bin).toEqual({ sessionmap: "apps/cli/src/cli.ts" });

    for (const path of [
      "apps/cli/package.json",
      "apps/desktop/package.json",
      "packages/core/package.json",
      "packages/web/package.json",
    ]) {
      const workspace = json(path);
      expect(workspace.private).toBe(true);
      expect(workspace.version).toBeUndefined();
    }
  });

  test("allows the CLI app to consume core and Web without making desktop a business runtime", () => {
    const cli = json("apps/cli/package.json");
    expect(cli.dependencies).toEqual({
      "@sessionmap/core": "workspace:*",
      "@sessionmap/web": "workspace:*",
    });
    expect(json("apps/desktop/package.json").dependencies).toBeUndefined();
    expect(json("packages/core/package.json").dependencies).toBeUndefined();
    expect(json("packages/web/package.json").dependencies).toBeUndefined();
  });

  test("builds the existing CLI and desktop shell from their workspace sources", () => {
    const build = readFileSync(resolve(root, "scripts/build.ts"), "utf8");
    const appBuild = readFileSync(resolve(root, "scripts/build-macos-app.ts"), "utf8");
    expect(build).toContain('"apps", "cli", "src", "cli.ts"');
    expect(appBuild).toContain('"apps", "desktop", "src", "SessionMapApp.swift"');
    expect(appBuild).toContain('"packages", "web", "src", "sessionmap-icon.svg"');
  });

  test("enforces source dependency direction instead of trusting manifests alone", () => {
    for (const path of sourceFiles("packages/core/src")) {
      for (const specifier of imports(path)) {
        expect(specifier, `${path} must not import an app workspace`).not.toMatch(
          /^@sessionmap\/(?:cli|web|desktop)(?:\/|$)|(?:^|\/)apps\//,
        );
      }
    }

    for (const path of sourceFiles("packages/web/src")) {
      const source = readFileSync(resolve(root, path), "utf8");
      expect(source, `${path} must use the runtime HTTP boundary`).not.toMatch(
        /@sessionmap\/core|node:fs|\bBun\.|state\.json|capability\.token/,
      );
    }

    for (const path of sourceFiles("apps/desktop/src")) {
      const source = readFileSync(resolve(root, path), "utf8");
      expect(source, `${path} must remain a stateless display shell`).not.toMatch(
        /@sessionmap\/core|packages\/core|state\.json|capability\.token/,
      );
    }
  });

  test("names deployable entries as apps and reusable build inputs as packages", () => {
    expect(() => json("apps/cli/package.json")).not.toThrow();
    expect(() => json("packages/web/package.json")).not.toThrow();
    expect(() => json("apps/runtime/package.json")).toThrow();
    expect(() => json("apps/web/package.json")).toThrow();
  });

  test("keeps pure state and model protocols inward of side-effect adapters", () => {
    expect(imports("packages/core/src/state-repair.ts")).not.toContain("node:fs");
    expect(imports("packages/core/src/state-repair.ts")).not.toContain("./state-store.ts");
    expect(imports("packages/core/src/roll.ts")).not.toContain("./roll-engine.ts");
    expect(imports("packages/core/src/roll-engine.ts")).toContain("./roll-contract.ts");
    expect(imports("packages/core/src/roll-contract.ts")).not.toContain("./state-store.ts");
    expect(imports("packages/core/src/roll-candidate.ts")).not.toContain("./state-store.ts");
    expect(imports("packages/core/src/tree-roll.ts")).not.toContain("./state-store.ts");

    const rollProtocol = readFileSync(resolve(root, "packages/core/src/roll.ts"), "utf8");
    expect(rollProtocol).not.toMatch(/\bBun\.(?:spawn|which)|spawnSync|node:child_process/);
    const rollContract = readFileSync(resolve(root, "packages/core/src/roll-contract.ts"), "utf8");
    expect(rollContract).not.toMatch(/node:fs|\bBun\./);
  });
});
