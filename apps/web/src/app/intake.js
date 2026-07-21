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
    const stageLabels = {
      queued: "等待调度",
      reading: "读取 transcript",
      rolling: "等待模型整理",
      validating: "校验结果",
      committing: "写入地图",
    };
    intakeProgressTitle.textContent = paused ? "历史整理已暂停" : "正在把近期工作整理成地图";
    intakeProgressCopy.textContent = job.failed
      ? `${job.failed} 个 session 需要重试；已完成的工作线保持可用。`
      : job.waitingRetry
        ? `${job.waitingRetry} 个 session 正在退避重试；其他工作继续整理。`
        : `完成的工作线会立即出现；历史最多 ${job.maxParallel || 2} 路并行，并为新 session 保留处理槽。`;
    const laneState = [`历史 ${job.active || 0}`];
    if (job.liveActive || job.liveQueued) laneState.push(`实时 ${job.liveActive || 0}${job.liveQueued ? `+${job.liveQueued}` : ""}`);
    intakeJobState.textContent = paused ? "等待继续" : laneState.join(" · ");
    const percent = job.totalBytes
      ? Math.round(job.processedBytes / job.totalBytes * 100)
      : job.total ? Math.round(job.completed / job.total * 100) : 100;
    intakeProgressFill.style.width = `${percent}%`;
    intakeProgressCount.textContent = `${job.completed} / ${job.total} session · ${percent}%`;
    intakeCurrent.replaceChildren();
    const activities = job.activities || [];
    for (const activity of activities) {
      const row = document.createElement("div");
      row.className = "intake-current-row";
      const strong = document.createElement("strong");
      strong.textContent = activity.title;
      const detail = document.createElement("span");
      const ratio = activity.totalBytes ? Math.round(activity.processedBytes / activity.totalBytes * 100) : 0;
      detail.textContent = activity.error
        ? `${activity.provider} · ${activity.error}`
        : `${stageLabels[activity.stage] || "处理中"} · ${activity.provider} · ${ratio}% · ${formatBytes(activity.processedBytes)} / ${formatBytes(activity.totalBytes)}`;
      row.append(strong, detail);
      intakeCurrent.append(row);
    }
    if (!activities.length && job.current) {
      const row = document.createElement("div");
      row.className = "intake-current-row";
      const strong = document.createElement("strong");
      strong.textContent = job.current.title;
      const detail = document.createElement("span");
      detail.textContent = job.current.error
        ? `${job.current.provider} · ${job.current.error}`
        : job.waitingRetry
          ? `等待自动重试 · 上次推进于 ${relativeTime(job.lastProgressAt)}`
          : `等待调度 · ${formatBytes(job.current.processedBytes)} / ${formatBytes(job.current.totalBytes)}`;
      row.append(strong, detail);
      intakeCurrent.append(row);
    }
    if (!intakeCurrent.childElementCount) intakeCurrent.textContent = "正在收口导入状态…";
    const summary = document.createElement("div");
    summary.className = "intake-current-summary";
    summary.textContent = `总字节 ${formatBytes(job.processedBytes)} / ${formatBytes(job.totalBytes)} · 最近推进 ${relativeTime(job.lastProgressAt)}`;
    intakeCurrent.append(summary);
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
