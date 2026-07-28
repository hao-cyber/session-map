import {
  ASK_KINDS,
  MAX_OPS,
  NODE_LABEL_CHARS,
  NODE_TYPES,
  SESSION_PROGRESS_CHARS,
  SESSION_SUMMARY_CHARS,
  SESSION_TRAIL_ITEM_CHARS,
} from "./constants.ts";
import type { RollOutput } from "./types.ts";
import { isRecord } from "./utils.ts";

export const ROLL_OPERATION_FORMS = [
  '{"op":"grow","parent":"<node-id|mainline>","type":"<node-type>","label":"..."}',
  '{"op":"close","node":"<node-id>","state":"resolved|dead","note":"reason"}',
  '{"op":"block","node":"<node-id>","note":"what is awaited"}',
  '{"op":"unblock","node":"<node-id>"}',
  '{"op":"rename","node":"<node-id>","label":"..."}',
  '{"op":"refocus","node":"<node-id>"}',
] as const;

export const ROLL_OUTPUT_SHAPE = '{"mainline":"existing or new semantic mainline","ask":{"kind":"decision|review|reply|none","hint":"short"},"snapshot":{"summary":"whole-session headline","progress":"latest meaningful state","trail":["causal breadcrumb"]},"ops":[]}';

export function rollRuntimeContract(): string {
  return `RUNTIME CONTRACT
- Return one JSON object only, with no prose and no code fence.
- At most ${MAX_OPS} ops.
- mainline <= 48 characters; node labels <= ${NODE_LABEL_CHARS} characters; ask.hint <= 16 characters.
- snapshot.summary <= ${SESSION_SUMMARY_CHARS} characters; snapshot.progress <= ${SESSION_PROGRESS_CHARS} characters; each snapshot.trail item <= ${SESSION_TRAIL_ITEM_CHARS} characters.
- Allowed node types: ${NODE_TYPES.join(", ")}.
- For grow at the root, parent may be the literal "mainline" or the exact mainline value. Prefer "mainline". Otherwise parent must be an existing node id from CURRENT SESSION SUBTREE.
- Allowed ops:
${ROLL_OPERATION_FORMS.map((form) => `  ${form}`).join("\n")}
- The runtime allocates ids and rejects cross-mainline writes. Never invent an id for an existing node.
- unblock applies only to a waiting node. resolved/dead outcomes cannot be reopened; represent reconsideration with grow.
- ask.kind is ${ASK_KINDS.join(", ")}. This is a semantic judgment about what the user is being asked to do now.`;
}

function unwrapRoll(value: unknown): RollOutput | null {
  if (isRecord(value)) {
    if (typeof value.mainline === "string" && Array.isArray(value.ops)) {
      const ask = isRecord(value.ask) ? value.ask : { kind: "none", hint: "" };
      return {
        mainline: value.mainline,
        ask: {
          kind: typeof ask.kind === "string" ? (ask.kind as RollOutput["ask"]["kind"]) : "none",
          hint: typeof ask.hint === "string" ? ask.hint : "",
        },
        ...(value.snapshot !== undefined ? { snapshot: value.snapshot } : {}),
        ops: value.ops,
      };
    }
    for (const key of ["result", "output", "content", "response", "text", "message", "item", "data"]) {
      const nested = value[key];
      if (typeof nested === "string") {
        const parsed = extractRollOutput(nested);
        if (parsed) return parsed;
      } else if (nested !== undefined) {
        const parsed = unwrapRoll(nested);
        if (parsed) return parsed;
      }
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = unwrapRoll(item);
      if (parsed) return parsed;
    }
  }
  return null;
}

function balancedObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return objects;
}

export function extractRollOutput(output: string): RollOutput | null {
  const trimmed = output.trim();
  try {
    const direct = unwrapRoll(JSON.parse(trimmed));
    if (direct) return direct;
  } catch {}
  let found: RollOutput | null = null;
  for (const candidate of balancedObjects(trimmed)) {
    try {
      const parsed = unwrapRoll(JSON.parse(candidate));
      if (parsed) found = parsed;
    } catch {}
  }
  return found;
}
