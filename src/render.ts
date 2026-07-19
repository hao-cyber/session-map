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

function thoughtStats(state: TrailState, rootId: string): { nodes: number; dead: number } {
  const stack = [...(state.nodes[rootId]?.children ?? [])];
  const seen = new Set<string>();
  let dead = 0;
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    const node = state.nodes[id];
    if (!node) continue;
    seen.add(id);
    if (node.state === "dead") dead += 1;
    stack.push(...node.children);
  }
  return { nodes: seen.size, dead };
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
  const title = escapeMarkdown(`${session.provider} · ${session.title}`);
  if (!multiple) {
    return `<span class="cursor cursor-single ${statusClass}" data-action="jump" data-session-id="${escapeHtml(session.id)}" title="${title}">${icon(session.status === "closed" ? "moon" : "crosshair", session.status === "closed" ? "终端已关，点击复活" : "当前 session")}</span>`;
  }
  return `<span class="fm-line cursor cursor-multi ${statusClass}" data-kind="session" data-action="jump" data-session-id="${escapeHtml(session.id)}">${icon(session.status === "closed" ? "moon" : "crosshair", session.status === "closed" ? "终端已关" : "session 光标")}<span class="cursor-title">${escapeMarkdown(session.title)}</span><span class="cursor-provider">${escapeMarkdown(session.provider)}</span></span>`;
}

function sessionState(session: SessionRecord): { label: string; className: string; iconName?: string } {
  if (session.ask.kind === "decision") {
    return { label: "等拍板", className: "session-decision", iconName: "circle-alert" };
  }
  if (session.ask.kind === "review") {
    return { label: "等你审阅", className: "session-waiting", iconName: "message-circle" };
  }
  if (session.ask.kind === "reply") {
    return { label: "等你回话", className: "session-waiting", iconName: "message-circle" };
  }
  if (session.status === "closed") {
    return { label: "终端已关", className: "session-closed", iconName: "moon" };
  }
  if (session.status === "busy") return { label: "运行中", className: "session-busy" };
  if (session.status === "recent") return { label: "刚跑完", className: "session-recent" };
  return { label: session.status === "idle" ? "闲置" : "状态未知", className: "session-idle" };
}

function sessionPresentationId(session: SessionRecord): string {
  return `session:${session.provider}:${session.id}`;
}

function topicSessionMarkup(state: TrailState, session: SessionRecord): string {
  const status = sessionState(session);
  const statusIcon = status.iconName
    ? icon(status.iconName, status.label)
    : status.className === "session-busy"
      ? '<span class="busy-dot" aria-label="运行中"></span>'
      : '<span class="state-dot" aria-hidden="true"></span>';
  const snapshot = session.snapshot;
  const cursorLabel = session.cursor ? state.nodes[session.cursor]?.label : undefined;
  const progress = snapshot.progress || cursorLabel || "等待结构性进展";
  const trailCount = snapshot.trail.length;
  const jumpLabel = session.status === "closed" ? "恢复" : "回到终端";
  const pendingLabel = session.status === "closed" ? "恢复中…" : "回到中…";
  const actionHint = trailCount ? `单击展开脉络 · 双击${jumpLabel}` : `双击${jumpLabel}`;
  return [
    `<span class="fm-line fm-session ${status.className}" data-kind="session" data-node-id="${escapeHtml(sessionPresentationId(session))}"${trailCount ? ' data-default-fold="true"' : ""} data-action="session" data-session-id="${escapeHtml(session.id)}" title="${escapeMarkdown(`${session.provider} · ${session.title} · ${actionHint}`)}">`,
    statusIcon,
    '<span class="session-copy">',
    `<span class="session-title">${escapeMarkdown(snapshot.summary || session.title)}</span>`,
    `<span class="session-progress">${escapeMarkdown(progress)}</span>`,
    "</span>",
    '<span class="session-meta">',
    `<span class="session-provider">${escapeMarkdown(session.provider)}</span>`,
    `<span class="session-state-word">${escapeMarkdown(status.label)}</span>`,
    "</span>",
    trailCount
      ? `<button type="button" class="session-context-toggle" data-inline-action="toggle-context" aria-label="展开 ${trailCount} 条 session 脉络">脉络 ${trailCount}</button>`
      : "",
    `<button type="button" class="session-jump-action" data-inline-action="jump-session" data-idle-label="${jumpLabel}" data-pending-label="${pendingLabel}" aria-label="${jumpLabel} ${escapeMarkdown(snapshot.summary || session.title)}">${jumpLabel}</button>`,
    "</span>",
  ].join("");
}

function thoughtSummaryMarkup(state: TrailState, rootId: string, sessions: SessionRecord[]): string {
  const stats = thoughtStats(state, rootId);
  const focus = primarySession(sessions)?.cursor;
  const focusLabel = focus ? state.nodes[focus]?.label : undefined;
  return [
    `<span class="fm-line thought-summary" data-kind="thoughts" data-node-id="thoughts:${escapeHtml(rootId)}" data-default-fold="true" data-action="toggle">`,
    icon("crosshair", "主题全貌"),
    '<span class="thought-kicker">主题全貌</span>',
    `<span class="thought-focus">${focusLabel ? `当前：${escapeMarkdown(focusLabel)}` : `${stats.nodes} 个结构节点`}</span>`,
    stats.dead ? `<span class="thought-meta">死路 ${stats.dead}</span>` : "",
    "</span>",
  ].join("");
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

}

export function renderMarkdown(state: TrailState, now = Date.now()): string {
  const lines = ['# <span class="map-root" data-node-id="sessionmap-root">SessionMap</span>'];
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
    // Topic and session form the stable two-level navigation hierarchy. One
    // synthetic summary keeps the shared cross-session thought tree out of the
    // navigation layer while preserving progressive disclosure.
    for (const session of sessions) {
      lines.push(`  - ${topicSessionMarkup(state, session)}`);
      for (const [index, breadcrumb] of session.snapshot.trail.entries()) {
        lines.push(
          `    - <span class="fm-line snapshot-trail" data-kind="snapshot" data-node-id="snapshot:${escapeHtml(session.provider)}:${escapeHtml(session.id)}:${index}"><span class="type-mark type-note" aria-hidden="true"></span><span>${escapeMarkdown(breadcrumb)}</span></span>`,
        );
      }
    }
    lines.push(`  - ${thoughtSummaryMarkup(state, rootId, sessions)}`);
    const closedRootLeaves = root.children.filter((childId) => {
      const child = state.nodes[childId];
      return child && child.children.length === 0 &&
        (child.state === "resolved" || child.state === "dead") &&
        !(sessionsByCursor.get(childId)?.length);
    });
    const groupedRootLeaves = closedRootLeaves.length >= 3 ? new Set(closedRootLeaves) : new Set<string>();
    for (const child of root.children) if (!groupedRootLeaves.has(child)) renderNode(ctx, child, 2);
    if (groupedRootLeaves.size) {
      const done = closedRootLeaves.filter((id) => state.nodes[id]?.state === "resolved").length;
      const dead = closedRootLeaves.filter((id) => state.nodes[id]?.state === "dead").length;
      lines.push(
        `    - <span class="fm-line history-node" data-kind="history" data-node-id="${escapeHtml(`history:${root.id}`)}" data-default-fold="true" data-action="toggle">${icon("archive", "历史")}<span>历史：已完成 ${done} · 死路 ${dead}</span></span>`,
      );
      for (const child of closedRootLeaves) renderNode(ctx, child, 3, true);
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
    if (!session.mainline || !session.rootId || state.archived.includes(session.rootId)) continue;
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
