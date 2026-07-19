import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAINLINE_NAME_CHARS, NODE_LABEL_CHARS, NOTE_CHARS } from "./constants.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replaceAll(/\s+/g, " ").trim();
}

export function truncateChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

export function canonicalMainline(value: unknown): string {
  return truncateChars(normalizeText(value), MAINLINE_NAME_CHARS);
}

export function canonicalNodeLabel(value: unknown): string {
  return truncateChars(normalizeText(value), NODE_LABEL_CHARS);
}

export function canonicalNote(value: unknown): string {
  return truncateChars(normalizeText(value), NOTE_CHARS);
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function truncateBytes(value: string, maxBytes: number, fromTail = false): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const slice = fromTail ? bytes.slice(bytes.byteLength - maxBytes) : bytes.slice(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/^\uFFFD|\uFFFD$/g, "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MARKDOWN_ENTITIES: Record<string, string> = {
  "!": "&#33;",
  "#": "&#35;",
  "+": "&#43;",
  "-": "&#45;",
  ".": "&#46;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "\\": "&#92;",
  "`": "&#96;",
  "{": "&#123;",
  "|": "&#124;",
  "}": "&#125;",
  "*": "&#42;",
  "~": "&#126;",
  _: "&#95;",
};

export function escapeMarkdown(value: unknown): string {
  return escapeHtml(value).replaceAll(/[!#+\-.\[\]()\\`{|}*~_]/g, (char) => MARKDOWN_ENTITIES[char] ?? char);
}

export function defaultStateDirectory(home = homedir()): string {
  return resolve(join(home, "Library", "Application Support", "SessionMap"));
}

export function legacyStateDirectory(home = homedir()): string {
  return resolve(join(home, ".maintrail"));
}

export function stateDirectory(explicit?: string): string {
  return resolve(explicit ?? process.env.SESSIONMAP_STATE_DIR ?? defaultStateDirectory());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const delta = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(delta)) return "未知";
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function controlSafe(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F]/g, " ").trim();
}
