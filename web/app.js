(() => {
  "use strict";

  const POLL_MS = 4_000;
  const DRAG_THRESHOLD = 5;
  const openTicketKey = "sessionmap.open-ticket.v1";
  const openIdKey = "sessionmap.open-id.v1";
  const openExpiryKey = "sessionmap.open-expiry.v1";
  const manualFoldKey = "sessionmap.manual-fold.v1";
  const legacyManualFoldKey = "maintrail.manual-fold.v1";
  const topicFoldKey = "sessionmap.topic-fold.v1";

  const mapShell = document.getElementById("map-shell");
  const directory = document.getElementById("directory");
  const attentionIndexList = document.getElementById("attention-index-list");
  const attentionIndexCount = document.getElementById("attention-index-count");
  const topicIndexList = document.getElementById("topic-index-list");
  const topicIndexCount = document.getElementById("topic-index-count");
  const loading = document.getElementById("loading");
  const statusLine = document.getElementById("status-line");
  const checkNowButton = document.getElementById("check-now-button");
  const gitChips = document.getElementById("git-chips");
  const engineSelect = document.getElementById("engine-select");
  const archivedButton = document.getElementById("archived-button");
  const historyButton = document.getElementById("history-button");
  const archivedCount = document.getElementById("archived-count");
  const archiveDrawer = document.getElementById("archive-drawer");
  const archiveList = document.getElementById("archive-list");
  const sayOverlay = document.getElementById("say-overlay");
  const sayForm = document.getElementById("say-form");
  const sayInput = document.getElementById("say-input");
  const sayLabel = document.getElementById("say-label");
  const toastRegion = document.getElementById("toast-region");
  const intakePanel = document.getElementById("intake-panel");
  const intakeChoice = document.getElementById("intake-choice");
  const intakeProgress = document.getElementById("intake-progress");
  const intakeDiscoveryState = document.getElementById("intake-discovery-state");
  const intakeProviderSummary = document.getElementById("intake-provider-summary");
  const intakeRanges = document.getElementById("intake-ranges");
  const intakeCustom = document.getElementById("intake-custom");
  const intakeCustomDate = document.getElementById("intake-custom-date");
  const intakeSessionCount = document.getElementById("intake-session-count");
  const intakeSizeEstimate = document.getElementById("intake-size-estimate");
  const intakeStart = document.getElementById("intake-start");
  const intakeSkip = document.getElementById("intake-skip");
  const intakeRecheck = document.getElementById("intake-recheck");
  const intakeEngineNote = document.getElementById("intake-engine-note");
  const intakeProgressTitle = document.getElementById("intake-progress-title");
  const intakeProgressCopy = document.getElementById("intake-progress-copy");
  const intakeJobState = document.getElementById("intake-job-state");
  const intakeProgressFill = document.getElementById("intake-progress-fill");
  const intakeProgressCount = document.getElementById("intake-progress-count");
  const intakeCurrent = document.getElementById("intake-current");
  const intakePause = document.getElementById("intake-pause");
  const intakeResume = document.getElementById("intake-resume");
  const intakeCancel = document.getElementById("intake-cancel");
  const intakeShowMap = document.getElementById("intake-show-map");

  let transformer;
  let snapshot;
  let seenRevision = -1;
  let seenAssetVersion = String(window.SESSIONMAP_ASSET_VERSION || "");
  let polling = false;
  let saySessionId = "";
  let suppressHash = false;
  let manualFold = loadManualFold();
  let topicFold = loadTopicFold();
  const pendingJumps = new Set();
  let topicIndexFrame = 0;
  let intakeSelection = "30";
  let intakeSelectionTouched = false;
  let intakePanelOpen = false;
  let hiddenImportId = "";
  let intakeBusy = false;
  let previousJobStatus = "";

  function loadManualFold() {
    try {
      let stored = localStorage.getItem(manualFoldKey);
      if (!stored) {
        stored = localStorage.getItem(legacyManualFoldKey);
        if (stored) localStorage.setItem(manualFoldKey, stored);
      }
      const value = JSON.parse(stored || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function saveManualFold() {
    try {
      localStorage.setItem(manualFoldKey, JSON.stringify(manualFold));
    } catch {
      // Local storage can be disabled. The map remains usable for this page life.
    }
  }

  function loadTopicFold() {
    try {
      const value = JSON.parse(localStorage.getItem(topicFoldKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function saveTopicFold() {
    try {
      localStorage.setItem(topicFoldKey, JSON.stringify(topicFold));
    } catch {
      // Local storage can be disabled. The map remains usable for this page life.
    }
  }

  function relativeTime(value) {
    const then = Date.parse(value);
    if (!Number.isFinite(then)) return "刚刚";
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 45) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86_400)} 天前`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return "0 KB";
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function historyEstimate(sessions) {
    if (!sessions) return "无需模型调用";
    if (sessions > 60) return "任务较大 · 建议缩短范围";
    const low = Math.max(1, Math.ceil(sessions / 3));
    const high = Math.max(low + 1, Math.ceil(sessions * 0.75));
    return `约 ${low}–${high} 分钟`;
  }

  async function api(path, init = {}) {
    const headers = new Headers(init.headers || {});
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers,
    });
    let payload = null;
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) payload = await response.json();
    else if (!response.ok) payload = { error: await response.text() };
    if (!response.ok) {
      const error = new Error(payload?.error || payload?.message || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function exchangeOpenTicket() {
    const ticket = window.SESSIONMAP_OPEN_TICKET;
    if (!ticket) return;
    const response = await fetch("/api/open/exchange", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `打开凭据兑换失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (!/^[A-Za-z0-9_-]{24}$/.test(payload?.openId || "") ||
        !Number.isSafeInteger(payload?.expiresAt)) {
      throw new Error("本地服务返回了无效的打开回执");
    }
    window.SESSIONMAP_OPEN_ID = payload.openId;
    window.SESSIONMAP_OPEN_EXPIRY = payload.expiresAt;
    sessionStorage.setItem(openIdKey, payload.openId);
    sessionStorage.setItem(openExpiryKey, String(payload.expiresAt));
  }

  function clearOpenHandshake() {
    sessionStorage.removeItem(openTicketKey);
    sessionStorage.removeItem(openIdKey);
    sessionStorage.removeItem(openExpiryKey);
    window.SESSIONMAP_OPEN_TICKET = "";
    window.SESSIONMAP_OPEN_ID = "";
    window.SESSIONMAP_OPEN_EXPIRY = 0;
  }

  async function acknowledgeOpen() {
    const openId = window.SESSIONMAP_OPEN_ID;
    if (!openId) return;
    try {
      await post("/api/open/ready", { openId });
      clearOpenHandshake();
    } catch (error) {
      // A restart forgets the in-memory open id. The signed ticket remains in
      // sessionStorage only until ready succeeds, so it can re-register once.
      if (error?.status === 404 && window.SESSIONMAP_OPEN_TICKET &&
          Date.now() <= Number(window.SESSIONMAP_OPEN_EXPIRY || 0)) {
        try {
          await exchangeOpenTicket();
          await post("/api/open/ready", { openId: window.SESSIONMAP_OPEN_ID });
          clearOpenHandshake();
          return;
        } catch {}
      }
      if (Date.now() > Number(window.SESSIONMAP_OPEN_EXPIRY || 0)) {
        clearOpenHandshake();
      }
    }
  }

  function toast(message, action) {
    const node = document.createElement("div");
    node.className = "toast";
    const text = document.createElement("span");
    text.textContent = message;
    node.append(text);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", async () => {
        try {
          await action.run();
          node.remove();
          await poll(true);
        } catch (error) {
          toast(error.message || String(error));
        }
      });
      node.append(button);
    }
    toastRegion.append(node);
    window.setTimeout(() => node.remove(), action ? 8_000 : 4_000);
    return node;
  }

  function walk(node, visit, depth = 0) {
    if (!node) return;
    visit(node, depth);
    for (const child of node.children || []) walk(child, visit, depth + 1);
  }

  function contentElement(data) {
    const template = document.createElement("template");
    template.innerHTML = String(data?.content || data?.payload?.content || "").trim();
    return template.content.firstElementChild;
  }

  function directoryAnchor() {
    const box = mapShell.getBoundingClientRect();
    const targetY = box.top + Math.min(96, box.height * 0.2);
    let nearest = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const row of directory.querySelectorAll(".fm-mainline[data-node-id], .fm-session[data-node-id]")) {
      const id = row.dataset.nodeId;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) continue;
      const y = rect.top;
      const next = Math.abs(y - targetY);
      if (next < distance) {
        distance = next;
        nearest = { id, y };
      }
    }
    return nearest;
  }

  function pinDirectoryAnchor(anchor) {
    if (!anchor) return;
    const row = directory.querySelector(`[data-node-id="${CSS.escape(anchor.id)}"]`);
    if (!row) return;
    mapShell.scrollTop += row.getBoundingClientRect().top - anchor.y;
  }

  function decorateRows(scope = directory) {
    for (const row of scope.querySelectorAll(".fm-line")) {
      const action = row.dataset.action;
      if (action === "jump" || action === "toggle" || action === "fold-topic") {
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
      }
    }
    for (const sessionId of pendingJumps) setJumpPending(sessionId, true);
  }

  function buildSession(data) {
    const row = contentElement(data);
    if (!row) return null;
    const entry = document.createElement("article");
    entry.className = "session-entry";
    entry.dataset.nodeId = row.dataset.nodeId || "";
    entry.append(row);
    return entry;
  }

  function buildOverview(data) {
    const row = contentElement(data);
    if (!row) return null;
    const block = document.createElement("section");
    block.className = "topic-overview";
    block.dataset.nodeId = row.dataset.nodeId || "";
    block._overviewData = data;
    const outline = document.createElement("div");
    outline.className = "outline";
    outline.setAttribute("role", "tree");
    outline.setAttribute("aria-label", "主题完整脉络");
    const folded = Object.prototype.hasOwnProperty.call(manualFold, row.dataset.nodeId)
      ? Boolean(manualFold[row.dataset.nodeId])
      : true;
    row.setAttribute("aria-expanded", String(!folded));
    const label = row.querySelector(".thought-kicker");
    if (label) label.textContent = folded ? "脉络" : "收起脉络";
    outline.hidden = folded;
    block.hidden = folded;
    block.append(row, outline);
    if (!folded) buildOutline(outline, data);
    return block;
  }

  function outlineHasCurrent(data) {
    let found = false;
    walk(data, (descendant) => {
      if (found) return;
      const element = contentElement(descendant);
      if (!element) return;
      if (element.classList.contains("node-active") && element.classList.contains("fm-node")) found = true;
      else if (element.classList.contains("cursor")) found = true;
    });
    return found;
  }

  function outlineDefaultFold(data) {
    return !outlineHasCurrent(data);
  }

  function buildOutlineNode(data) {
    const wrap = document.createElement("div");
    wrap.className = "outline-node";
    if (outlineHasCurrent(data)) wrap.classList.add("is-current-path");
    const row = contentElement(data);
    if (!row) return wrap;
    wrap.append(row);
    const children = data.children || [];
    if (!children.length) return wrap;
    row.dataset.hasChildren = "true";
    const id = row.dataset.nodeId;
    const folded = id && Object.prototype.hasOwnProperty.call(manualFold, id)
      ? Boolean(manualFold[id])
      : outlineDefaultFold(data);
    const list = document.createElement("div");
    list.className = "outline-children";
    list.hidden = folded;
    row.setAttribute("aria-expanded", String(!folded));
    row.setAttribute("role", "treeitem");
    for (const child of children) list.append(buildOutlineNode(child));
    wrap.append(list);
    return wrap;
  }

  function buildOutline(container, topic) {
    container.replaceChildren();
    const list = document.createElement("div");
    list.className = "outline-children";
    for (const child of topic.children || []) list.append(buildOutlineNode(child));
    container.append(list);
  }

  function buildTopic(data) {
    const headerRow = contentElement(data);
    if (!headerRow) return null;
    const section = document.createElement("section");
    section.className = "topic-section";
    section.dataset.nodeId = headerRow.dataset.nodeId || "";
    const header = document.createElement("header");
    header.className = "topic-header";
    const headerLayout = document.createElement("div");
    headerLayout.className = "topic-header-layout";
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "topic-fold";
    fold.dataset.inlineAction = "fold-topic";
    fold.setAttribute("aria-label", "折叠或展开 Sessions");
    const foldIcon = document.createElement("span");
    foldIcon.className = "icon icon-chevron-down";
    foldIcon.setAttribute("aria-hidden", "true");
    fold.append(foldIcon);
    headerRow.prepend(fold);
    const foldCount = document.createElement("span");
    foldCount.className = "topic-fold-count";
    const mainlineLabel = headerRow.querySelector(".mainline-label");
    if (mainlineLabel) mainlineLabel.after(foldCount);
    headerLayout.append(headerRow);
    header.append(headerLayout);
    const body = document.createElement("div");
    body.className = "topic-body";
    let overview = null;
    const sessions = document.createElement("section");
    sessions.className = "session-list";
    const sessionHead = document.createElement("div");
    sessionHead.className = "session-list-head";
    const sessionLabel = document.createElement("span");
    sessionLabel.textContent = "Sessions";
    const sessionCount = document.createElement("span");
    sessionCount.className = "session-list-count";
    sessionHead.append(sessionLabel, sessionCount);
    sessions.append(sessionHead);
    for (const child of data.children || []) {
      const preview = contentElement(child);
      const kind = preview?.dataset.kind;
      const element = kind === "session" ? buildSession(child) : kind === "thoughts" ? buildOverview(child) : null;
      if (kind === "thoughts" && element) overview = element;
      else if (kind === "session" && element) sessions.append(element);
    }
    const sessionTotal = sessions.querySelectorAll(":scope > .session-entry").length;
    sessionCount.textContent = String(sessionTotal);
    foldCount.textContent = `· ${sessionTotal} 个 session`;
    if (overview) {
      const lineageAction = overview.querySelector(":scope > .thought-summary");
      if (lineageAction) {
        lineageAction.classList.add("topic-lineage-action");
        headerLayout.append(lineageAction);
      }
      body.append(overview);
    }
    if (sessions.querySelector(".session-entry")) body.append(sessions);
    const topicFolded = Boolean(topicFold[section.dataset.nodeId]);
    section.classList.toggle("is-folded", topicFolded);
    sessions.hidden = topicFolded;
    fold.setAttribute("aria-expanded", String(!topicFolded));
    section.append(header, body);
    return section;
  }

  function toggleTopicFold(section) {
    if (!section) return;
    const sessions = section.querySelector(":scope > .topic-body > .session-list");
    const foldButton = section.querySelector(":scope .topic-header .topic-fold");
    const next = !section.classList.contains("is-folded");
    section.classList.toggle("is-folded", next);
    if (sessions) sessions.hidden = next;
    if (foldButton) foldButton.setAttribute("aria-expanded", String(!next));
    if (next) topicFold[section.dataset.nodeId] = true;
    else delete topicFold[section.dataset.nodeId];
    saveTopicFold();
  }

  function syncTopicIndexSelection() {
    topicIndexFrame = 0;
    const sections = [...directory.querySelectorAll(".topic-section")];
    if (!sections.length) return;
    const shellTop = mapShell.getBoundingClientRect().top;
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= shellTop + 72) active = section;
      else break;
    }
    for (const button of topicIndexList.querySelectorAll("button[data-node-id]")) {
      const selected = button.dataset.nodeId === active?.dataset.nodeId;
      button.classList.toggle("is-current", selected);
      if (selected) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  }

  function scheduleTopicIndexSelection() {
    if (topicIndexFrame) return;
    topicIndexFrame = requestAnimationFrame(syncTopicIndexSelection);
  }

  function scrollToMainline(mainline) {
    const section = [...directory.querySelectorAll(".topic-section")].find((candidate) =>
      candidate.querySelector(".mainline-label")?.textContent?.trim() === mainline
    );
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  function renderTopicIndex() {
    topicIndexList.replaceChildren();
    const sections = [...directory.querySelectorAll(".topic-section")];
    topicIndexCount.textContent = String(sections.length);
    for (const section of sections) {
      const row = section.querySelector(".fm-mainline");
      const label = row?.querySelector(".mainline-label")?.textContent?.trim();
      if (!row || !label) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.nodeId = section.dataset.nodeId || "";
      button.className = [...row.classList].filter((name) => name.startsWith("state-")).join(" ");
      const marker = document.createElement("span");
      marker.className = "topic-index-marker";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "topic-index-copy";
      copy.textContent = label;
      const count = document.createElement("span");
      count.className = "topic-index-sessions";
      const sessionCount = section.querySelectorAll(".session-entry").length;
      count.textContent = String(sessionCount);
      count.hidden = sessionCount === 0;
      button.append(marker, copy, count);
      button.addEventListener("click", () => scrollToMainline(label));
      topicIndexList.append(button);
    }
    syncTopicIndexSelection();
  }

  function renderSessionContexts(workspaces) {
    const byCwd = new Map((workspaces || []).map((item) => [item.cwd, item]));
    for (const row of directory.querySelectorAll(".fm-session[data-cwd]")) {
      const git = byCwd.get(row.dataset.cwd || "");
      const target = row.querySelector(".session-git-context");
      if (!target) continue;
      const cwd = row.querySelector(".session-cwd");
      if (cwd) cwd.textContent = cwd.dataset.directoryLabel || "目录未知";
      target.replaceChildren();
      target.hidden = !git;
      if (!git) continue;
      if (cwd) {
        const relative = row.dataset.cwd === git.worktree
          ? "./"
          : row.dataset.cwd.startsWith(`${git.worktree}/`)
            ? row.dataset.cwd.slice(git.worktree.length + 1)
            : cwd.textContent;
        cwd.textContent = relative;
      }
      const worktree = document.createElement("span");
      worktree.className = "session-worktree";
      worktree.textContent = git.name;
      worktree.title = `worktree · ${git.worktree}`;
      const branch = document.createElement("span");
      branch.className = "session-branch";
      branch.textContent = git.branch || "detached";
      branch.title = `Git 分支 · ${git.branch || "detached"}`;
      target.append(worktree, branch);
    }
  }

  async function renderMap(markdown) {
    const anchor = directoryAnchor();
    const transformed = transformer.transform(markdown);
    directory.replaceChildren();
    for (const topic of transformed.root.children || []) {
      const element = buildTopic(topic);
      if (element) directory.append(element);
    }
    if (!directory.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "empty-map";
      empty.textContent = "等待 Claude Code / Codex 产生第一条结构变化";
      directory.append(empty);
    }
    decorateRows();
    renderTopicIndex();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    pinDirectoryAnchor(anchor);
    loading.hidden = true;
  }

  function renderChrome(data) {
    const job = data.intake?.job;
    statusLine.textContent = job && (job.status === "running" || job.status === "paused")
      ? `历史 ${job.completed}/${job.total} · ${job.status === "paused" ? "已暂停" : `${Math.max(1, job.active || 0)} 路整理中`}`
      : `${data.activeSessions} 个活跃 session · 更新于 ${relativeTime(data.updatedAt)}`;
    renderAttention(data.now || []);
    renderGit(data.git || []);
    renderEngines(data.engines || [], data.engine);
    renderArchives(data.archived || []);
    renderIntake(data.intake, data.engine, data.engines || []);
  }

  function selectedRange(intake) {
    if (intakeSelection === "custom") {
      const value = intakeCustomDate.value;
      const cutoffAt = value ? new Date(`${value}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString();
      const cutoff = Date.parse(cutoffAt);
      const activity = (intake.inventory.activity || []).filter((item) => item.mtimeMs >= cutoff);
      return { cutoffAt, sessions: activity.length, bytes: activity.reduce((sum, item) => sum + item.size, 0) };
    }
    return intake.inventory.ranges.find((item) => String(item.days) === intakeSelection)
      || intake.inventory.ranges.find((item) => item.days === 30)
      || { cutoffAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), sessions: 0, bytes: 0 };
  }

  function renderIntake(intake, engine, engines) {
    if (!intake) return;
    const job = intake.job;
    if (previousJobStatus && previousJobStatus !== "complete" && job?.status === "complete") {
      toast(`历史整理完成 · ${job.completed} 个 session`);
    }
    if (previousJobStatus === "running" && job?.status === "paused") {
      toast("历史整理已暂停 · 可从“历史进度”继续");
    }
    previousJobStatus = job?.status || "";
    historyButton.hidden = intake.phase === "awaiting-choice";
    historyButton.textContent = intake.phase === "importing" ? "历史进度" : "补扫历史";
    const showProgress = intake.phase === "importing" && job && hiddenImportId !== job.id;
    const showChoice = intake.phase === "awaiting-choice" || (intake.phase === "complete" && intakePanelOpen);
    intakePanel.hidden = !showChoice && !showProgress;
    intakeChoice.hidden = !showChoice;
    intakeProgress.hidden = !showProgress;
    if (showChoice) renderIntakeChoice(intake, engine, engines);
    if (showProgress) renderIntakeProgress(job);
  }

  function renderIntakeChoice(intake, engine, engines) {
    const thirtyDay = intake.inventory.ranges?.find((item) => item.days === 30);
    const recommendedDays = (thirtyDay?.sessions || 0) > 20 ? 7 : 30;
    if (!intakeSelectionTouched) intakeSelection = String(recommendedDays);
    intakeDiscoveryState.textContent = intake.lastDiscoveryAt ? `检查于 ${relativeTime(intake.lastDiscoveryAt)}` : "本机发现完成";
    const providers = Object.entries(intake.inventory.providers || {}).filter(([, count]) => count > 0);
    intakeProviderSummary.textContent = providers.length
      ? `${providers.map(([provider, count]) => `${provider} ${count}`).join(" · ")} · 共 ${intake.inventory.total} 个 session`
      : "没有发现可恢复的历史 session；可以直接从下一条对话开始";
    intakeRanges.replaceChildren();
    for (const range of intake.inventory.ranges || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "intake-range";
      button.dataset.days = String(range.days);
      button.setAttribute("aria-pressed", String(intakeSelection === String(range.days)));
      const title = document.createElement("strong");
      title.textContent = `最近 ${range.days} 天`;
      const detail = document.createElement("span");
      detail.textContent = `${range.sessions} 个 session${range.days === recommendedDays ? " · 推荐" : ""}`;
      button.append(title, detail);
      button.addEventListener("click", () => { intakeSelectionTouched = true; intakeSelection = String(range.days); renderIntakeChoice(intake, engine, engines); });
      intakeRanges.append(button);
    }
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "intake-range";
    custom.dataset.days = "custom";
    custom.setAttribute("aria-pressed", String(intakeSelection === "custom"));
    const customTitle = document.createElement("strong");
    customTitle.textContent = "自定义";
    const customDetail = document.createElement("span");
    customDetail.textContent = "选择回溯日期";
    custom.append(customTitle, customDetail);
    custom.addEventListener("click", () => { intakeSelectionTouched = true; intakeSelection = "custom"; renderIntakeChoice(intake, engine, engines); });
    intakeRanges.append(custom);
    intakeCustom.hidden = intakeSelection !== "custom";
    if (!intakeCustomDate.value) {
      const date = new Date(Date.now() - 90 * 86_400_000);
      intakeCustomDate.value = date.toISOString().slice(0, 10);
    }
    const selected = selectedRange(intake);
    intakeSessionCount.textContent = `${selected.sessions} 个 session`;
    intakeSizeEstimate.textContent = `${historyEstimate(selected.sessions)} · ${formatBytes(selected.bytes)}`;
    const availability = engines.find((item) => item.name === engine);
    const engineReady = availability?.available === true;
    intakeStart.textContent = selected.sessions
      ? engineReady ? `开始整理 ${selected.sessions} 个 session` : "先选择可用 Roll 引擎"
      : "进入空地图";
    intakeStart.disabled = intakeBusy || (selected.sessions > 0 && !engineReady);
    intakeSkip.disabled = intakeBusy;
    intakeRecheck.disabled = intakeBusy;
    const reasonLabels = {
      checking: "正在检查",
      "not-installed": "未安装",
      "not-authenticated": "未登录",
      "auth-check-failed": "状态检查失败",
      "recent-failure": "最近调用失败，稍后重试",
    };
    intakeEngineNote.textContent = engineReady
      ? `正文仅交给当前 Roll 引擎 ${engine}`
      : `Roll 引擎 ${engine} ${reasonLabels[availability?.reason] || "不可用"}`;
  }

  function renderIntakeProgress(job) {
    const paused = job.status === "paused";
    intakeProgressTitle.textContent = paused ? "历史整理已暂停" : "正在把近期工作整理成地图";
    intakeProgressCopy.textContent = job.failed
      ? `${job.failed} 个 session 需要重试；已完成的工作线保持可用。`
      : `完成的工作线会立即出现；后台最多 ${job.maxParallel || 2} 路并行，页面关闭后仍继续。`;
    intakeJobState.textContent = paused ? "等待继续" : `${Math.max(1, job.active || 0)} 路并行`;
    const percent = job.total ? Math.round(job.completed / job.total * 100) : 100;
    intakeProgressFill.style.width = `${percent}%`;
    intakeProgressCount.textContent = `${job.completed} / ${job.total}`;
    intakeCurrent.replaceChildren();
    if (job.current) {
      const strong = document.createElement("strong");
      strong.textContent = job.current.title;
      const detail = document.createElement("span");
      detail.textContent = job.current.error
        ? `${job.current.provider} · ${job.current.error}`
        : `${job.current.provider} · ${job.current.sessionId.slice(0, 12)}`;
      intakeCurrent.append(strong, detail);
    } else intakeCurrent.textContent = "正在收口导入状态…";
    intakePause.hidden = paused;
    intakeResume.hidden = !paused;
  }

  function renderAttention(items) {
    const actionable = items.filter((item) => item.kind === "decision" || item.kind === "reply" || item.kind === "blocker");
    attentionIndexCount.textContent = String(actionable.length);
    attentionIndexList.replaceChildren();
    if (!actionable.length) {
      const empty = document.createElement("div");
      empty.className = "attention-empty";
      const icon = document.createElement("span");
      icon.className = "icon icon-check-circle-2";
      const text = document.createElement("span");
      text.textContent = "暂时无需处理";
      empty.append(icon, text);
      attentionIndexList.append(empty);
      return;
    }
    for (const item of actionable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attention-item";
      button.dataset.kind = item.kind;
      if (item.sessionId) button.dataset.sessionId = item.sessionId;
      const marker = document.createElement("span");
      marker.className = "attention-item-marker";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "attention-item-copy";
      const mainline = document.createElement("span");
      mainline.className = "attention-mainline";
      mainline.textContent = item.mainline;
      const detail = document.createElement("span");
      detail.className = "attention-detail";
      detail.textContent = item.detail && item.detail !== item.mainline
        ? `${item.label} · ${item.detail}`
        : item.label;
      const time = document.createElement("time");
      time.className = "attention-time";
      time.textContent = relativeTime(item.at);
      copy.append(mainline, detail);
      button.append(marker, copy, time);
      button.addEventListener("click", () => item.sessionId ? jump(item.sessionId) : scrollToMainline(item.mainline));
      attentionIndexList.append(button);
    }
  }

  function renderGit(chips) {
    gitChips.replaceChildren();
    const seenWorktrees = new Set();
    for (const chip of chips.filter((item) => item.dirty || item.ahead)) {
      if (seenWorktrees.has(chip.worktree)) continue;
      seenWorktrees.add(chip.worktree);
      const element = document.createElement("div");
      element.className = "git-chip";
      element.title = `${chip.worktree}\n${chip.branch || "detached"}`;
      const icon = document.createElement("span");
      icon.className = "icon icon-git-branch";
      const name = document.createElement("span");
      name.textContent = chip.name;
      element.append(icon, name);
      if (chip.dirty) {
        const dirty = document.createElement("b");
        dirty.textContent = `✎${chip.dirty}`;
        element.append(dirty);
      }
      if (chip.ahead) {
        const ahead = document.createElement("b");
        ahead.textContent = `↑${chip.ahead}`;
        element.append(ahead);
      }
      gitChips.append(element);
    }
  }

  function renderEngines(engines, selected) {
    const signature = engines.map((item) => `${item.name}:${item.available}:${item.reason || ""}`).join("|");
    if (engineSelect.dataset.signature !== signature) {
      engineSelect.replaceChildren();
      for (const engine of engines) {
        const option = document.createElement("option");
        option.value = engine.name;
        const reasons = {
          checking: "检查中",
          "not-installed": "未安装",
          "not-authenticated": "未登录",
          "auth-check-failed": "状态检查失败",
          "recent-failure": "最近调用失败",
        };
        option.textContent = engine.available ? engine.name : `${engine.name} · ${reasons[engine.reason] || "不可用"}`;
        option.disabled = !engine.available;
        engineSelect.append(option);
      }
      engineSelect.dataset.signature = signature;
    }
    engineSelect.value = selected;
  }

  function renderArchives(items) {
    archivedButton.hidden = items.length === 0;
    archivedCount.textContent = `已归档 ${items.length}`;
    archiveList.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "archive-row";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.label;
      const meta = document.createElement("span");
      meta.textContent = `${item.sessions} 个 session · ${relativeTime(item.updatedAt)}`;
      copy.append(name, meta);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "恢复";
      restore.addEventListener("click", async () => {
        await post("/api/restore", { rootId: item.id });
        await poll(true);
      });
      row.append(copy, restore);
      archiveList.append(row);
    }
  }

  async function post(path, value) {
    return api(path, { method: "POST", body: JSON.stringify(value) });
  }

  async function intakeAction(path, body = {}, options = {}) {
    if (intakeBusy) return;
    intakeBusy = true;
    for (const button of intakePanel.querySelectorAll("button")) button.disabled = true;
    try {
      const result = await post(path, body);
      if (options.background && result?.job?.id) hiddenImportId = result.job.id;
      await poll(true);
      return result;
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      intakeBusy = false;
      if (snapshot) renderIntake(snapshot.intake, snapshot.engine, snapshot.engines || []);
    }
    return null;
  }

  function setJumpPending(sessionId, pending) {
    const rows = [...directory.querySelectorAll(".fm-line[data-session-id]")]
      .filter((row) => row.dataset.sessionId === sessionId);
    for (const row of rows) {
      row.classList.toggle("is-jumping", pending);
      if (pending) row.setAttribute("aria-busy", "true");
      else row.removeAttribute("aria-busy");
      for (const button of row.querySelectorAll(".session-jump-action")) {
        button.disabled = pending;
        const text = pending
          ? button.dataset.pendingLabel || "正在前往…"
          : button.dataset.idleLabel || "回到终端";
        const label = button.querySelector(".jump-action-label");
        if (label) label.textContent = text;
        else button.textContent = text;
      }
    }
  }

  async function jump(sessionId, fromHash = false) {
    if (!sessionId || pendingJumps.has(sessionId)) return;
    pendingJumps.add(sessionId);
    if (!fromHash) {
      suppressHash = true;
      history.replaceState(null, "", `#session=${encodeURIComponent(sessionId)}`);
      queueMicrotask(() => { suppressHash = false; });
    }
    setJumpPending(sessionId, true);
    try {
      const result = await post("/api/jump", { sessionId });
      toast(result.message || "已回到 session");
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      pendingJumps.delete(sessionId);
      setJumpPending(sessionId, false);
    }
  }

  async function deleteSession(control) {
    const row = control.closest(".fm-session");
    const sessionId = row?.dataset.sessionId;
    if (!sessionId) return;
    const shared = Number(control.dataset.otherSessions || 0) > 0;
    const detail = shared
      ? "这条 session 已与其他 session 共享主题；共享主题脉络会保留。"
      : "它是主题中唯一的 session；对应主题脉络会一并删除。";
    const confirmed = window.confirm(`从 SessionMap 删除这条 session 记录并停止再次整理它？\n\n${detail}\n原始 agent transcript 不会被删除。`);
    if (!confirmed) return;
    control.disabled = true;
    try {
      const result = await post("/api/session/delete", { sessionId });
      toast(result.removedRoot ? "Session 和对应主题已从 SessionMap 删除" : "Session 记录已从 SessionMap 删除");
      await poll(true);
    } catch (error) {
      control.disabled = false;
      toast(error.message || String(error));
    }
  }

  function openSay(sessionId, title = "当前 session") {
    if (!sessionId) return;
    saySessionId = sessionId;
    sayLabel.textContent = `发给 ${title}`;
    sayInput.value = "";
    sayOverlay.hidden = false;
    requestAnimationFrame(() => sayInput.focus());
  }

  function closeSay() {
    sayOverlay.hidden = true;
    saySessionId = "";
  }

  async function archive(rootId, label) {
    await post("/api/archive", { rootId });
    toast(`“${label}”已归档`, {
      label: "撤销",
      run: () => post("/api/restore", { rootId }),
    });
    await poll(true);
  }

  async function toggleDirectoryDisclosure(row) {
    const id = row?.dataset.nodeId;
    if (!id) return;
    const anchor = { id, y: row.getBoundingClientRect().top };
    if (row.dataset.kind === "thoughts") {
      const overview = row.closest(".topic-section")?.querySelector(":scope > .topic-body > .topic-overview");
      const outline = overview?.querySelector(":scope > .outline");
      if (!overview || !outline) return;
      const expanded = outline.hidden;
      outline.hidden = !expanded;
      overview.hidden = !expanded;
      manualFold[id] = !expanded;
      row.setAttribute("aria-expanded", String(expanded));
      const label = row.querySelector(".thought-kicker");
      if (label) label.textContent = expanded ? "收起脉络" : "脉络";
      saveManualFold();
      if (expanded && !outline.childElementCount) buildOutline(outline, overview._overviewData);
    } else {
      const children = row.closest(".outline-node")?.querySelector(":scope > .outline-children");
      if (!children) return;
      const expanded = children.hidden;
      children.hidden = !expanded;
      manualFold[id] = !expanded;
      row.setAttribute("aria-expanded", String(expanded));
      saveManualFold();
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    pinDirectoryAnchor(anchor);
  }

  function inlineSessionJump(event) {
    const target = event.target;
    return target instanceof Element ? target.closest('[data-inline-action="jump-session"]') : null;
  }

  function inlineSessionDelete(event) {
    const target = event.target;
    return target instanceof Element ? target.closest('[data-inline-action="delete-session"]') : null;
  }

  function rowFromEvent(event) {
    const target = event.target;
    return target instanceof Element ? target.closest(".fm-line") : null;
  }

  directory.addEventListener("click", async (event) => {
    const deleteControl = inlineSessionDelete(event);
    if (deleteControl) {
      event.preventDefault();
      event.stopPropagation();
      await deleteSession(deleteControl);
      return;
    }
    const jumpControl = inlineSessionJump(event);
    if (jumpControl) {
      event.preventDefault();
      event.stopPropagation();
      const sessionRow = jumpControl.closest(".fm-session");
      const jumpSessionId = jumpControl.dataset.sessionId || sessionRow?.dataset.sessionId;
      if (jumpSessionId) await jump(jumpSessionId);
      return;
    }
    const foldControl = event.target instanceof Element
      ? event.target.closest('[data-inline-action="fold-topic"]')
      : null;
    if (foldControl) {
      event.preventDefault();
      event.stopPropagation();
      toggleTopicFold(foldControl.closest(".topic-section"));
      return;
    }
    const row = rowFromEvent(event);
    if (!row) return;
    const sessionId = row.dataset.sessionId;
    if (event.altKey && sessionId) {
      event.preventDefault();
      event.stopPropagation();
      openSay(sessionId, row.textContent.trim());
      return;
    }
    if (row.dataset.action === "fold-topic") {
      event.preventDefault();
      event.stopPropagation();
      toggleTopicFold(row.closest(".topic-section"));
    } else if (row.dataset.action === "jump" && sessionId) {
      event.preventDefault();
      event.stopPropagation();
      await jump(sessionId);
    } else if (row.dataset.action === "toggle") {
      event.preventDefault();
      event.stopPropagation();
      await toggleDirectoryDisclosure(row);
    }
  }, true);

  directory.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const deleteControl = inlineSessionDelete(event);
    if (deleteControl) {
      event.preventDefault();
      await deleteSession(deleteControl);
      return;
    }
    const jumpControl = inlineSessionJump(event);
    if (jumpControl) {
      event.preventDefault();
      const sessionRow = jumpControl.closest(".fm-session");
      if (sessionRow?.dataset.sessionId) await jump(sessionRow.dataset.sessionId);
      return;
    }
    const row = rowFromEvent(event);
    if (!row) return;
    event.preventDefault();
    if (event.altKey && row.dataset.sessionId) openSay(row.dataset.sessionId, row.textContent.trim());
    else if (row.dataset.action === "fold-topic") toggleTopicFold(row.closest(".topic-section"));
    else if (row.dataset.action === "jump") await jump(row.dataset.sessionId);
    else if (row.dataset.action === "toggle") await toggleDirectoryDisclosure(row);
  });

  directory.addEventListener("contextmenu", async (event) => {
    const row = rowFromEvent(event);
    if (!row || row.dataset.kind !== "mainline") return;
    event.preventDefault();
    event.stopPropagation();
    try {
      await archive(row.dataset.rootId, row.querySelector(".mainline-label")?.textContent || "主线");
    } catch (error) {
      toast(error.message || String(error));
    }
  }, true);

  directory.addEventListener("dblclick", async (event) => {
    if (inlineSessionJump(event) || inlineSessionDelete(event)) return;
    const row = rowFromEvent(event);
    if (row?.dataset.kind === "session") {
      if (event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      await jump(row.dataset.sessionId);
      return;
    }
    if (row) return;
  }, true);

  archivedButton.addEventListener("click", () => { archiveDrawer.hidden = false; });
  document.getElementById("archive-close").addEventListener("click", () => { archiveDrawer.hidden = true; });

  async function checkNow() {
    if (checkNowButton.disabled) return;
    checkNowButton.disabled = true;
    intakeRecheck.disabled = true;
    const previous = checkNowButton.textContent;
    checkNowButton.textContent = "检查中…";
    try {
      await post("/api/intake/check", {});
      await poll(true);
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      checkNowButton.disabled = false;
      intakeRecheck.disabled = false;
      checkNowButton.textContent = previous;
    }
  }

  checkNowButton.addEventListener("click", checkNow);
  intakeRecheck.addEventListener("click", checkNow);
  historyButton.addEventListener("click", () => {
    intakePanelOpen = true;
    hiddenImportId = "";
    if (snapshot) renderIntake(snapshot.intake, snapshot.engine, snapshot.engines || []);
    intakePanel.scrollIntoView({ block: "start" });
  });
  intakeCustomDate.addEventListener("change", () => snapshot && renderIntakeChoice(snapshot.intake, snapshot.engine, snapshot.engines || []));
  intakeStart.addEventListener("click", () => {
    if (!snapshot?.intake) return;
    const selected = selectedRange(snapshot.intake);
    intakePanelOpen = false;
    void intakeAction("/api/intake/start", { cutoffAt: selected.cutoffAt }, { background: true })
      .then((result) => {
        if (result?.phase === "importing") directory.scrollIntoView({ block: "start" });
      });
  });
  intakeSkip.addEventListener("click", () => {
    intakePanelOpen = false;
    void intakeAction("/api/intake/start", { cutoffAt: null });
  });
  intakePause.addEventListener("click", () => void intakeAction("/api/intake/pause"));
  intakeResume.addEventListener("click", () => void intakeAction("/api/intake/resume"));
  intakeCancel.addEventListener("click", () => {
    if (window.confirm("取消尚未完成的历史导入？已整理的工作线会保留，以后仍可补扫。")) {
      void intakeAction("/api/intake/cancel");
    }
  });
  intakeShowMap.addEventListener("click", () => {
    hiddenImportId = snapshot?.intake?.job?.id || "";
    intakePanel.hidden = true;
    directory.scrollIntoView({ block: "start" });
  });

  engineSelect.addEventListener("change", async () => {
    try {
      await post("/api/engine", { engine: engineSelect.value });
      toast(`Roll 引擎已切到 ${engineSelect.value}`);
      await poll(true);
    } catch (error) {
      toast(error.message || String(error));
      if (snapshot) engineSelect.value = snapshot.engine;
    }
  });

  sayForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = sayInput.value.trim();
    if (!text || !saySessionId) return;
    try {
      const result = await post("/api/say", { sessionId: saySessionId, text });
      closeSay();
      toast(result.message || "已发送");
    } catch (error) {
      toast(error.message || String(error));
    }
  });
  sayInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sayForm.requestSubmit();
    }
  });
  sayOverlay.addEventListener("pointerdown", (event) => {
    if (event.target === sayOverlay) closeSay();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSay();
      archiveDrawer.hidden = true;
    }
  });

  window.addEventListener("hashchange", () => {
    if (suppressHash) return;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const openTicket = fragment.get("open");
    if (openTicket && /^[A-Za-z0-9_.-]{64,512}$/.test(openTicket)) {
      sessionStorage.setItem(openTicketKey, openTicket);
      sessionStorage.removeItem(openIdKey);
      sessionStorage.removeItem(openExpiryKey);
      fragment.delete("open");
      const rest = fragment.toString();
      history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
      location.reload();
      return;
    }
    const match = location.hash.match(/^#session=([^&]+)$/);
    if (match) jump(decodeURIComponent(match[1]), true);
  });

  async function poll(force = false) {
    if (polling) return false;
    polling = true;
    try {
      const next = await api("/api/snapshot");
      const nextAsset = String(next.assetVersion);
      if (seenAssetVersion && nextAsset !== seenAssetVersion) {
        location.reload();
        return;
      }
      if (force || next.revision !== seenRevision) {
        // The now bar is the first answer to the three-second recovery
        // contract. Paint it as soon as the snapshot arrives; the map may
        // still be finishing its layout transition.
        renderChrome(next);
        await renderMap(next.markdown);
        renderSessionContexts(next.git || []);
        snapshot = next;
        seenRevision = next.revision;
        seenAssetVersion = nextAsset;
      } else {
        renderChrome(next);
        renderSessionContexts(next.git || []);
        snapshot = next;
      }
      await acknowledgeOpen();
      return true;
    } catch (error) {
      statusLine.textContent = `暂时无法刷新 · ${error.message || error}`;
      // Keep the last successful tree and revision. The next poll retries it.
      if (seenRevision < 0) loading.querySelector("span:last-child").textContent = "等待本地服务恢复";
      return false;
    } finally {
      polling = false;
    }
  }

  mapShell.addEventListener("scroll", scheduleTopicIndexSelection, { passive: true });

  async function boot() {
    try {
      const hasPendingExchange = window.SESSIONMAP_OPEN_TICKET &&
        (!window.SESSIONMAP_OPEN_ID || Date.now() > Number(window.SESSIONMAP_OPEN_EXPIRY || 0));
      if (hasPendingExchange) await exchangeOpenTicket();
    } catch (error) {
      clearOpenHandshake();
      statusLine.textContent = "打开回执已失效 · 正在直接读取本机数据";
      loading.querySelector("span:last-child").textContent = error.message || String(error);
    }
    if (!window.markmap?.Transformer) {
      throw new Error("本地 markmap 资产未加载");
    }
    transformer = new window.markmap.Transformer();
    window.SESSIONMAP_READY = true;
    sessionStorage.removeItem("sessionmap.asset-reload");
    await poll(true);
    window.setInterval(() => poll(false), POLL_MS);
  }

  void boot().catch((error) => {
    statusLine.textContent = error.message || String(error);
  });
})();
