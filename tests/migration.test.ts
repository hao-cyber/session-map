import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyState } from "@sessionmap/runtime/migration.ts";
import { createEmptyState } from "@sessionmap/core/state-repair.ts";
import { defaultStateDirectory, legacyStateDirectory } from "@sessionmap/core/utils.ts";
import { cleanup, temporaryDirectory } from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

function fixture(): { root: string; legacy: string; current: string } {
  const root = temporaryDirectory("sessionmap-migration-");
  roots.push(root);
  return {
    root,
    legacy: join(root, ".maintrail"),
    current: join(root, "Library", "Application Support", "SessionMap"),
  };
}

describe("SessionMap 状态迁移", () => {
  test("默认目录遵循 macOS 约定，同时能定位旧目录", () => {
    const home = "/Users/example";
    expect(defaultStateDirectory(home)).toBe("/Users/example/Library/Application Support/SessionMap");
    expect(legacyStateDirectory(home)).toBe("/Users/example/.maintrail");
  });

  test("原子复制持久状态和 token，但不复制锁与日志", () => {
    const { legacy, current } = fixture();
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    const durable = createEmptyState("codex", "2026-07-18T00:00:00.000Z");
    durable.schemaVersion = 1;
    durable.revision = 17;
    durable.offsets.a = {
      path: "/tmp/a.jsonl",
      provider: "codex",
      sessionId: "a",
      offset: 99,
      mtimeMs: 1,
      cooldownUntil: 0,
    };
    const state = `${JSON.stringify(durable, null, 2)}\n`;
    writeFileSync(join(legacy, "state.json"), state, { mode: 0o600 });
    writeFileSync(join(legacy, "capability.token"), "private-token\n", { mode: 0o600 });
    writeFileSync(join(legacy, ".instance.lock"), "runtime-only");
    writeFileSync(join(legacy, "server.log"), "runtime-only");

    const result = migrateLegacyState(legacy, current, "2026-07-19T00:00:00.000Z");
    expect(result.reason).toBe("migrated");
    expect(readFileSync(join(current, "state.json"), "utf8")).toBe(state);
    expect(readFileSync(join(legacy, "state.json"), "utf8")).toBe(state);
    expect(readFileSync(join(current, "capability.token"), "utf8")).toBe("private-token\n");
    expect(readFileSync(join(current, "migration.json"), "utf8")).toContain(legacy);
    expect(Bun.file(join(current, ".instance.lock")).size).toBe(0);
    expect(Bun.file(join(current, "server.log")).size).toBe(0);
    expect(statSync(current).mode & 0o777).toBe(0o700);
    expect(statSync(join(current, "state.json")).mode & 0o777).toBe(0o600);
  });

  test("目标目录已存在时绝不覆盖", () => {
    const { legacy, current } = fixture();
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, "state.json"), "legacy");
    writeFileSync(join(current, "state.json"), "current");
    chmodSync(current, 0o700);

    expect(migrateLegacyState(legacy, current).reason).toBe("destination-exists");
    expect(readFileSync(join(current, "state.json"), "utf8")).toBe("current");
  });

  test("损坏的旧状态不会被发布成看似健康的新安装", () => {
    const { legacy, current } = fixture();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "state.json"), "{broken", { mode: 0o600 });
    expect(() => migrateLegacyState(legacy, current)).toThrow();
    expect(existsSync(current)).toBeFalse();
  });

  test("可解析但会在升级时丢对象的旧状态同样拒绝发布", () => {
    const { legacy, current } = fixture();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "state.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 9,
      engine: "codex",
      roots: ["missing-root"],
      nodes: {},
      sessions: {},
      offsets: {},
    }), { mode: 0o600 });
    expect(() => migrateLegacyState(legacy, current)).toThrow("without losing durable objects");
    expect(existsSync(current)).toBeFalse();
  });
});
