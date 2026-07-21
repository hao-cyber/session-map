import { describe, expect, test } from "bun:test";
import { parseChecksums, renderHomebrewFormula } from "../scripts/update-homebrew-formula.ts";

const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);

describe("Homebrew Formula release projection", () => {
  test("renders both native Release assets with exact checksums", () => {
    const checksums = parseChecksums([
      `${ARM_SHA}  sessionmap-0.1.0-beta.3-darwin-arm64.tar.gz`,
      `${INTEL_SHA} *sessionmap-0.1.0-beta.3-darwin-x86_64.tar.gz`,
    ].join("\n"));
    const formula = renderHomebrewFormula("0.1.0-beta.3", checksums);
    expect(formula).toContain("releases/download/v0.1.0-beta.3/sessionmap-0.1.0-beta.3-darwin-arm64.tar.gz");
    expect(formula).toContain(`sha256 "${ARM_SHA}"`);
    expect(formula).toContain("sessionmap-0.1.0-beta.3-darwin-x86_64.tar.gz");
    expect(formula).toContain(`sha256 "${INTEL_SHA}"`);
    expect(formula).not.toContain("version \"");
  });

  test("rejects malformed versions and incomplete manifests", () => {
    expect(() => renderHomebrewFormula("../beta.3", new Map())).toThrow("invalid release version");
    expect(() => renderHomebrewFormula("0.1.0-beta.3", new Map())).toThrow("missing checksum");
  });
});
