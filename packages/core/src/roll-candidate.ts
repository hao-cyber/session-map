import { STALE_RETRY_LIMIT } from "./constants.ts";
import type { RollOutput, TrailState } from "./types.ts";
import { canonicalMainline } from "./utils.ts";

function rootFingerprint(state: TrailState, rootId: string | null): string {
  if (!rootId || !state.nodes[rootId]) return "";
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !state.nodes[id]) continue;
    seen.add(id);
    ids.push(id);
    stack.push(...state.nodes[id]!.children);
  }
  ids.sort();
  const nodes = ids.map((id) => {
    const node = state.nodes[id]!;
    return [id, node.parent, node.type, node.label, node.state, node.note, node.blockedNote, node.children];
  });
  const sessions = Object.values(state.sessions)
    .filter((session) => session.rootId === rootId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => [session.id, session.cursor, session.lastTranscriptAt, session.snapshot]);
  return JSON.stringify([nodes, sessions]);
}

function directoryFingerprint(state: TrailState): string {
  return JSON.stringify(state.roots.map((rootId) => {
    const root = state.nodes[rootId];
    const sessions = Object.values(state.sessions)
      .filter((session) => session.rootId === rootId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => [session.id, session.cursor, session.lastTranscriptAt, session.snapshot.summary]);
    return [rootId, root?.label, state.archived.includes(rootId), sessions];
  }));
}

export function candidateIsFresh(
  base: TrailState,
  current: TrailState,
  sessionId: string,
  output: RollOutput,
  snapshotOnly = false,
): boolean {
  const baseSource = base.sessions[sessionId]?.rootId ?? null;
  const currentSource = current.sessions[sessionId]?.rootId ?? null;
  if (baseSource !== currentSource || rootFingerprint(base, baseSource) !== rootFingerprint(current, currentSource)) {
    return false;
  }
  if (snapshotOnly) return true;
  const mainline = canonicalMainline(output.mainline);
  if (!mainline) return true;
  const baseTarget = base.mainlineIndex[mainline] ?? null;
  const currentTarget = current.mainlineIndex[mainline] ?? null;
  if (baseTarget) {
    return baseTarget === currentTarget
      && rootFingerprint(base, baseTarget) === rootFingerprint(current, currentTarget);
  }
  // Exact-name convergence is safe: TreeRuntime still rejects stale or
  // cross-mainline node references on an unattached/reattach round.
  if (currentTarget) return true;
  return directoryFingerprint(base) === directoryFingerprint(current);
}

export type CandidateAttempt = "initial" | "stale-retry";
export type CandidateCommitResult = { done: boolean; current: TrailState | null };

export async function runRollCandidateLoop(options: {
  initialState: TrailState;
  invoke: (state: TrailState, attempt: CandidateAttempt) => Promise<RollOutput>;
  validateAndCommit: (base: TrailState, output: RollOutput) => Promise<CandidateCommitResult>;
  staleError: string;
  onValidating?: () => void;
}): Promise<void> {
  let base = options.initialState;
  let output = await options.invoke(base, "initial");
  for (let staleRetries = 0; staleRetries <= STALE_RETRY_LIMIT; staleRetries += 1) {
    options.onValidating?.();
    const result = await options.validateAndCommit(base, output);
    if (result.done) return;
    if (staleRetries === STALE_RETRY_LIMIT || !result.current) throw new Error(options.staleError);
    base = result.current;
    output = await options.invoke(base, "stale-retry");
  }
}
