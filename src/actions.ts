import { existsSync } from "node:fs";
import { matchOrcaSession, orcaPath, readOrcaSnapshot, runOrcaJson } from "./orca.ts";
import { processForSession, readProcesses, runText } from "./monitor.ts";
import { StateStore } from "./state.ts";
import type { SessionRecord } from "./types.ts";
import { controlSafe, truncateChars } from "./utils.ts";

export interface ActionResult {
  ok: boolean;
  mode: "orca-switch" | "orca-resume" | "native-focus" | "native-resume" | "manual" | "error";
  message: string;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resumeCommand(session: SessionRecord): string {
  if (!validSessionId(session.id)) throw new Error("invalid session id");
  const cwd = controlSafe(session.cwd);
  if (!cwd || !existsSync(cwd)) throw new Error("session cwd no longer exists");
  const executable = session.provider === "claude" ? "claude --resume" : "codex resume";
  return `cd ${shellQuote(cwd)} && ${executable} ${shellQuote(session.id)}`;
}

async function ttyForPid(pid: number): Promise<string | null> {
  const result = await runText(["/bin/ps", "-o", "tty=", "-p", String(pid)]);
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
  constructor(readonly store: StateStore) {}

  session(id: string): SessionRecord {
    if (!validSessionId(id)) throw new Error("invalid session id");
    const session = this.store.snapshot().sessions[id];
    if (!session) throw new Error("unknown session");
    return session;
  }

  async jump(id: string): Promise<ActionResult> {
    try {
      const session = this.session(id);
      const orca = await readOrcaSnapshot();
      if (orca.available) {
        const match = matchOrcaSession(session, orca);
        if (match.terminal?.connected) {
          await runOrcaJson(["terminal", "switch", "--terminal", match.terminal.handle]);
          return { ok: true, mode: "orca-switch", message: "已切换到 Orca 终端" };
        }
        try {
          const command = resumeCommand(session);
          await runOrcaJson([
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
          return { ok: true, mode: "orca-resume", message: "已在 Orca 中复活 session" };
        } catch {
          // The cwd may not be registered in Orca. Native fallback preserves the affordance.
        }
      }

      let pid = session.pid;
      if (!pid) {
        const process = processForSession(session, await readProcesses());
        pid = process?.pid;
      }
      if (pid) {
        const tty = await ttyForPid(pid);
        if (tty && await runAppleScript(FOCUS_TTY_SCRIPT, [tty])) {
          return { ok: true, mode: "native-focus", message: "已聚焦系统终端" };
        }
      }
      const command = resumeCommand(session);
      if (await runAppleScript(RESUME_SCRIPT, [controlSafe(command)])) {
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
      const orca = await readOrcaSnapshot();
      if (orca.available) {
        const match = matchOrcaSession(session, orca);
        if (match.terminal?.connected && match.terminal.writable) {
          await runOrcaJson([
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
