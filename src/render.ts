import type { NowItem, SessionRecord, TrailNode, TrailState } from "./types.ts";
import { escapeHtml, escapeMarkdown, relativeTime } from "./utils.ts";

type RenderContext = {
  state: TrailState;
  now: number;
  lines: string[];
  sessionsByCursor: Map<string, SessionRecord[]>;
};

function nodeAge(node: TrailNode, now: number): number {
  const updated = Date.parse(node.updatedAt);
  return Number.isFinite(updated) ? Math.max(0, now - updated) : Number.POSITIVE_INFINITY;
}

function freshness(node: TrailNode, now: number): string {
  const age = nodeAge(node, now);
  if (age <= 5 * 60_000) return '<span class="fresh fresh-5" aria-label="5 分钟内有变化"></span>';
  if (age <= 15 * 60_000) return '<span class="fresh fresh-15" aria-label="15 分钟内有变化"></span>';
  return "";
}

function icon(name: string, label: string): string {
  return `<span class="icon icon-${name}" role="img" aria-label="${escapeHtml(label)}"></span>`;
}

function rootSessions(state: TrailState, rootId: string): SessionRecord[] {
  return Object.values(state.sessions)
    .filter((session) => session.rootId === rootId)
    .sort((left, right) => Date.parse(right.lastTranscriptAt) - Date.parse(left.lastTranscriptAt));
}

function primarySession(sessions: SessionRecord[]): SessionRecord | undefined {
  return [...sessions].sort((left, right) => {
    const leftLive = left.terminalOpen ? 1 : 0;
    const rightLive = right.terminalOpen ? 1 : 0;
    if (leftLive !== rightLive) return rightLive - leftLive;
    return Date.parse(right.lastTranscriptAt) - Date.parse(left.lastTranscriptAt);
  })[0];
}

function countBlockers(state: TrailState, rootId: string): number {
  const stack = [rootId];
  const seen = new Set<string>();
  let count = 0;
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) continue;
    if (node.state === "waiting" || (node.type === "blocker" && node.state === "active")) count += 1;
    stack.push(...node.children);
  }
  return count;
}

function mainlineState(state: TrailState, rootId: string, sessions: SessionRecord[], now: number): {
  className: string;
  label: string;
  iconName?: string;
} {
  if (sessions.some((session) => session.ask.kind === "decision")) {
    return { className: "state-decision", label: "等拍板", iconName: "circle-alert" };
  }
  if (sessions.some((session) => session.ask.kind === "reply" || session.ask.kind === "review")) {
    return { className: "state-waiting", label: "等你回话", iconName: "message-circle" };
  }
  const blockers = countBlockers(state, rootId);
  if (blockers) return { className: "state-blocked", label: `${blockers} 个卡点`, iconName: "circle-alert" };
  if (sessions.some((session) => session.status === "busy")) {
    return { className: "state-busy", label: "运行中" };
  }
  if (sessions.length && sessions.every((session) => session.status === "closed")) {
    return { className: "state-closed", label: "终端已关", iconName: "moon" };
  }
  const root = state.nodes[rootId];
  if (root && nodeAge(root, now) > 24 * 60 * 60_000) {
    return { className: "state-sleeping", label: `沉睡 · ${relativeTime(root.updatedAt, now)}` };
  }
  if (sessions.some((session) => session.status === "recent")) {
    return { className: "state-recent", label: "刚跑完" };
  }
  return { className: "state-idle", label: "闲置" };
}

function cursorMarkup(session: SessionRecord, multiple: boolean): string {
  const statusClass = `session-${session.status}`;
  const title = escapeHtml(`${session.provider} · ${session.title}`);
  if (!multiple) {
    return `<span class="cursor cursor-single ${statusClass}" data-action="jump" data-session-id="${escapeHtml(session.id)}" title="${title}">${icon(session.status === "closed" ? "moon" : "crosshair", session.status === "closed" ? "终端已关，点击复活" : "当前 session")}</span>`;
  }
  return `<span class="fm-line cursor cursor-multi ${statusClass}" data-kind="session" data-action="jump" data-session-id="${escapeHtml(session.id)}">${icon(session.status === "closed" ? "moon" : "crosshair", session.status === "closed" ? "终端已关" : "session 光标")}<span class="cursor-title">${escapeMarkdown(session.title)}</span><span class="cursor-provider">${escapeMarkdown(session.provider)}</span></span>`;
}

function nodeClass(node: TrailNode): string {
  if (node.state === "dead") return "node-dead";
  if (node.state === "resolved") return "node-resolved";
  if (node.state === "waiting" || node.type === "blocker") return "node-blocked";
  return "node-active";
}

function renderNode(ctx: RenderContext, nodeId: string, depth: number, forced = false): void {
  const node = ctx.state.nodes[nodeId];
  if (!node) return;
  const cursorSessions = ctx.sessionsByCursor.get(nodeId) ?? [];
  const hasStructuralChildren = node.children.length > 0;
  const action = hasStructuralChildren ? "toggle" : cursorSessions.length ? "jump" : "none";
  const primary = primarySession(cursorSessions);
  const note = node.blockedNote ?? node.note;
  const dataSession = primary ? ` data-session-id="${escapeHtml(primary.id)}"` : "";
  const line = [
    `${"  ".repeat(depth)}- <span class="fm-line fm-node ${nodeClass(node)}" data-kind="node" data-node-id="${escapeHtml(node.id)}" data-action="${action}"${dataSession}>`,
    `<span class="type-mark type-${escapeHtml(node.type)}" aria-hidden="true"></span>`,
    `<span class="node-label">${escapeMarkdown(node.label)}</span>`,
    freshness(node, ctx.now),
    note ? `<span class="node-note">${escapeMarkdown(note)}</span>` : "",
    cursorSessions.length === 1 ? cursorMarkup(cursorSessions[0]!, false) : "",
    "</span>",
  ].join("");
  ctx.lines.push(line);

  const closedLeaves = node.children.filter((childId) => {
    const child = ctx.state.nodes[childId];
    return child && child.children.length === 0 &&
      (child.state === "resolved" || child.state === "dead") &&
      !(ctx.sessionsByCursor.get(childId)?.length);
  });
  const grouped = !forced && closedLeaves.length >= 3 ? new Set(closedLeaves) : new Set<string>();
  for (const child of node.children) if (!grouped.has(child)) renderNode(ctx, child, depth + 1);

  if (grouped.size) {
    const done = closedLeaves.filter((id) => ctx.state.nodes[id]?.state === "resolved").length;
    const dead = closedLeaves.filter((id) => ctx.state.nodes[id]?.state === "dead").length;
    const historyId = `history:${node.id}`;
    ctx.lines.push(
      `${"  ".repeat(depth + 1)}- <span class="fm-line history-node" data-kind="history" data-node-id="${escapeHtml(historyId)}" data-default-fold="true" data-action="toggle">${icon("archive", "历史")}<span>历史：已完成 ${done} · 死路 ${dead}</span></span>`,
    );
    for (const child of closedLeaves) renderNode(ctx, child, depth + 2, true);
  }

  if (cursorSessions.length > 1) {
    for (const session of cursorSessions) {
      ctx.lines.push(`${"  ".repeat(depth + 1)}- ${cursorMarkup(session, true)}`);
    }
  }
}

export function renderMarkdown(state: TrailState, now = Date.now()): string {
  const lines = ['# <span class="map-root" data-node-id="maintrail-root">Maintrail</span>'];
  const sessionsByCursor = new Map<string, SessionRecord[]>();
  for (const session of Object.values(state.sessions)) {
    if (!session.cursor) continue;
    const values = sessionsByCursor.get(session.cursor) ?? [];
    values.push(session);
    sessionsByCursor.set(session.cursor, values);
  }
  const roots = state.roots
    .filter((rootId) => !state.archived.includes(rootId))
    .sort((left, right) => Date.parse(state.nodes[right]?.updatedAt ?? "") - Date.parse(state.nodes[left]?.updatedAt ?? ""));
  const ctx: RenderContext = { state, now, lines, sessionsByCursor };
  for (const rootId of roots) {
    const root = state.nodes[rootId];
    if (!root) continue;
    const sessions = rootSessions(state, rootId);
    const primary = primarySession(sessions);
    const status = mainlineState(state, rootId, sessions, now);
    const sessionAttr = primary ? ` data-session-id="${escapeHtml(primary.id)}"` : "";
    const statusIcon = status.iconName
      ? icon(status.iconName, status.label)
      : status.className === "state-busy"
        ? '<span class="busy-dot" aria-label="运行中"></span>'
        : '<span class="state-dot" aria-hidden="true"></span>';
    lines.push(
      `- <span class="fm-line fm-mainline ${status.className}" data-kind="mainline" data-node-id="${escapeHtml(rootId)}" data-root-id="${escapeHtml(rootId)}" data-action="jump"${sessionAttr}>${statusIcon}<span class="mainline-label">${escapeMarkdown(root.label)}</span>${freshness(root, now)}<span class="state-word">${escapeMarkdown(status.label)}</span></span>`,
    );
    const closedRootLeaves = root.children.filter((childId) => {
      const child = state.nodes[childId];
      return child && child.children.length === 0 &&
        (child.state === "resolved" || child.state === "dead") &&
        !(sessionsByCursor.get(childId)?.length);
    });
    const groupedRootLeaves = closedRootLeaves.length >= 3 ? new Set(closedRootLeaves) : new Set<string>();
    for (const child of root.children) if (!groupedRootLeaves.has(child)) renderNode(ctx, child, 1);
    if (groupedRootLeaves.size) {
      const done = closedRootLeaves.filter((id) => state.nodes[id]?.state === "resolved").length;
      const dead = closedRootLeaves.filter((id) => state.nodes[id]?.state === "dead").length;
      lines.push(
        `  - <span class="fm-line history-node" data-kind="history" data-node-id="${escapeHtml(`history:${root.id}`)}" data-default-fold="true" data-action="toggle">${icon("archive", "历史")}<span>历史：已完成 ${done} · 死路 ${dead}</span></span>`,
      );
      for (const child of closedRootLeaves) renderNode(ctx, child, 2, true);
    }
    const rootCursorSessions = sessionsByCursor.get(rootId) ?? [];
    if (rootCursorSessions.length > 1) {
      for (const session of rootCursorSessions) lines.push(`  - ${cursorMarkup(session, true)}`);
    }
  }
  if (!roots.length) {
    lines.push('- <span class="empty-map">等待 Claude Code / Codex 产生第一条结构变化</span>');
  }
  return lines.join("\n");
}

export function buildNowItems(state: TrailState, now = Date.now()): NowItem[] {
  const items: Array<NowItem & { priority: number }> = [];
  for (const session of Object.values(state.sessions)) {
    if (!session.mainline) continue;
    if (session.ask.kind === "decision") {
      items.push({
        kind: "decision",
        label: "等拍板",
        detail: session.ask.hint || session.title,
        mainline: session.mainline,
        sessionId: session.id,
        at: session.updatedAt,
        priority: 0,
      });
    } else if (session.ask.kind === "reply" || session.ask.kind === "review") {
      items.push({
        kind: "reply",
        label: session.ask.kind === "review" ? "等你审阅" : "等你回话",
        detail: session.ask.hint || session.title,
        mainline: session.mainline,
        sessionId: session.id,
        at: session.updatedAt,
        priority: 1,
      });
    }
  }
  for (const rootId of state.roots) {
    if (state.archived.includes(rootId)) continue;
    const root = state.nodes[rootId];
    if (!root) continue;
    const blockers = countBlockers(state, rootId);
    const sessions = rootSessions(state, rootId);
    const session = primarySession(sessions);
    if (blockers) {
      items.push({
        kind: "blocker",
        label: `${blockers} 个卡点`,
        detail: root.label,
        mainline: root.label,
        ...(session ? { sessionId: session.id } : {}),
        at: root.updatedAt,
        priority: 2,
      });
    } else if (sessions.some((candidate) => candidate.status === "busy")) {
      items.push({
        kind: "busy",
        label: "运行中",
        detail: root.label,
        mainline: root.label,
        ...(session ? { sessionId: session.id } : {}),
        at: session?.lastTranscriptAt ?? root.updatedAt,
        priority: 3,
      });
    } else if (sessions.some((candidate) => candidate.status === "recent") && nodeAge(root, now) <= 10 * 60_000) {
      items.push({
        kind: "recent",
        label: "刚跑完",
        detail: root.label,
        mainline: root.label,
        ...(session ? { sessionId: session.id } : {}),
        at: session?.lastTranscriptAt ?? root.updatedAt,
        priority: 4,
      });
    }
  }
  items.sort((left, right) => left.priority - right.priority || Date.parse(right.at) - Date.parse(left.at));
  return items.slice(0, 7).map(({ priority: _priority, ...item }) => item);
}

export function activeSessionCount(state: TrailState): number {
  return Object.values(state.sessions).filter((session) => session.terminalOpen && session.status !== "closed").length;
}
