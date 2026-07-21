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
      if (label) label.textContent = expanded ? "收起脉络" : "查看脉络";
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
