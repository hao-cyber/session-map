import { existsSync } from "node:fs";
import { matchOrcaSession, orcaPath, readOrcaSnapshot, runOrcaJson } from "./orca.ts";
import { processForSession, readProcesses, readTranscriptProcesses, runText } from "./monitor.ts";
import { StateStore } from "./state.ts";
import type { SessionRecord } from "./types.ts";
import { controlSafe, isRecord, truncateChars } from "./utils.ts";

export interface ActionResult {
  ok: boolean;
  mode: "orca-switch" | "orca-resume" | "native-focus" | "native-resume" | "manual" | "error";
  message: string;
}

type TextResult = { ok: boolean; text: string };

export interface ActionDependencies {
  readOrcaSnapshot: typeof readOrcaSnapshot;
  runOrcaJson: typeof runOrcaJson;
  readProcesses: typeof readProcesses;
  readTranscriptProcesses: typeof readTranscriptProcesses;
  runText: (command: string[], timeoutMs?: number) => Promise<TextResult>;
  runAppleScript: (script: string, args: string[]) => Promise<boolean>;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function codexHomeForTranscript(path: string): string | null {
  const safePath = controlSafe(path);
  const marker = "/sessions/";
  const index = safePath.lastIndexOf(marker);
  if (!safePath.startsWith("/") || index <= 0) return null;
  return safePath.slice(0, index);
}

export function resumeCommand(session: SessionRecord): string {
  if (!validSessionId(session.id)) throw new Error("invalid session id");
  const cwd = controlSafe(session.cwd);
  if (!cwd || !existsSync(cwd)) throw new Error("session cwd no longer exists");
  const codexHome = session.provider === "codex" ? codexHomeForTranscript(session.path) : null;
  const executable = session.provider === "claude"
    ? "claude --resume"
    : codexHome
      ? `env CODEX_HOME=${shellQuote(codexHome)} codex resume -c check_for_update_on_startup=false`
      : "codex resume -c check_for_update_on_startup=false";
  return `cd ${shellQuote(cwd)} && ${executable} ${shellQuote(session.id)}`;
}

async function ttyForPid(pid: number, textRunner: ActionDependencies["runText"]): Promise<string | null> {
  const result = await textRunner(["/bin/ps", "-o", "tty=", "-p", String(pid)]);
  if (!result.ok) return null;
  const tty = controlSafe(result.text);
  if (!tty || tty === "??") return null;
  return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

const FOCUS_TTY_SCRIPT = String.raw`
on run argv
  set targetTTY to item 1 of argv
  try
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              if tty of s is targetTTY then
                select t
                select s
                activate
                return "focused"
              end if
            end try
          end repeat
        end repeat
      end repeat
    end tell
  end try
  try
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          try
            if tty of t is targetTTY then
              set selected of t to true
              set index of w to 1
              activate
              return "focused"
            end if
          end try
        end repeat
      end repeat
    end tell
  end try
  return "not-found"
end run`;

const RESUME_SCRIPT = String.raw`
on run argv
  set shellCommand to item 1 of argv
  tell application "Terminal"
    activate
    do script shellCommand
  end tell
  return "created"
end run`;

async function runAppleScript(script: string, args: string[]): Promise<boolean> {
  const result = await runText(["/usr/bin/osascript", "-e", script, "--", ...args], 10_000);
  return result.ok && !result.text.includes("not-found");
}

export class ActionRouter {
  readonly dependencies: ActionDependencies;

  constructor(readonly store: StateStore, dependencies: Partial<ActionDependencies> = {}) {
    this.dependencies = {
      readOrcaSnapshot,
      runOrcaJson,
      readProcesses,
      readTranscriptProcesses,
      runText,
      runAppleScript,
      ...dependencies,
    };
  }

  session(id: string): SessionRecord {
    if (!validSessionId(id)) throw new Error("invalid session id");
    const session = this.store.snapshot().sessions[id];
    if (!session) throw new Error("unknown session");
    return session;
  }

  async jump(id: string): Promise<ActionResult> {
    try {
      const session = this.session(id);
      const orca = await this.dependencies.readOrcaSnapshot();
      const orcaMatch = orca.available ? matchOrcaSession(session, orca) : {};
      if (orca.available) {
        if (orcaMatch.terminal?.connected) {
          await this.dependencies.runOrcaJson(["terminal", "switch", "--terminal", orcaMatch.terminal.handle]);
          return { ok: true, mode: "orca-switch", message: "已切换到 Orca 终端" };
        }
      }

      // A persisted PID is only a cache and may have been reused after the
      // original agent exited. Re-resolve the process from exact live evidence
      // on every click before deriving a TTY and focusing another application.
      const [transcriptProcesses, processes] = await Promise.all([
        this.dependencies.readTranscriptProcesses(),
        this.dependencies.readProcesses(),
      ]);
      const transcriptProcess = transcriptProcesses.find((candidate) => candidate.sessionId === session.id);
      const process = transcriptProcess ?? processForSession(session, processes);
      const pid = process?.pid;
      if (pid) {
        const tty = await ttyForPid(pid, this.dependencies.runText);
        if (tty && await this.dependencies.runAppleScript(FOCUS_TTY_SCRIPT, [tty])) {
          return { ok: true, mode: "native-focus", message: "已聚焦系统终端" };
        }
      }
      if (orcaMatch.ambiguous) {
        return { ok: false, mode: "error", message: "发现多个相似 Orca 终端，已停止以免切错 session" };
      }
      if (orca.available) {
        try {
          const command = resumeCommand(session);
          const created = await this.dependencies.runOrcaJson([
            "terminal",
            "create",
            "--worktree",
            `path:${session.cwd}`,
            "--title",
            truncateChars(session.mainline ?? session.title, 80),
            "--command",
            command,
            "--focus",
          ]);
          const terminal = isRecord(created) && isRecord(created.terminal) ? created.terminal : null;
          const handle = terminal && typeof terminal.handle === "string" ? terminal.handle : "";
          const paneKey = terminal && typeof terminal.paneKey === "string" ? terminal.paneKey : "";
          if (handle) {
            await this.store.update((state) => {
              const current = state.sessions[id];
              if (!current) return;
              current.terminalHandle = handle;
              if (paneKey) current.paneKey = paneKey;
              current.terminalOpen = true;
            });
          }
          return { ok: true, mode: "orca-resume", message: "已在 Orca 中复活 session" };
        } catch {
          // The cwd may not be registered in Orca. Native fallback preserves the affordance.
        }
      }
      const command = resumeCommand(session);
      if (await this.dependencies.runAppleScript(RESUME_SCRIPT, [controlSafe(command)])) {
        return { ok: true, mode: "native-resume", message: "已在系统终端复活 session" };
      }
      return { ok: false, mode: "error", message: "无法聚焦或复活该 session" };
    } catch (error) {
      return { ok: false, mode: "error", message: String(error) };
    }
  }

  async say(id: string, text: string): Promise<ActionResult> {
    const message = controlSafe(text);
    if (!message || message.length > 8_000) {
      return { ok: false, mode: "error", message: "消息必须为 1–8000 个字符" };
    }
    try {
      const session = this.session(id);
      const orca = await this.dependencies.readOrcaSnapshot();
      if (orca.available) {
        const match = matchOrcaSession(session, orca);
        if (match.terminal?.connected && match.terminal.writable) {
          await this.dependencies.runOrcaJson([
            "terminal",
            "send",
            "--terminal",
            match.terminal.handle,
            "--text",
            message,
            "--enter",
          ]);
          return { ok: true, mode: "orca-switch", message: "已发送到 Orca session" };
        }
      }
      const jumped = await this.jump(id);
      return {
        ok: false,
        mode: "manual",
        message: jumped.ok ? "已帮你聚焦；当前无 Orca，请手动输入消息" : jumped.message,
      };
    } catch (error) {
      return { ok: false, mode: "error", message: String(error) };
    }
  }
}

export function hasOrca(): boolean {
  return orcaPath() !== null;
}
