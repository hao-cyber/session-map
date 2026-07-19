import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byteLength } from "../src/utils.ts";
import { GIANT_LINE_BYTES, MAX_DELTA_BYTES, MAX_READ_BYTES, ROLL_SENTINEL } from "../src/constants.ts";
import { providerForPath, readTranscriptDelta, stripInjectedPrefixes } from "../src/adapters.ts";
import { buildRollPrompt, extractRollOutput } from "../src/roll.ts";
import { StateStore } from "../src/state.ts";
import { TreeRuntime } from "../src/tree.ts";
import { cleanup, temporaryDirectory, transcriptMeta, writeJsonLines } from "./helpers.ts";

const directories: string[] = [];
function fixture(name = "session.jsonl"): { root: string; path: string } {
  const root = temporaryDirectory();
  directories.push(root);
  return { root, path: join(root, name) };
}
afterEach(() => directories.splice(0).forEach(cleanup));

describe("transcript adapters", () => {
  test("keeps Claude user/assistant/error/tool sequence and drops thinking/results", () => {
    const { path } = fixture("claude-id.jsonl");
    writeJsonLines(path, [
      { type: "user", sessionId: "claude-id", cwd: "/work", message: { role: "user", content: "追查真正的转折" } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "我会验证音频路由" },
        { type: "tool_use", name: "Bash", input: { secret: "do not retain" } },
      ] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "huge secret output" }] } },
    ]);
    const delta = readTranscriptDelta(path, "claude");
    expect(delta.meta.sessionId).toBe("claude-id");
    expect(delta.meta.cwd).toBe("/work");
    expect(delta.text).toContain("追查真正的转折");
    expect(delta.text).toContain("我会验证音频路由");
    expect(delta.text).toContain("Bash×1");
    expect(delta.text).toContain("tool_result:error");
    expect(delta.text).not.toContain("secret");
    expect(delta.text).not.toContain("huge secret output");
  });

  test("parses Codex messages and structural tool metadata", () => {
    const { path } = fixture("rollout-2026-id.jsonl");
    writeJsonLines(path, [
      { type: "session_meta", payload: { id: "codex-id", cwd: "/repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "换一条主线" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "发现原假设错误" }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "private" } },
      { type: "response_item", payload: { type: "function_call_output", success: false, output: "private output" } },
    ]);
    const delta = readTranscriptDelta(path, "codex");
    expect(delta.meta.sessionId).toBe("codex-id");
    expect(delta.meta.cwd).toBe("/repo");
    expect(delta.text).toContain("换一条主线");
    expect(delta.text).toContain("exec_command×1");
    expect(delta.text).toContain("tool_result:error");
    expect(delta.text).not.toContain("private output");
  });

  test("parses Kimi context without treating checkpoints or thinking as dialogue", () => {
    const { path } = fixture("context.jsonl");
    writeJsonLines(path, [
      { role: "_system_prompt", content: "private system" },
      { role: "user", content: "继续 Kimi 工作线" },
      { role: "assistant", content: [{ type: "thinking", text: "private thought" }, { type: "text", text: "已完成 Kimi 验证" }, { type: "tool_use", name: "Shell", input: "private" }] },
    ]);
    const delta = readTranscriptDelta(path, "kimi", { sessionId: "kimi-id", cwd: "/repo" });
    expect(delta.meta).toMatchObject({ sessionId: "kimi-id", cwd: "/repo" });
    expect(delta.text).toContain("继续 Kimi 工作线");
    expect(delta.text).toContain("已完成 Kimi 验证");
    expect(delta.text).toContain("Shell×1");
    expect(delta.text).not.toContain("private system");
    expect(delta.text).not.toContain("private thought");
  });

  test("parses Grok authoritative ACP updates and drops raw tool payloads", () => {
    const { path } = fixture("updates.jsonl");
    writeJsonLines(path, [
      { method: "session/update", params: { sessionId: "grok-id", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "继续 Grok 工作线" } } } },
      { method: "session/update", params: { sessionId: "grok-id", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已验证 Grok" } } } },
      { method: "session/update", params: { sessionId: "grok-id", update: { sessionUpdate: "tool_call", title: "Read", rawInput: "private" } } },
      { method: "session/update", params: { sessionId: "grok-id", update: { sessionUpdate: "tool_call_update", status: "failed", rawOutput: "private output" } } },
    ]);
    const delta = readTranscriptDelta(path, "grok", { sessionId: "grok-id", cwd: "/repo" });
    expect(delta.text).toContain("继续 Grok 工作线");
    expect(delta.text).toContain("已验证 Grok");
    expect(delta.text).toContain("Read×1");
    expect(delta.text).toContain("tool_result:error");
    expect(delta.text).not.toContain("private output");
  });

  test("reads bounded MiniMax JSON snapshots as full session sources", () => {
    const { path } = fixture("minimax-id.json");
    writeFileSync(path, JSON.stringify({
      metadata: { id: "minimax-id", workspace: "/repo", title: "MiniMax work" },
      messages: [
        { role: "user", content: [{ type: "text", text: "继续 MiniMax 工作线" }] },
        { role: "assistant", content: [{ type: "text", text: "已验证 snapshot" }, { type: "tool_use", name: "bash", input: "private" }] },
      ],
    }));
    const delta = readTranscriptDelta(path, "minimax", { kind: "snapshot", title: "MiniMax work" });
    expect(delta.meta).toMatchObject({ sessionId: "minimax-id", cwd: "/repo", title: "MiniMax work" });
    expect(delta.nextOffset).toBe(statSync(path).size);
    expect(delta.text).toContain("继续 MiniMax 工作线");
    expect(delta.text).toContain("bash×1");
    expect(delta.text).not.toContain("private");
  });

  test("removes only structural system-injection prefixes", () => {
    expect(stripInjectedPrefixes("<system-reminder>noise</system-reminder>\n真实用户消息")).toBe("真实用户消息");
    expect(stripInjectedPrefixes("用户提到 <system-reminder> 是文本")).toContain("system-reminder");
  });

  test("does not consume an incomplete normal line", () => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify({ type: "user", message: { content: "partial" } }));
    const before = readTranscriptDelta(path, "claude");
    expect(before.nextOffset).toBe(0);
    expect(before.text).toBe("");
    appendFileSync(path, "\n");
    const after = readTranscriptDelta(path, "claude", { offset: before.nextOffset });
    expect(after.text).toContain("partial");
    expect(after.nextOffset).toBe(statSync(path).size);
  });

  test("skips a giant unterminated line and remembers newline recovery", () => {
    const { path } = fixture();
    writeFileSync(path, "x".repeat(GIANT_LINE_BYTES + 10));
    const delta = readTranscriptDelta(path, "claude");
    expect(delta.nextOffset).toBe(statSync(path).size);
    expect(delta.skipUntilNewline).toBeTrue();
    expect(delta.lowSignal).toBeTrue();
  });

  test("skips a giant complete line but accepts the following valid record", () => {
    const { path } = fixture();
    const giant = `"${"x".repeat(GIANT_LINE_BYTES + 1)}"\n`;
    const valid = `${JSON.stringify({ type: "user", sessionId: "s", message: { role: "user", content: "survived" } })}\n`;
    writeFileSync(path, giant + valid);
    const delta = readTranscriptDelta(path, "claude");
    expect(delta.parseErrors).toBeGreaterThanOrEqual(1);
    expect(delta.text).toContain("survived");
  });

  test("caps one source read at four MiB", () => {
    const { path } = fixture();
    writeFileSync(path, `${"x".repeat(MAX_READ_BYTES + 100)}\n`);
    const delta = readTranscriptDelta(path, "claude");
    expect(delta.bytesRead).toBe(MAX_READ_BYTES);
  });

  test("caps filtered deltas at twelve KiB while prioritizing user text", () => {
    const { path } = fixture();
    writeJsonLines(path, [
      { type: "user", sessionId: "s", message: { role: "user", content: `USER-START-${"u".repeat(7_500)}-USER-END` } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `ASSISTANT-START-${"a".repeat(8_000)}-ASSISTANT-END` }] } },
    ]);
    const delta = readTranscriptDelta(path, "claude");
    expect(byteLength(delta.text)).toBeLessThanOrEqual(MAX_DELTA_BYTES);
    expect(delta.text).toContain("USER-START");
    expect(delta.text).toContain("USER-END");
    expect(delta.text).toContain("ASSISTANT-END");
  });

  test("marks SessionMap roll sessions for permanent self-exclusion", () => {
    const { path } = fixture();
    writeJsonLines(path, [{ type: "user", sessionId: "self", message: { role: "user", content: `${ROLL_SENTINEL}\ninternal prompt` } }]);
    expect(readTranscriptDelta(path, "claude").selfGenerated).toBeTrue();
  });

  test("continues excluding pre-rename roll sessions", () => {
    const { path } = fixture();
    writeJsonLines(path, [{ type: "user", sessionId: "legacy-self", message: { role: "user", content: "MAINTRAIL_ROLL_V1_DO_NOT_INGEST" } }]);
    expect(readTranscriptDelta(path, "claude").selfGenerated).toBeTrue();
  });

  test("tolerates malformed JSON and abnormal legal shapes line by line", () => {
    const { path } = fixture();
    writeFileSync(path, `not-json\n[]\n${JSON.stringify({ type: "user", message: { role: "user", content: "valid" } })}\n`);
    const delta = readTranscriptDelta(path, "claude");
    expect(delta.parseErrors).toBe(2);
    expect(delta.text).toContain("valid");
  });

  test("detects only supported transcript path families", () => {
    expect(providerForPath("/Users/a/.claude/projects/x/id.jsonl")).toBe("claude");
    expect(providerForPath("/Users/a/.codex/sessions/2026/01/01/rollout-id.jsonl")).toBe("codex");
    expect(providerForPath("/Users/a/Library/Application Support/orca/codex-runtime-home/home/sessions/2026/01/01/rollout-id.jsonl")).toBe("codex");
    expect(providerForPath("/Users/a/.kimi/sessions/hash/kimi-id/context.jsonl")).toBe("kimi");
    expect(providerForPath("/Users/a/.grok/sessions/cwd/grok-id/updates.jsonl")).toBe("grok");
    expect(providerForPath("/Users/a/.minimax/sessions/minimax-id.json")).toBe("minimax");
    expect(providerForPath("/tmp/random.jsonl")).toBeNull();
  });
});

describe("bounded model boundary", () => {
  test("extracts direct, fenced, and wrapped JSON output", () => {
    const object = {
      mainline: "A",
      ask: { kind: "none", hint: "" },
      snapshot: { summary: "整段主题", progress: "最新进展", trail: ["旧路已证伪"] },
      ops: [],
    };
    expect(extractRollOutput(JSON.stringify(object))?.mainline).toBe("A");
    expect(extractRollOutput(`noise \`\`\`json\n${JSON.stringify(object)}\n\`\`\``)?.mainline).toBe("A");
    const wrapped = extractRollOutput(JSON.stringify({ result: JSON.stringify(object) }));
    expect(wrapped?.mainline).toBe("A");
    expect(wrapped?.snapshot).toEqual(object.snapshot);
    expect(extractRollOutput("no object")).toBeNull();
  });

  test("bounds the subtree and reuses a bounded mainline list in the prompt", async () => {
    const root = fixture().root;
    const store = new StateStore(root);
    const runtime = new TreeRuntime(store);
    const meta = transcriptMeta("s", root);
    await runtime.applyRoll(meta, { mainline: "Existing semantic work", ask: { kind: "none", hint: "" }, ops: [] });
    for (let index = 0; index < 130; index += 1) {
      await runtime.applyRoll(meta, { mainline: "Existing semantic work", ask: { kind: "none", hint: "" }, ops: [{ op: "grow", parent: "mainline", type: "note", label: `事实${index}` }] });
    }
    const state = store.snapshot();
    const prompt = buildRollPrompt(state, state.sessions.s, "d".repeat(MAX_DELTA_BYTES * 2));
    expect(prompt).toContain("Existing semantic work");
    expect(prompt).toContain("subtree truncated by runtime");
    expect(byteLength(prompt)).toBeLessThan(30_000);
    expect(prompt).toContain(ROLL_SENTINEL);
    expect(prompt).toContain("revisable read projection");
    expect(prompt).toContain("Never silently rewrite the path");
  });
});
