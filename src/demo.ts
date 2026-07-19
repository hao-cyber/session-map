import { join } from "node:path";
import type { RollOutput, SessionStatus, TranscriptMeta } from "./types.ts";
import { StateStore, createEmptyState } from "./state.ts";
import { TreeRuntime } from "./tree.ts";

function meta(id: string, provider: "claude" | "codex", cwd: string, title: string, lastUser: string): TranscriptMeta {
  return {
    provider,
    sessionId: id,
    path: join(cwd, `${id}.jsonl`),
    cwd,
    title,
    lastUser,
    mtimeMs: Date.now(),
  };
}

async function apply(runtime: TreeRuntime, transcript: TranscriptMeta, output: RollOutput): Promise<string> {
  const result = await runtime.applyRoll(transcript, output);
  return result.rootId;
}

export async function seedDemo(store: StateStore, runtime: TreeRuntime, cwd = process.cwd()): Promise<void> {
  await store.update((state) => Object.assign(state, createEmptyState()));

  const audio = meta(
    "demo-claude-a",
    "claude",
    cwd,
    "修复手表录音断续",
    "蓝牙音量不是根因，转查系统音频路由",
  );
  const audioRoot = await apply(runtime, audio, {
    mainline: "修复手表录音断续",
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: "定位手表录音断续根因",
      progress: "正在验证蓝牙音量是否影响录音",
      trail: ["目标：稳定手表端录音", "先验证蓝牙音量假设"],
    },
    ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "验证蓝牙音量假设" }],
  });
  let audioCursor = store.snapshot().sessions[audio.sessionId]!.cursor!;
  await apply(runtime, audio, {
    mainline: "修复手表录音断续",
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: "定位手表录音断续根因",
      progress: "音量假设已证伪，转查系统路由",
      trail: ["关闭蓝牙后仍然断续", "因此否定音量根因", "新方向：追踪音频路由切换"],
    },
    ops: [
      { op: "close", node: audioCursor, state: "dead", note: "关闭蓝牙后仍可复现" },
      { op: "grow", parent: "mainline", type: "finding", label: "音量假设已证伪" },
      { op: "grow", parent: "mainline", type: "task", label: "追踪音频路由切换" },
    ],
  });
  audioCursor = store.snapshot().sessions[audio.sessionId]!.cursor!;
  await apply(runtime, audio, {
    mainline: "修复手表录音断续",
    ask: { kind: "review", hint: "审阅路由日志" },
    snapshot: {
      summary: "定位手表录音断续根因",
      progress: "已抓取真机路由日志，等待审阅",
      trail: ["蓝牙音量不是根因", "当前聚焦系统音频路由", "下一步由你审阅真机日志"],
    },
    ops: [{ op: "block", node: audioCursor, note: "等你审阅真机路由日志" }],
  });

  const audioPeer = meta(
    "demo-codex-a",
    "codex",
    cwd,
    "复核录音缓冲策略",
    "继续同一问题，验证 ring buffer 是否放大断续",
  );
  await apply(runtime, audioPeer, {
    mainline: "修复手表录音断续",
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: "复核录音缓冲策略",
      progress: "正在验证 ring buffer 是否放大断续",
      trail: ["同属录音断续主题", "独立复核缓冲区抖动"],
    },
    ops: [{ op: "grow", parent: "mainline", type: "attempt", label: "复核缓冲区抖动" }],
  });

  const release = meta(
    "demo-claude-release",
    "claude",
    cwd,
    "准备 SessionMap 首发",
    "需要决定首发是签名 zip 还是 pkg",
  );
  const releaseRoot = await apply(runtime, release, {
    mainline: "准备 SessionMap 首发",
    ask: { kind: "decision", hint: "选择首发包格式" },
    snapshot: {
      summary: "完成 SessionMap macOS 首发",
      progress: "签名链可用，待决定首发包格式",
      trail: ["目标：Homebrew 安装", "已验证 Developer ID", "当前需选择 app zip 或 pkg"],
    },
    ops: [
      { op: "grow", parent: "mainline", type: "decision", label: "选择首发包格式" },
      { op: "grow", parent: "mainline", type: "task", label: "验证公证凭据链" },
    ],
  });

  const zoom = meta(
    "demo-codex-ui",
    "codex",
    cwd,
    "实现语义缩放",
    "正在校准全景、中景、近景折叠阈值",
  );
  const zoomRoot = await apply(runtime, zoom, {
    mainline: "实现语义缩放",
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: "实现可恢复空间记忆的语义缩放",
      progress: "正在校准全景、中景与近景阈值",
      trail: ["全景只保留主题", "中景显示 session 目录", "近景展开思考脉络"],
    },
    ops: [
      { op: "grow", parent: "mainline", type: "task", label: "校准三级缩放阈值" },
      { op: "grow", parent: "mainline", type: "finding", label: "中心节点需空间补偿" },
    ],
  });

  const adapter = meta(
    "demo-claude-adapter",
    "claude",
    cwd,
    "加固 transcript 过滤",
    "巨行与异常 JSON 已覆盖，保留失败路径作记忆",
  );
  const adapterRoot = await apply(runtime, adapter, {
    mainline: "加固 transcript 过滤",
    ask: { kind: "none", hint: "" },
    snapshot: {
      summary: "把 transcript 压成高信号增量",
      progress: "巨行与异常 JSON 已覆盖",
      trail: ["工具结果正文噪声过高", "用户原文是最强转折信号", "增量硬限制为十二 KB"],
    },
    ops: [
      { op: "grow", parent: "mainline", type: "task", label: "过滤系统注入文本" },
      { op: "grow", parent: "mainline", type: "attempt", label: "整段保留工具结果" },
      { op: "grow", parent: "mainline", type: "finding", label: "用户原文信号最强" },
      { op: "grow", parent: "mainline", type: "task", label: "限制增量十二KB" },
    ],
  });
  const adapterChildren = store.snapshot().nodes[adapterRoot]!.children;
  for (const [index, child] of adapterChildren.entries()) {
    await apply(runtime, adapter, {
      mainline: "加固 transcript 过滤",
      ask: { kind: "none", hint: "" },
      ops: [{
        op: "close",
        node: child!,
        state: index === 1 ? "dead" : "resolved",
        note: index === 1 ? "噪声淹没结构信号" : "回归用例已通过",
      }],
    });
  }

  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await store.update((state) => {
    const statuses: Record<string, SessionStatus> = {
      "demo-claude-a": "idle",
      "demo-codex-a": "closed",
      "demo-claude-release": "idle",
      "demo-codex-ui": "busy",
      "demo-claude-adapter": "recent",
    };
    for (const [id, status] of Object.entries(statuses)) {
      const session = state.sessions[id];
      if (!session) continue;
      session.status = status;
      session.terminalOpen = status !== "closed";
      session.updatedAt = new Date().toISOString();
      session.lastTranscriptAt = status === "recent" ? new Date(Date.now() - 2 * 60_000).toISOString() : session.lastTranscriptAt;
    }
    const sleepy = state.nodes[adapterRoot];
    if (sleepy) sleepy.updatedAt = old;
    // Keep these references visibly used in the demo while retaining stable ordering.
    for (const root of [audioRoot, releaseRoot, zoomRoot]) if (state.nodes[root]) state.nodes[root]!.updatedAt = new Date().toISOString();
  });
}
