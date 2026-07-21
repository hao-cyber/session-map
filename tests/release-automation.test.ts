import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("release automation contracts", () => {
  test("cuts at most one tested beta per Shanghai day and never pushes main", () => {
    const workflow = source(".github/workflows/daily-release.yml");
    expect(workflow).toContain('cron: "0 14 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require successful CI for the exact main commit");
    expect(workflow).toContain("bun run check:ci");
    expect(workflow).toContain("Release-Source: $RELEASE_SOURCE");
    expect(workflow).toContain('git push origin "refs/tags/$RELEASE_TAG"');
    expect(workflow).toContain('gh workflow run release.yml --ref "$RELEASE_TAG"');
    expect(workflow).not.toMatch(/git push origin (?:HEAD:)?main/);
  });

  test("publishes before deriving and pushing the Homebrew Formula", () => {
    const workflow = source(".github/workflows/release.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Publish GitHub Release");
    expect(workflow).toContain("update-homebrew:");
    expect(workflow).toContain("needs: release");
    expect(workflow).toContain("HOMEBREW_TAP_DEPLOY_KEY");
    expect(workflow).toContain("update-homebrew-formula.ts");
    expect(workflow).toContain("brew audit --strict --online");
    expect(workflow).toContain("git -C \"$TAP_DIRECTORY\" push origin HEAD:main");
  });
});
