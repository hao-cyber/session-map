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
    const outlineId = `topic-lineage-${String(row.dataset.rootId || row.dataset.nodeId || "outline").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    outline.id = outlineId;
    outline.setAttribute("role", "region");
    outline.setAttribute("aria-label", "主题完整脉络");
    row.setAttribute("aria-controls", outlineId);
    const folded = Object.prototype.hasOwnProperty.call(manualFold, row.dataset.nodeId)
      ? Boolean(manualFold[row.dataset.nodeId])
      : true;
    row.setAttribute("aria-expanded", String(!folded));
    const label = row.querySelector(".thought-kicker");
    if (label) label.textContent = folded ? "查看脉络" : "收起脉络";
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
    wrap.setAttribute("role", "listitem");
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
    list.setAttribute("role", "list");
    if (id) {
      list.id = `outline-children-${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      row.setAttribute("aria-controls", list.id);
    }
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
    list.setAttribute("role", "list");
    for (const child of topic.children || []) list.append(buildOutlineNode(child));
    container.append(list);
    decorateRows(container);
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
    const topicStatus = document.createElement("span");
    topicStatus.className = "topic-status";
    for (const name of headerRow.classList) {
      if (name.startsWith("state-")) topicStatus.classList.add(name);
    }
    const freshness = headerRow.querySelector(".fresh");
    const stateWord = headerRow.querySelector(".state-word");
    if (freshness) topicStatus.append(freshness);
    if (stateWord) topicStatus.append(stateWord);
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
    if (topicStatus.childElementCount) headerLayout.append(topicStatus);
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
