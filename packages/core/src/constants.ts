export const APP_NAME = "sessionmap";
export const SCHEMA_VERSION = 6;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

export const POLL_MS = 5_000;
export const STATUS_POLL_MS = 5_000;
export const GIT_POLL_MS = 30_000;
export const UI_POLL_MS = 4_000;
export const LINGER_MS = 90_000;
export const LINGER_BYTES = 32 * 1024;
export const SESSION_COOLDOWN_MS = 45_000;
export const MAX_ACTIVE_SESSIONS = 60;
export const MAX_ROLL_CONCURRENCY = 3;
export const MAX_HISTORY_ROLLS = 2;
export const HISTORY_QUEUE_BUFFER = 4;
export const HISTORY_RETRY_LIMIT = 3;
export const HISTORY_RETRY_BASE_MS = 5_000;
export const STALE_RETRY_LIMIT = 3;
export const HISTORY_RANGE_DAYS = [7, 30, 90] as const;
export const MAX_READ_BYTES = 4 * 1024 * 1024;
export const GIANT_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_DELTA_BYTES = 12 * 1024;
export const MAX_POST_BYTES = 64 * 1024;
export const MAX_OPS = 6;
export const MAX_SUBTREE_LINES = 120;
export const MAINLINE_NAME_CHARS = 48;
export const NODE_LABEL_CHARS = 20;
export const NOTE_CHARS = 160;
export const SESSION_SUMMARY_CHARS = 36;
export const SESSION_PROGRESS_CHARS = 56;
export const SESSION_TRAIL_ITEM_CHARS = 48;
export const SESSION_TRAIL_ITEMS = 6;
export const ROLL_TIMEOUT_MS = 180_000;
export const ROLL_SENTINEL = "SESSIONMAP_ROLL_V1_DO_NOT_INGEST";
export const LEGACY_ROLL_SENTINELS = ["MAINTRAIL_ROLL_V1_DO_NOT_INGEST"] as const;

export const NODE_TYPES = [
  "goal",
  "task",
  "attempt",
  "finding",
  "blocker",
  "decision",
  "note",
] as const;

export const NODE_STATES = ["active", "waiting", "resolved", "dead"] as const;
export const ASK_KINDS = ["decision", "review", "reply", "none"] as const;
export const PROVIDERS = ["claude", "codex", "kimi", "grok", "minimax"] as const;
export const ENGINE_NAMES = ["claude", "codex", "kimi", "grok"] as const;
