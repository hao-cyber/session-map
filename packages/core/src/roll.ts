import {
  MAX_SUMMARY_HINT_BYTES,
  MAX_SUBTREE_LINES,
  ROLL_SENTINEL,
  SESSION_TRAIL_ITEMS,
} from "./constants.ts";
import { ROLL_OUTPUT_SHAPE, rollRuntimeContract } from "./roll-contract.ts";
import type { ProviderSummaryHint, SessionRecord, TrailState } from "./types.ts";
import { byteLength, truncateBytes } from "./utils.ts";

function rootLines(state: TrailState, rootId: string, maxLines: number): string[] {
  const lines: string[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>();
  while (stack.length && lines.length < maxLines) {
    const item = stack.pop();
    if (!item || seen.has(item.id)) continue;
    const node = state.nodes[item.id];
    if (!node) continue;
    seen.add(item.id);
    const note = node.blockedNote ?? node.note;
    lines.push(
      `${"  ".repeat(item.depth)}- ${node.id} [${node.type}/${node.state}] ${node.label}${note ? ` — ${note}` : ""}`,
    );
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) stack.push({ id: child, depth: item.depth + 1 });
    }
  }
  if (stack.length) lines.push("  … subtree truncated by runtime …");
  return lines;
}

function boundedMainlineList(state: TrailState, preferredRoot: string | null): string {
  const roots = [...state.roots].sort((left, right) => {
    if (left === preferredRoot) return -1;
    if (right === preferredRoot) return 1;
    return Date.parse(state.nodes[right]?.updatedAt ?? "") - Date.parse(state.nodes[left]?.updatedAt ?? "");
  });
  let output = "";
  for (const rootId of roots) {
    const root = state.nodes[rootId];
    if (!root) continue;
    const sessions = Object.values(state.sessions)
      .filter((session) => session.rootId === rootId)
      .sort((left, right) => Date.parse(right.lastTranscriptAt) - Date.parse(left.lastTranscriptAt))
      .slice(0, 3);
    const summaries = sessions.map((session) => session.snapshot.summary).filter(Boolean);
    const focuses = sessions
      .map((session) => session.cursor ? state.nodes[session.cursor]?.label : undefined)
      .filter((label): label is string => Boolean(label));
    const anchors = [
      summaries.length ? `sessions: ${summaries.join(" / ")}` : "",
      focuses.length ? `focus: ${Array.from(new Set(focuses)).join(" / ")}` : "",
    ].filter(Boolean).join(" | ");
    const line = `- ${root.label}${state.archived.includes(rootId) ? " [archived]" : ""}${anchors ? ` | ${anchors}` : ""}\n`;
    if (byteLength(output + line) > 4_096) break;
    output += line;
  }
  return output.trimEnd() || "(none)";
}

export function buildRollPrompt(
  state: TrailState,
  session: SessionRecord | undefined,
  delta: string,
  options: {
    historical?: boolean;
    reconcile?: boolean;
    summaryHint?: ProviderSummaryHint;
    snapshotOnly?: boolean;
  } = {},
): string {
  const subtree = session?.rootId && state.nodes[session.rootId]
    ? rootLines(state, session.rootId, MAX_SUBTREE_LINES).join("\n")
    : "(session is not attached yet)";
  const mainlines = boundedMainlineList(state, session?.rootId ?? null);
  const currentSnapshot = session
    ? JSON.stringify(session.snapshot)
    : "(no snapshot yet)";
  const historyContract = options.historical
    ? options.reconcile
      ? `\nHISTORICAL RECONCILIATION\n- This increment is older context discovered after newer activity was already mapped.\n- Preserve the current direction. Add only genuinely missing historical background or explicit revision relationships.\n- Do not close, unblock, rename, or refocus existing nodes based only on this older context.\n- Prefer no ops when the context is already represented. The snapshot may be clarified but must still describe the current session state.\n`
      : `\nHISTORICAL IMPORT\n- This is a chronological chunk from a user-confirmed historical session import.\n- Treat it as normal evidence in its original order; later chunks may revise it.\n`
    : "";
  const summaryContract = options.summaryHint
    ? `\nPROVIDER SUMMARY HINT\n- This provider-generated summary is a bounded, non-authoritative hint for the exact current session.\n- Use it to improve snapshot.summary, snapshot.progress, snapshot.trail, and existing-mainline candidate matching.\n- Transcript evidence and the persistent tree win whenever they conflict.\n<hint>\n${truncateBytes(options.summaryHint.text, MAX_SUMMARY_HINT_BYTES)}\n</hint>\n`
    : "";
  const snapshotOnlyContract = options.snapshotOnly
    ? `\nSNAPSHOT-ONLY ROUND\n- There is no new transcript evidence in this round.\n- Keep the session on its exact existing mainline, keep ask unchanged, and return ops: [].\n- Only revise snapshot fields that the provider summary clearly improves.\n`
    : "";
  return `${ROLL_SENTINEL}

You update a persistent external thinking tree for a developer who runs many coding agents in parallel.

SEMANTIC AUTHORITY
- You decide which work mainline this increment belongs to, what is a structural turn, and whether the agent is waiting for the user.
- A mainline is one piece of work, never a session and never a cwd. Different sessions in the same cwd can belong to different mainlines. A new session may continue an old mainline.
- Reuse an existing mainline name whenever its meaning is the same. Do not create aliases or cosmetic variants.

MEMORY STANDARD
- Record only structural change: a new subproblem, attempt, decisive finding, blocker, decision, or turn in direction.
- Do not record routine linear progress, narration, tool chatter, or every completed step.
- A direction change is close(old node with a concrete reason) plus grow(new direction). Dead paths remain permanently useful.
- Labels must be concrete enough for a human to recover context in three seconds. "音量假设已证伪" is useful; "调试进展" is not.
- Earlier beliefs are not timeless facts. Preserve revision history structurally: close an outdated attempt with why it changed, then grow the revised direction. Never silently rewrite the path.
- If later evidence makes a previously dead or resolved path useful again, do not unblock or rewrite that closed node. Grow a new "reconsidered because ..." direction so both judgments remain intelligible.
- Parent choice is the causal grammar of the tree. Attach a new direction beneath the existing finding, decision, blocker, or still-open task that explains why it exists. Use "mainline" only when there is no meaningful causal parent; never flatten a sequence of related turns into root-level siblings.
- New nodes do not have ids until the runtime applies this response. When a cause and its resulting direction are both new in the same round, express the turn as one concrete causal node instead of emitting sibling grow ops that make the relationship ambiguous.

ROLLING SESSION SNAPSHOT
- snapshot is a revisable read projection, not the permanent source of truth. The tree records the non-erased thought trajectory.
- snapshot.summary is a stable whole-session headline (what this session is really about), not the latest message. Keep it when still accurate; revise it when the session's meaning genuinely changes.
- snapshot.progress is the newest meaningful state, result, blocker, or next move. It should answer "where is this session now?" without vague progress language.
- snapshot.trail is 2-${SESSION_TRAIL_ITEMS} causal breadcrumbs for quick expansion: intent, decisive attempt/finding, rejected path, decision, and current direction. Prefer "A failed because B" over chronological narration.

${rollRuntimeContract()}
${historyContract}
${summaryContract}
${snapshotOnlyContract}

OUTPUT SHAPE
${ROLL_OUTPUT_SHAPE}

EXISTING MAINLINES
${mainlines}

CURRENT SESSION SUBTREE
${subtree}

CURRENT REVISABLE SESSION SNAPSHOT
${currentSnapshot}

FILTERED TRANSCRIPT INCREMENT
<delta>
${truncateBytes(delta, 12 * 1024)}
</delta>`;
}
