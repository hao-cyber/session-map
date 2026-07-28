import { describe, expect, test } from "bun:test";
import { STALE_RETRY_LIMIT } from "@sessionmap/core/constants.ts";
import { runRollCandidateLoop, type CandidateAttempt } from "@sessionmap/core/roll-candidate.ts";
import { createEmptyState } from "@sessionmap/core/state-repair.ts";

const output = {
  mainline: "稳定主线",
  ask: { kind: "none" as const, hint: "" },
  ops: [],
};

describe("roll candidate loop", () => {
  test("rebuilds one stale candidate from the latest state before committing", async () => {
    const initial = createEmptyState("claude", "2026-07-29T00:00:00.000Z");
    const refreshed = { ...initial, revision: 1 };
    const attempts: CandidateAttempt[] = [];
    let validations = 0;

    await runRollCandidateLoop({
      initialState: initial,
      staleError: "candidate stayed stale",
      invoke: async (_state, attempt) => {
        attempts.push(attempt);
        return output;
      },
      validateAndCommit: async () => {
        validations += 1;
        return validations === 1
          ? { done: false, current: refreshed }
          : { done: true, current: null };
      },
    });

    expect(attempts).toEqual(["initial", "stale-retry"]);
    expect(validations).toBe(2);
  });

  test("fails after the bounded stale retry budget", async () => {
    const state = createEmptyState("claude", "2026-07-29T00:00:00.000Z");
    let invocations = 0;

    const run = runRollCandidateLoop({
      initialState: state,
      staleError: "candidate stayed stale",
      invoke: async () => {
        invocations += 1;
        return output;
      },
      validateAndCommit: async () => ({ done: false, current: state }),
    });

    await expect(run).rejects.toThrow("candidate stayed stale");
    expect(invocations).toBe(STALE_RETRY_LIMIT + 1);
  });
});
