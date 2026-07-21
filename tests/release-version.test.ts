import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextBetaVersion, writePackageVersion } from "../scripts/prepare-release-version.ts";
import { cleanup, temporaryDirectory } from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("automatic release versioning", () => {
  test("increments only the existing beta sequence", () => {
    expect(nextBetaVersion("v0.1.0-beta.2")).toBe("0.1.0-beta.3");
    expect(() => nextBetaVersion("v0.1.0")).toThrow("not an incrementable beta tag");
    expect(() => nextBetaVersion("nightly-20260721")).toThrow("not an incrementable beta tag");
  });

  test("changes only the root product version", () => {
    const root = temporaryDirectory("sessionmap-release-version-");
    roots.push(root);
    const path = join(root, "package.json");
    writeFileSync(path, `${JSON.stringify({ name: "sessionmap", version: "0.1.0-beta.2", private: true }, null, 2)}\n`);
    writePackageVersion(path, "0.1.0-beta.3");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      name: "sessionmap",
      version: "0.1.0-beta.3",
      private: true,
    });
  });
});
