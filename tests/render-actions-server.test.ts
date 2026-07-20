import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ActionRouter, codexHomeForTranscript, resumeCommand, shellQuote, validSessionId } from "../src/actions.ts";
import { AssetStore } from "../src/assets.ts";
import { SessionMonitor } from "../src/monitor.ts";
import { createOpenTicket } from "../src/open.ts";
import { matchOrcaSession, stripSpinner, type OrcaSnapshot } from "../src/orca.ts";
import { activeSessionCount, buildNowItems, renderMarkdown } from "../src/render.ts";
import { SessionMapHttpServer, allowedOrigin, ensureCapabilityToken, validJsonMediaType } from "../src/server.ts";
import { StateStore } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import { TranscriptWatcher } from "../src/watcher.ts";
import { cleanup, sessionRecord, temporaryDirectory, transcriptMeta } from "./helpers.ts";

const directories: string[] = [];
const servers: SessionMapHttpServer[] = [];
function directory(): string {
  const value = temporaryDirectory();
  directories.push(value);
  return value;
}
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop());
  directories.splice(0).forEach(cleanup);
});

describe("safe rendering and attention ordering", () => {
  test("renders model-controlled Markdown and HTML as literal text", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("s", process.cwd()), {
      mainline: "# [x](javascript:alert(1)) `code` <b>x</b>",
      ask: { kind: "none", hint: "" },
      ops: [{ op: "grow", parent: "mainline", type: "note", label: "<img src=x>" }],
    });
    const markdown = renderMarkdown(store.snapshot());
    expect(markdown).not.toContain("[x](javascript:");
    expect(markdown).not.toContain("<b>x</b>");
    expect(markdown).not.toContain("`code`");
    expect(markdown).not.toContain("<img src=x>");
    expect(markdown).toContain("&#91;x&#93;&#40;javascript:alert&#40;1&#41;&#41;");
    expect(markdown).toContain("&#35; &#91;x&#93;");
    expect(markdown).toContain("&#96;code&#96;");
    expect(markdown).toContain("&lt;img src=x&gt;");
  });

  test("groups three closed sibling leaves without deleting their details", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("s", process.cwd());
    await runtime.applyRoll(meta, { mainline: "History", ask: { kind: "none", hint: "" }, ops: [
      { op: "grow", parent: "mainline", type: "attempt", label: "路一" },
      { op: "grow", parent: "mainline", type: "attempt", label: "路二" },
      { op: "grow", parent: "mainline", type: "attempt", label: "路三" },
      { op: "grow", parent: "mainline", type: "task", label: "当前方向" },
    ] });
    const children = store.snapshot().nodes[store.snapshot().roots[0]!]!.children;
    await runtime.applyRoll(meta, { mainline: "History", ask: { kind: "none", hint: "" }, ops: children.slice(0, 3).map((node, index) => ({ op: "close", node, state: index === 1 ? "dead" : "resolved", note: "原因保留" })) });
    const markdown = renderMarkdown(store.snapshot());
    expect(markdown).toContain("历史：已完成 2 · 死路 1");
    expect(markdown).toContain("路一");
    expect(markdown).toContain("路二");
  });

  test("prioritizes decisions before replies, blockers, and busy work", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("decision", process.cwd()), { mainline: "Decide", ask: { kind: "decision", hint: "选方案" }, ops: [] });
    await runtime.applyRoll(transcriptMeta("reply", process.cwd()), { mainline: "Reply", ask: { kind: "reply", hint: "回一句" }, ops: [] });
    await store.update((state) => {
      state.sessions.decision!.terminalOpen = true;
      state.sessions.reply!.terminalOpen = true;
      state.sessions.reply!.status = "busy";
    });
    const items = buildNowItems(store.snapshot());
    expect(items.map((item) => item.kind).slice(0, 2)).toEqual(["decision", "reply"]);
    expect(activeSessionCount(store.snapshot())).toBe(2);
  });

  test("removes archived mainline asks from Now without deleting sessions", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const line = await runtime.applyRoll(transcriptMeta("archived-decision", process.cwd()), {
      mainline: "暂存发布决策",
      ask: { kind: "decision", hint: "选择渠道" },
      ops: [],
    });
    expect(buildNowItems(store.snapshot()).map((item) => item.sessionId)).toContain("archived-decision");
    await runtime.archive(line.rootId);
    expect(buildNowItems(store.snapshot()).map((item) => item.sessionId)).not.toContain("archived-decision");
    expect(store.snapshot().sessions["archived-decision"]).toBeDefined();
    await runtime.restore(line.rootId);
    expect(buildNowItems(store.snapshot()).map((item) => item.sessionId)).toContain("archived-decision");
  });

  test("renders topic sessions as stable second-level navigation entries", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    const first = transcriptMeta("topic-session-a", process.cwd());
    first.title = "实现发布流程";
    const second = transcriptMeta("topic-session-b", process.cwd());
    second.title = "复核发布流程";
    await runtime.applyRoll(first, {
      mainline: "准备首发",
      ask: { kind: "decision", hint: "选择格式" },
      snapshot: {
        summary: "构建本地网页发布流程",
        progress: "等待选择安装引导",
        trail: ["原生壳增加维护成本，改用本地网页", "standalone CLI 构建通过"],
      },
      ops: [{ op: "grow", parent: "mainline", type: "task", label: "验证授权入口" }],
    });
    await runtime.applyRoll(second, {
      mainline: "准备首发",
      ask: { kind: "none", hint: "" },
      ops: [],
    });
    await store.update((state) => {
      state.sessions[second.sessionId]!.status = "closed";
      state.sessions[second.sessionId]!.terminalOpen = false;
    });

    const markdown = renderMarkdown(store.snapshot());
    const lines = markdown.split("\n");
    const topic = lines.findIndex((line) => line.includes("data-kind=\"mainline\"") && line.includes("准备首发"));
    const sessions = lines.filter((line) => line.startsWith("  - ") && line.includes("data-kind=\"session\""));
    const summary = lines.findIndex((line) => line.includes("data-kind=\"thoughts\""));
    const thought = lines.findIndex((line) => line.includes('data-kind="node"') && line.includes("验证授权入口"));
    expect(topic).toBeGreaterThan(0);
    expect(sessions).toHaveLength(2);
    const firstLine = sessions.find((line) => line.includes('data-session-id="topic-session-a"'))!;
    const secondLine = sessions.find((line) => line.includes('data-session-id="topic-session-b"'))!;
    expect(firstLine).toContain("构建本地网页发布流程");
    expect(firstLine).toContain("等待选择安装引导");
    expect(firstLine).toContain(`data-cwd="${process.cwd()}"`);
    expect(firstLine).toContain("session-context");
    expect(firstLine).toContain("session-created");
    expect(firstLine).toContain("session-updated");
    expect(firstLine).not.toContain("定位脉络");
    expect(firstLine).toContain('data-action="none"');
    expect(firstLine).not.toContain('data-cursor-id=');
    expect(firstLine).not.toContain('data-inline-action="locate-lineage"');
    expect(firstLine).toContain('data-inline-action="jump-session"');
    expect(firstLine).toContain('data-inline-action="delete-session"');
    expect(firstLine).toContain('<span class="jump-action-label">回到终端</span></button>');
    expect(firstLine).toContain('data-pending-label="回到中…"');
    expect(secondLine).toContain("复核发布流程");
    expect(secondLine).toContain('<span class="jump-action-label">恢复终端</span></button>');
    expect(secondLine).toContain('data-pending-label="恢复中…"');
    expect(summary).toBeGreaterThan(topic);
    expect(lines.indexOf(firstLine)).toBeGreaterThan(summary);
    expect(lines.indexOf(secondLine)).toBeGreaterThan(summary);
    expect(lines[summary]).toContain('data-default-fold="true"');
    expect(lines[summary]).toContain("主题脉络");
    expect(summary).toBeLessThan(thought);
    expect(lines[thought]).toStartWith("    - ");
    expect(markdown).not.toContain('data-kind="snapshot"');
    expect(markdown).not.toContain("原生壳增加维护成本，改用本地网页");
  });

  test("keeps session chronology stable while exposing last activity as metadata", async () => {
    const store = new StateStore(directory());
    const runtime = new TreeRuntime(store);
    await runtime.applyRoll(transcriptMeta("older", process.cwd()), {
      mainline: "稳定时间线", ask: { kind: "none", hint: "" },
      snapshot: { summary: "较早建立的入口", progress: "后来再次活跃", trail: [] }, ops: [],
    });
    await runtime.applyRoll(transcriptMeta("newer", process.cwd()), {
      mainline: "稳定时间线", ask: { kind: "none", hint: "" },
      snapshot: { summary: "较新建立的入口", progress: "保持固定位置", trail: [] }, ops: [],
    });
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    await store.update((state) => {
      state.sessions.older!.firstSeenAt = "2026-07-19T10:00:00.000Z";
      state.sessions.older!.lastTranscriptAt = "2026-07-19T11:59:30.000Z";
      state.sessions.newer!.firstSeenAt = "2026-07-19T11:00:00.000Z";
      state.sessions.newer!.lastTranscriptAt = "2026-07-19T11:30:00.000Z";
    });

    const markdown = renderMarkdown(store.snapshot(), now);
    const sessions = markdown.split("\n").filter((line) => line.startsWith("  - ") && line.includes('data-kind="session"'));
    expect(sessions[0]).toContain("较新建立的入口");
    expect(sessions[0]).toContain("30 分钟前");
    expect(sessions[1]).toContain("较早建立的入口");
    expect(sessions[1]).toContain("刚刚");
  });

  test("escapes every model-controlled rolling snapshot field", async () => {
    const store = new StateStore(directory());
    await new TreeRuntime(store).applyRoll(transcriptMeta("unsafe-snapshot", process.cwd()), {
      mainline: "安全渲染",
      ask: { kind: "none", hint: "" },
      snapshot: {
        summary: "[标题](javascript:alert(1))",
        progress: "<img src=x onerror=alert(1)>",
        trail: ["[脉络](javascript:alert(2))"],
      },
      ops: [],
    });
    const markdown = renderMarkdown(store.snapshot());
    expect(markdown).not.toContain("[标题](javascript:");
    expect(markdown).not.toContain("[脉络](javascript:");
    expect(markdown).not.toContain("&#91;脉络&#93;");
    expect(markdown).not.toContain("<img src=x");
    expect(markdown).toContain("&#91;标题&#93;");
    expect(markdown).toContain("&lt;img src=x onerror=alert&#40;1&#41;&gt;");
  });
});

describe("action safety and Orca matching", () => {
  test("validates session ids and quotes resume commands", () => {
    const cwd = directory();
    expect(validSessionId("safe-id_1.2")).toBeTrue();
    expect(validSessionId("bad; rm -rf")).toBeFalse();
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
    const session = sessionRecord("safe-id", cwd);
    expect(resumeCommand(session)).toBe(`cd ${shellQuote(cwd)} && claude --resume 'safe-id'`);
    expect(() => resumeCommand({ ...session, id: "bad;id" })).toThrow("invalid session id");

    const codexHome = "/Users/example/Library/Application Support/orca/codex-runtime-home/home";
    const codex = {
      ...session,
      provider: "codex" as const,
      path: `${codexHome}/sessions/2026/07/19/rollout-safe-id.jsonl`,
    };
    expect(codexHomeForTranscript(codex.path)).toBe(codexHome);
    expect(resumeCommand(codex)).toBe(
      `cd ${shellQuote(cwd)} && env CODEX_HOME=${shellQuote(codexHome)} codex resume -c check_for_update_on_startup=false 'safe-id'`,
    );
    expect(resumeCommand({ ...session, provider: "kimi", path: "/Users/example/.kimi/sessions/hash/safe-id/context.jsonl" }))
      .toBe(`cd ${shellQuote(cwd)} && env KIMI_SHARE_DIR='/Users/example/.kimi' kimi --session 'safe-id'`);
    expect(resumeCommand({ ...session, provider: "grok", path: "/Users/example/.grok/sessions/cwd/safe-id/updates.jsonl" }))
      .toBe(`cd ${shellQuote(cwd)} && env GROK_HOME='/Users/example/.grok' grok --resume 'safe-id'`);
    expect(resumeCommand({ ...session, provider: "minimax", path: "/Users/example/.minimax/sessions/safe-id.json" }))
      .toBe(`cd ${shellQuote(cwd)} && minimax --resume 'safe-id'`);
    expect(codexHomeForTranscript("relative/sessions/2026/rollout.jsonl")).toBeNull();
  });

  test("matches Orca by exact prompt then paneKey to terminal handle", () => {
    const session = sessionRecord("s", "/repo");
    session.lastUser = "same full prompt";
    const snapshot: OrcaSnapshot = {
      available: true,
      agents: [{ paneKey: "tab:leaf", state: "working", agentType: "claude", prompt: "same full prompt", taskTitle: "Other", updatedAt: Date.now(), worktreePath: "/repo" }],
      terminals: [{ handle: "terminal-handle", paneKey: "tab:leaf", title: "Terminal", connected: true, writable: true, worktreePath: "/repo" }],
    };
    expect(matchOrcaSession(session, snapshot).terminal?.handle).toBe("terminal-handle");
    expect(stripSpinner("⠋  Useful title")).toBe("Useful title");

    const remembered = { ...session, terminalHandle: "remembered" };
    const rememberedTerminal = { ...snapshot.terminals[0]!, handle: "remembered", paneKey: "other:pane" };
    expect(matchOrcaSession(remembered, {
      available: true,
      agents: [],
      terminals: [snapshot.terminals[0]!, rememberedTerminal],
    }).terminal?.handle).toBe("remembered");
  });

  test("refuses ambiguous or cross-worktree Orca text matches", () => {
    const session = sessionRecord("s", "/repo");
    session.lastUser = "same prompt";
    session.title = "same title";
    const agent = {
      paneKey: "tab:a",
      state: "working",
      agentType: "claude",
      prompt: "same prompt",
      taskTitle: "same title",
      updatedAt: Date.now(),
      worktreePath: "/repo",
    };
    const terminal = {
      handle: "terminal-a",
      paneKey: "tab:a",
      title: "same title",
      connected: true,
      writable: true,
      worktreePath: "/repo",
    };
    expect(matchOrcaSession(session, {
      available: true,
      agents: [agent, { ...agent, paneKey: "tab:b" }],
      terminals: [terminal, { ...terminal, handle: "terminal-b", paneKey: "tab:b" }],
    })).toEqual({ ambiguous: true });
    expect(matchOrcaSession(session, {
      available: true,
      agents: [{ ...agent, worktreePath: "/other" }],
      terminals: [{ ...terminal, worktreePath: "/other" }],
    }).terminal).toBeUndefined();
  });

  test("remembers a created Orca handle so the next click switches instead of duplicating", async () => {
    const store = new StateStore(directory());
    const session = { ...sessionRecord("orca-session", process.cwd()), provider: "codex" as const };
    await store.update((state) => { state.sessions[session.id] = session; });
    let snapshotCalls = 0;
    const commands: string[][] = [];
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { available: true, agents: [], terminals: [] }
          : {
              available: true,
              agents: [],
              terminals: [{
                handle: "created-handle",
                paneKey: "tab:leaf",
                title: "restored",
                connected: true,
                writable: true,
                worktreePath: session.cwd,
              }],
            };
      },
      runOrcaJson: async (command) => {
        commands.push(command);
        if (command[0] === "terminal" && command[1] === "create") {
          return { terminal: { handle: "created-handle", paneKey: "tab:leaf" } };
        }
        return {};
      },
      readTranscriptProcesses: async () => { throw new Error("process inspection denied"); },
      readProcesses: async () => { throw new Error("process inspection denied"); },
    });
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "orca-resume" });
    expect(store.snapshot().sessions[session.id]?.terminalHandle).toBe("created-handle");
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "orca-switch" });
    expect(commands.filter((command) => command[1] === "create")).toHaveLength(1);
    expect(commands.filter((command) => command[1] === "switch")).toHaveLength(1);
  });

  test("does not switch, send, or resume when Orca text matching is ambiguous", async () => {
    const store = new StateStore(directory());
    const session = sessionRecord("ambiguous-orca", process.cwd());
    session.lastUser = "same prompt";
    await store.update((state) => { state.sessions[session.id] = session; });
    const commands: string[][] = [];
    const agent = {
      paneKey: "tab:a",
      state: "working",
      agentType: "claude",
      prompt: "same prompt",
      taskTitle: "",
      updatedAt: Date.now(),
      worktreePath: session.cwd,
    };
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => ({
        available: true,
        agents: [agent, { ...agent, paneKey: "tab:b" }],
        terminals: [],
      }),
      runOrcaJson: async (command) => { commands.push(command); return {}; },
      readTranscriptProcesses: async () => [],
      readProcesses: async () => [],
      runAppleScript: async () => true,
    });
    const jumped = await actions.jump(session.id);
    expect(jumped).toMatchObject({ ok: false, mode: "error" });
    expect(jumped.message).toContain("停止以免切错");
    const sent = await actions.say(session.id, "不要误发");
    expect(sent).toMatchObject({ ok: false, mode: "manual" });
    expect(commands).toHaveLength(0);
  });

  test("focuses a live session by exact transcript process and TTY without Orca", async () => {
    const store = new StateStore(directory());
    const session = sessionRecord("live-session", process.cwd());
    await store.update((state) => { state.sessions[session.id] = session; });
    const scripts: Array<{ script: string; args: string[] }> = [];
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => ({ available: false, agents: [], terminals: [] }),
      readTranscriptProcesses: async () => [{
        sessionId: session.id,
        provider: session.provider,
        pid: 4242,
        tty: "/dev/ttys007",
        command: "open transcript",
      }],
      readProcesses: async () => [],
      runText: async () => ({ ok: true, text: "ttys007\n" }),
      runAppleScript: async (script, args) => {
        scripts.push({ script, args });
        return true;
      },
    });
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "system-focus" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.args).toEqual(["/dev/ttys007"]);
    expect(scripts[0]?.script).toContain("targetTTY");
  });

  test("uses an exact remembered Orca handle without full discovery", async () => {
    const store = new StateStore(directory());
    const session = { ...sessionRecord("fast-orca", process.cwd()), terminalHandle: "terminal-exact" };
    await store.update((state) => { state.sessions[session.id] = session; });
    const commands: Array<{ args: string[]; timeout?: number }> = [];
    let discoveryCalls = 0;
    const actions = new ActionRouter(store, {
      runOrcaJson: async (args, timeout) => {
        commands.push({ args, ...(timeout === undefined ? {} : { timeout }) });
        return {};
      },
      readOrcaSnapshot: async () => { discoveryCalls += 1; return { available: true, agents: [], terminals: [] }; },
      readTranscriptProcesses: async () => { discoveryCalls += 1; return []; },
      readProcesses: async () => { discoveryCalls += 1; return []; },
    });

    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "orca-switch" });
    expect(commands).toEqual([{
      args: ["terminal", "switch", "--terminal", "terminal-exact"],
      timeout: 1_200,
    }]);
    expect(discoveryCalls).toBe(0);
  });

  test("revalidates a cached PID with one transcript lookup before focusing", async () => {
    const store = new StateStore(directory());
    const session = { ...sessionRecord("fast-system", process.cwd()), pid: 4242 };
    await store.update((state) => { state.sessions[session.id] = session; });
    let discoveryCalls = 0;
    const scripts: string[][] = [];
    const actions = new ActionRouter(store, {
      readTranscriptProcess: async () => ({
        sessionId: session.id,
        provider: session.provider,
        pid: session.pid!,
        tty: "/dev/ttys007",
        command: "open transcript",
      }),
      readOrcaSnapshot: async () => { discoveryCalls += 1; return { available: false, agents: [], terminals: [] }; },
      readTranscriptProcesses: async () => { discoveryCalls += 1; return []; },
      readProcesses: async () => { discoveryCalls += 1; return []; },
      runAppleScript: async (_script, args) => { scripts.push(args); return true; },
    });

    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "system-focus" });
    expect(scripts).toEqual([["/dev/ttys007"]]);
    expect(discoveryCalls).toBe(0);
  });

  test("deduplicates concurrent jumps for the same session in the action layer", async () => {
    const store = new StateStore(directory());
    const session = { ...sessionRecord("one-jump", process.cwd()), terminalHandle: "terminal-exact" };
    await store.update((state) => { state.sessions[session.id] = session; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let switches = 0;
    const actions = new ActionRouter(store, {
      runOrcaJson: async () => { switches += 1; await gate; return {}; },
    });

    const first = actions.jump(session.id);
    const second = actions.jump(session.id);
    expect(second).toBe(first);
    release();
    expect(await first).toMatchObject({ ok: true, mode: "orca-switch" });
    expect(switches).toBe(1);
  });

  test("starts every full-discovery source in parallel after fast paths miss", async () => {
    const store = new StateStore(directory());
    const session = sessionRecord("parallel-discovery", process.cwd());
    await store.update((state) => { state.sessions[session.id] = session; });
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waitForGate = async (name: string) => {
      started.add(name);
      await gate;
    };
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => {
        await waitForGate("orca");
        return { available: false, agents: [], terminals: [] };
      },
      readTranscriptProcesses: async () => { await waitForGate("transcript"); return []; },
      readProcesses: async () => { await waitForGate("processes"); return []; },
      runAppleScript: async () => true,
    });

    const jumped = actions.jump(session.id);
    await Bun.sleep(0);
    expect(started).toEqual(new Set(["orca", "transcript", "processes"]));
    release();
    expect(await jumped).toMatchObject({ ok: true, mode: "system-resume" });
  });

  test("never focuses a stale persisted PID without current session evidence", async () => {
    const store = new StateStore(directory());
    const session = { ...sessionRecord("stale-pid", process.cwd()), pid: 4242 };
    await store.update((state) => { state.sessions[session.id] = session; });
    const scripts: string[] = [];
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => ({ available: false, agents: [], terminals: [] }),
      readTranscriptProcesses: async () => [],
      readProcesses: async () => [{ pid: 4242, tty: "ttys009", command: "/bin/zsh" }],
      runText: async () => ({ ok: true, text: "ttys009\n" }),
      runAppleScript: async (script) => {
        scripts.push(script);
        return true;
      },
    });
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "system-resume" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("shellCommand");
  });

  test("resumes a closed session in Terminal and degrades send to manual without Orca", async () => {
    const store = new StateStore(directory());
    const session = sessionRecord("closed-session", process.cwd());
    await store.update((state) => { state.sessions[session.id] = session; });
    const commands: string[] = [];
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => ({ available: false, agents: [], terminals: [] }),
      readTranscriptProcesses: async () => [],
      readProcesses: async () => [],
      runAppleScript: async (script, args) => {
        if (script.includes("shellCommand")) commands.push(args[0] ?? "");
        return true;
      },
    });
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "system-resume" });
    expect(commands[0]).toContain("claude --resume 'closed-session'");
    const sent = await actions.say(session.id, "继续检查");
    expect(sent).toMatchObject({ ok: false, mode: "manual" });
    expect(sent.message).toContain("手动输入");
  });

  test("continues to system resume when process inspection is unavailable", async () => {
    const store = new StateStore(directory());
    const session = sessionRecord("restricted-process-inspection", process.cwd());
    await store.update((state) => { state.sessions[session.id] = session; });
    const actions = new ActionRouter(store, {
      readOrcaSnapshot: async () => ({ available: false, agents: [], terminals: [] }),
      readTranscriptProcesses: async () => { throw new Error("EPERM"); },
      readProcesses: async () => { throw new Error("EPERM"); },
      runAppleScript: async () => true,
    });
    expect(await actions.jump(session.id)).toMatchObject({ ok: true, mode: "system-resume" });
  });
});

describe("local HTTP security boundary", () => {
  test("creates and reuses a 0600 open-handshake secret", () => {
    const root = directory();
    const first = ensureCapabilityToken(root);
    const second = ensureCapabilityToken(root);
    expect(first.token).toBe(second.token);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(first.token.length).toBeGreaterThanOrEqual(43);
  });

  test("validates loopback origins and JSON media types structurally", () => {
    const target = new URL("http://127.0.0.1:4317/api/archive");
    expect(allowedOrigin("http://localhost:4317", target)).toBeTrue();
    expect(allowedOrigin("http://127.0.0.1:9999", target)).toBeFalse();
    expect(allowedOrigin("https://127.0.0.1:4317", target)).toBeFalse();
    expect(allowedOrigin("http://evil.example:4317", target)).toBeFalse();
    expect(validJsonMediaType("application/json; charset=utf-8")).toBeTrue();
    expect(validJsonMediaType("text/plain")).toBeFalse();
  });

  test("lets any local browser read the same snapshot without tab credentials", async () => {
    const { server } = await runningServer();
    const response = await fetch(`${server.url}/api/snapshot`);
    expect(response.status).toBe(200);
    expect((await response.json()).markdown).toContain("SessionMap");
  });

  test("exposes a minimal loopback health check", async () => {
    const { server } = await runningServer();
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "SessionMap" });
  });

  test("keeps the handshake secret out of the public root and uses a one-time open ticket", async () => {
    const { server, token } = await runningServer();
    const root = await fetch(server.url);
    const html = await root.text();
    expect(html).not.toContain(token);
    expect(html).toContain("sessionmap.open-ticket.v1");
    expect(html).not.toContain("__SESSIONMAP_NONCE__");
    expect(root.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const openTicket = createOpenTicket(token);
    const browserUrl = new URL(server.browserUrl(openTicket.ticket));
    expect(browserUrl.hash).toBe(`#open=${openTicket.ticket}`);
    expect(browserUrl.hash).not.toContain(token);
    expect(browserUrl.search).toBe("");
    const version = server.assets.version();
    expect(html).toContain(`/assets/app.js?v=${version}`);
    expect(html).toContain(`/assets/styles.css?v=${version}`);
    const unversionedAsset = await fetch(`${server.url}/assets/app.js`);
    expect(unversionedAsset.status).toBe(200);
    expect(unversionedAsset.headers.get("cache-control")).toBe("no-store");
    const versionedAsset = await fetch(`${server.url}/assets/app.js?v=${version}`);
    expect(versionedAsset.status).toBe(200);
    expect(versionedAsset.headers.get("cache-control")).toContain("immutable");
    const styles = await (await fetch(`${server.url}/assets/styles.css?v=${version}`)).text();
    expect(styles).toContain(`archive.svg?v=${version}`);
    expect(styles).not.toContain("__SESSIONMAP_ASSET_VERSION__");
    expect((await fetch(`${server.url}/assets/unknown.js`)).status).toBe(404);
    const manifest = await fetch(`${server.url}/assets/manifest.webmanifest?v=${version}`);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    const manifestBody = await manifest.json();
    expect(manifestBody.display).toBe("standalone");
    expect(manifestBody.icons[0].src).toContain(`?v=${version}`);
    expect((await fetch(`${server.url}/assets/sessionmap-icon.svg?v=${version}`)).headers.get("cache-control"))
      .toContain("immutable");
  });

  test("exchanges an open ticket once and acknowledges the first rendered frame", async () => {
    const { server, token } = await runningServer();
    const openTicket = createOpenTicket(token);
    const statusHeaders = {
      "X-SessionMap-Token": token,
      "X-SessionMap-Open-Ticket": openTicket.ticket,
    };
    const initial = await fetch(`${server.url}/api/open/status`, { headers: statusHeaders });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ openId: openTicket.id, ready: false });

    const exchangeHeaders = { Origin: server.url, "Content-Type": "application/json" };
    const exchanged = await fetch(`${server.url}/api/open/exchange`, {
      method: "POST",
      headers: exchangeHeaders,
      body: JSON.stringify({ ticket: openTicket.ticket }),
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toEqual({ openId: openTicket.id, expiresAt: openTicket.expiresAt });
    expect((await fetch(`${server.url}/api/open/exchange`, {
      method: "POST",
      headers: exchangeHeaders,
      body: JSON.stringify({ ticket: openTicket.ticket }),
    })).status).toBe(409);

    const ready = await fetch(`${server.url}/api/open/ready`, {
      method: "POST",
      headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify({ openId: openTicket.id }),
    });
    expect(ready.status).toBe(200);
    expect(await (await fetch(`${server.url}/api/open/status`, { headers: statusHeaders })).json()).toMatchObject({ ready: true });
  });

  test("rejects forged open tickets and cross-origin exchange", async () => {
    const { server, token } = await runningServer();
    const openTicket = createOpenTicket(token);
    const forged = `${openTicket.ticket.slice(0, -1)}x`;
    expect((await fetch(`${server.url}/api/open/status`, {
      headers: { "X-SessionMap-Token": token, "X-SessionMap-Open-Ticket": forged },
    })).status).toBe(401);
    expect((await fetch(`${server.url}/api/open/exchange`, {
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: openTicket.ticket }),
    })).status).toBe(403);
  });

  test("keeps the CLI open-status endpoint protected by the handshake secret", async () => {
    const { server, token } = await runningServer();
    const openTicket = createOpenTicket(token);
    expect((await fetch(`${server.url}/api/open/status`, {
      headers: { "X-SessionMap-Open-Ticket": openTicket.ticket },
    })).status).toBe(401);
  });

  test("rejects evil origins, wrong media types, and non-object JSON", async () => {
    const { server } = await runningServer();
    const evil = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(evil.status).toBe(403);
    const wrongType = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { Origin: server.url, "Content-Type": "text/plain" }, body: "{}" });
    expect(wrongType.status).toBe(415);
    const array = await fetch(`${server.url}/api/archive`, { method: "POST", headers: { Origin: server.url, "Content-Type": "application/json" }, body: "[]" });
    expect(array.status).toBe(400);
  });

  test("archives and restores through a same-origin local click-equivalent POST", async () => {
    const fixture = await runningServer(true);
    const headers = { Origin: fixture.server.url, "Content-Type": "application/json" };
    const archived = await fetch(`${fixture.server.url}/api/archive`, { method: "POST", headers, body: JSON.stringify({ rootId: fixture.rootId }) });
    expect(archived.status).toBe(200);
    expect(fixture.store.snapshot().archived).toContain(fixture.rootId);
    const restored = await fetch(`${fixture.server.url}/api/restore`, { method: "POST", headers, body: JSON.stringify({ rootId: fixture.rootId }) });
    expect(restored.status).toBe(200);
    expect(fixture.store.snapshot().archived).not.toContain(fixture.rootId);
  });

  test("deletes a session through a same-origin explicit action and prevents re-import", async () => {
    const fixture = await runningServer(true);
    const headers = { Origin: fixture.server.url, "Content-Type": "application/json" };
    const response = await fetch(`${fixture.server.url}/api/session/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "api-session" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, removedRoot: true });
    expect(fixture.store.snapshot().sessions["api-session"]).toBeUndefined();
    expect(fixture.store.snapshot().excludedSessions["claude:api-session"]).toBeString();
  });

  test("exposes history choice and manual check through same-origin intake APIs", async () => {
    const fixture = await runningServer();
    const initial = await (await fetch(`${fixture.server.url}/api/snapshot`)).json();
    expect(initial.intake.phase).toBe("awaiting-choice");
    const headers = { Origin: fixture.server.url, "Content-Type": "application/json" };

    const checked = await fetch(`${fixture.server.url}/api/intake/check`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(checked.status).toBe(200);
    expect((await checked.json()).lastDiscoveryAt).toBeString();

    const skipped = await fetch(`${fixture.server.url}/api/intake/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cutoffAt: null }),
    });
    expect(skipped.status).toBe(200);
    expect((await skipped.json()).phase).toBe("complete");
    expect(fixture.store.snapshot().intake.phase).toBe("complete");
  });
});

async function runningServer(withMainline = false): Promise<{
  server: SessionMapHttpServer;
  token: string;
  store: StateStore;
  rootId: string;
}> {
  const root = directory();
  const store = new StateStore(root);
  const runtime = new TreeRuntime(store);
  let rootId = "";
  if (withMainline) {
    rootId = (await runtime.applyRoll(transcriptMeta("api-session", root), { mainline: "API work", ask: { kind: "none", hint: "" }, ops: [] })).rootId;
  }
  const monitor = new SessionMonitor(store);
  const watcher = new TranscriptWatcher(
    store,
    runtime,
    root,
    undefined,
    async () => ({ mainline: "unused", ask: { kind: "none", hint: "" }, ops: [] }),
    () => [],
  );
  const server = new SessionMapHttpServer({
    store,
    runtime,
    actions: new ActionRouter(store),
    monitor,
    watcher,
    assets: new AssetStore(),
  }, { stateDirectory: root, port: 0 });
  servers.push(server);
  return { server, token: server.token, store, rootId };
}
