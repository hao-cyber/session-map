import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  GIANT_LINE_BYTES,
  LEGACY_ROLL_SENTINELS,
  MAX_DELTA_BYTES,
  MAX_READ_BYTES,
  ROLL_SENTINEL,
} from "./constants.ts";
import type { FilteredDelta, Provider } from "./types.ts";
import {
  byteLength,
  controlSafe,
  isRecord,
  normalizeText,
  truncateBytes,
  truncateChars,
} from "./utils.ts";

export interface ReadDeltaOptions {
  offset?: number;
  skipUntilNewline?: boolean;
  mtimeMs?: number;
}

type Collected = {
  users: string[];
  assistants: string[];
  tools: string[];
  errors: string[];
  sessionId: string;
  cwd: string;
  selfGenerated: boolean;
  parseErrors: number;
};

const INJECTED_PREFIXES = [
  "system-reminder",
  "local-command-caveat",
  "command-message",
  "command-name",
  "local-command-stdout",
  "task-notification",
] as const;

export function stripInjectedPrefixes(value: string): string {
  let text = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of INJECTED_PREFIXES) {
      const start = `<${tag}>`;
      if (!text.startsWith(start)) continue;
      const end = `</${tag}>`;
      const index = text.indexOf(end, start.length);
      text = index >= 0 ? text.slice(index + end.length).trimStart() : "";
      changed = true;
      break;
    }
  }
  return text;
}

function stringsFromContent(content: unknown, acceptedTypes: ReadonlySet<string>): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const result: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string" || !acceptedTypes.has(block.type)) continue;
    if (typeof block.text === "string") result.push(block.text);
  }
  return result;
}

function collectText(target: string[], text: string, collected: Collected, user = false): void {
  const sentinels = [ROLL_SENTINEL, ...LEGACY_ROLL_SENTINELS];
  if (sentinels.some((sentinel) => text.includes(sentinel))) collected.selfGenerated = true;
  const filtered = stripInjectedPrefixes(text);
  if (!filtered) return;
  target.push(filtered);
  if (user && sentinels.some((sentinel) => filtered.includes(sentinel))) collected.selfGenerated = true;
}

function collectClaude(row: Record<string, unknown>, result: Collected): void {
  if (row.isSidechain === true) return;
  if (typeof row.sessionId === "string" && row.sessionId) result.sessionId = row.sessionId;
  if (typeof row.cwd === "string" && row.cwd) result.cwd = row.cwd;
  const type = row.type;
  const message = isRecord(row.message) ? row.message : {};
  const role = typeof message.role === "string" ? message.role : type;
  const content = message.content;

  if (role === "user" || type === "user") {
    if (typeof content === "string") collectText(result.users, content, result, true);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          collectText(result.users, block.text, result, true);
        } else if (block.type === "tool_result" && block.is_error === true) {
          result.errors.push("tool_result:error");
        }
      }
    }
    return;
  }

  if (role === "assistant" || type === "assistant") {
    for (const text of stringsFromContent(content, new Set(["text"]))) {
      collectText(result.assistants, text, result);
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
          result.tools.push(block.name);
        }
      }
    }
    if (row.isApiErrorMessage === true || row.error) result.errors.push("assistant:error");
  }
}

function collectCodex(row: Record<string, unknown>, result: Collected): void {
  const payload = isRecord(row.payload) ? row.payload : {};
  if (row.type === "session_meta") {
    if (typeof payload.id === "string" && payload.id) result.sessionId = payload.id;
    else if (typeof payload.session_id === "string" && payload.session_id) result.sessionId = payload.session_id;
    if (typeof payload.cwd === "string" && payload.cwd) result.cwd = payload.cwd;
    return;
  }
  if (row.type === "turn_context" && typeof payload.cwd === "string" && payload.cwd) {
    result.cwd = payload.cwd;
    return;
  }
  if (row.type !== "response_item") return;
  if (payload.type === "message") {
    const role = payload.role;
    if (role === "user") {
      for (const text of stringsFromContent(payload.content, new Set(["input_text", "text"]))) {
        collectText(result.users, text, result, true);
      }
    } else if (role === "assistant") {
      for (const text of stringsFromContent(payload.content, new Set(["output_text", "text"]))) {
        collectText(result.assistants, text, result);
      }
    }
    return;
  }
  if (["function_call", "custom_tool_call", "tool_call"].includes(String(payload.type))) {
    if (typeof payload.name === "string") result.tools.push(payload.name);
    return;
  }
  if (["function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
    if (payload.is_error === true || payload.success === false || payload.status === "failed") {
      result.errors.push("tool_result:error");
    }
  }
}

function toolSummary(tools: string[]): string {
  if (!tools.length) return "";
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const raw of tools) {
    const name = truncateChars(controlSafe(raw), 80);
    if (!name) continue;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => `${name}×${counts.get(name)}`).join(" → ");
}

function buildBoundedDelta(collected: Collected): string {
  const users = collected.users.map((text) => `[user]\n${text}`).join("\n\n");
  const errors = collected.errors.length
    ? `[errors]\n${Array.from(new Set(collected.errors)).join("\n")}`
    : "";
  const tools = toolSummary(collected.tools);
  const toolBlock = tools ? `[tools]\n${tools}` : "";
  const structural = [errors, toolBlock].filter(Boolean).join("\n\n");
  const assistants = collected.assistants.map((text) => `[assistant]\n${text}`).join("\n\n");

  let output = truncateBytes(users, MAX_DELTA_BYTES);
  let remaining = MAX_DELTA_BYTES - byteLength(output);
  if (remaining > 2 && structural) {
    const spacer = output ? "\n\n" : "";
    const block = truncateBytes(`${spacer}${structural}`, remaining);
    output += block;
    remaining = MAX_DELTA_BYTES - byteLength(output);
  }
  if (remaining > 2 && assistants) {
    const spacer = output ? "\n\n" : "";
    const available = Math.max(0, remaining - byteLength(spacer));
    output += spacer + truncateBytes(assistants, available, true);
  }
  if (byteLength(output) > MAX_DELTA_BYTES) output = truncateBytes(output, MAX_DELTA_BYTES);
  return output;
}

function collectLines(provider: Provider, bytes: Uint8Array, fallbackId: string): Collected {
  const result: Collected = {
    users: [],
    assistants: [],
    tools: [],
    errors: [],
    sessionId: fallbackId,
    cwd: "",
    selfGenerated: false,
    parseErrors: 0,
  };
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index !== bytes.byteLength && bytes[index] !== 10) continue;
    const lineBytes = bytes.subarray(start, index);
    start = index + 1;
    if (!lineBytes.byteLength) continue;
    if (lineBytes.byteLength > GIANT_LINE_BYTES) {
      result.parseErrors += 1;
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(new TextDecoder().decode(lineBytes));
    } catch {
      result.parseErrors += 1;
      continue;
    }
    if (!isRecord(row)) {
      result.parseErrors += 1;
      continue;
    }
    if (provider === "claude") collectClaude(row, result);
    else collectCodex(row, result);
  }
  return result;
}

export function sessionIdFromPath(path: string, provider: Provider): string {
  const stem = basename(path, ".jsonl");
  if (provider === "claude") return stem;
  const match = stem.match(/([0-9a-f]{8}-[0-9a-f-]{20,})$/i);
  return match?.[1] ?? stem;
}

export function providerForPath(path: string): Provider | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.includes("/.claude/projects/") && normalized.endsWith(".jsonl")) return "claude";
  if (normalized.includes("/sessions/") && basename(path).startsWith("rollout-") && normalized.endsWith(".jsonl")) {
    return "codex";
  }
  return null;
}

export function readTranscriptDelta(
  path: string,
  provider: Provider,
  options: ReadDeltaOptions = {},
): FilteredDelta {
  const stat = statSync(path);
  let offset = Math.max(0, Math.floor(options.offset ?? 0));
  if (offset > stat.size) offset = 0;
  const readLength = Math.min(MAX_READ_BYTES, Math.max(0, stat.size - offset));
  const raw = Buffer.allocUnsafe(readLength);
  let bytesRead = 0;
  if (readLength) {
    const fd = openSync(path, "r");
    try {
      bytesRead = readSync(fd, raw, 0, readLength, offset);
    } finally {
      closeSync(fd);
    }
  }
  const bytes = raw.subarray(0, bytesRead);
  let dataStart = 0;
  let skipUntilNewline = options.skipUntilNewline === true;
  if (skipUntilNewline) {
    const newline = bytes.indexOf(10);
    if (newline < 0) {
      const id = sessionIdFromPath(path, provider);
      return {
        meta: {
          provider,
          sessionId: id,
          path,
          cwd: "",
          title: `${provider}:${id.slice(0, 8)}`,
          lastUser: "",
          mtimeMs: options.mtimeMs ?? stat.mtimeMs,
        },
        text: "",
        nextOffset: offset + bytesRead,
        lowSignal: true,
        selfGenerated: false,
        skipUntilNewline: true,
        parseErrors: 1,
        bytesRead,
      };
    }
    dataStart = newline + 1;
    skipUntilNewline = false;
  }

  const lastNewline = bytes.lastIndexOf(10);
  let dataEnd = lastNewline >= dataStart ? lastNewline : dataStart - 1;
  let nextOffset = offset + dataStart;
  if (dataEnd >= dataStart) {
    nextOffset = offset + dataEnd + 1;
  } else if (bytesRead - dataStart > GIANT_LINE_BYTES) {
    nextOffset = offset + bytesRead;
    skipUntilNewline = true;
  } else if (bytesRead === 0) {
    nextOffset = offset;
  }
  const complete = dataEnd >= dataStart ? bytes.subarray(dataStart, dataEnd + 1) : new Uint8Array();
  const fallbackId = sessionIdFromPath(path, provider);
  const collected = collectLines(provider, complete, fallbackId);
  const lastUser = collected.users.at(-1) ?? "";
  const titleLine = lastUser.split(/\r?\n/, 1)[0] ?? "";
  const title = truncateChars(normalizeText(titleLine) || `${provider}:${collected.sessionId.slice(0, 8)}`, 100);
  const lowSignal = collected.users.length === 0 && collected.assistants.length === 0 && collected.errors.length === 0;
  return {
    meta: {
      provider,
      sessionId: collected.sessionId,
      path,
      cwd: collected.cwd,
      title,
      lastUser: truncateChars(lastUser, 2_000),
      mtimeMs: options.mtimeMs ?? stat.mtimeMs,
    },
    text: buildBoundedDelta(collected),
    nextOffset,
    lowSignal,
    selfGenerated: collected.selfGenerated,
    skipUntilNewline,
    parseErrors: collected.parseErrors,
    bytesRead,
  };
}
