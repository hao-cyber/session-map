(() => {
  "use strict";

  const POLL_MS = 4_000;
  const DRAG_THRESHOLD = 5;
  const API_HEADERS = {
    "X-SessionMap-Token": window.SESSIONMAP_TOKEN,
  };
  const manualFoldKey = "sessionmap.manual-fold.v1";
  const legacyManualFoldKey = "maintrail.manual-fold.v1";

  const svg = document.getElementById("mindmap");
  const loading = document.getElementById("loading");
  const nowBar = document.getElementById("now-bar");
  const statusLine = document.getElementById("status-line");
  const gitChips = document.getElementById("git-chips");
  const engineSelect = document.getElementById("engine-select");
  const archivedButton = document.getElementById("archived-button");
  const archivedCount = document.getElementById("archived-count");
  const archiveDrawer = document.getElementById("archive-drawer");
  const archiveList = document.getElementById("archive-list");
  const sayOverlay = document.getElementById("say-overlay");
  const sayForm = document.getElementById("say-form");
  const sayInput = document.getElementById("say-input");
  const sayLabel = document.getElementById("say-label");
  const toastRegion = document.getElementById("toast-region");

  let transformer;
  let mm;
  let snapshot;
  let seenRevision = -1;
  let seenAssetVersion = String(window.SESSIONMAP_ASSET_VERSION || "");
  let polling = false;
  let firstRender = true;
  let saySessionId = "";
  let pointerStart = null;
  let pointerDragged = false;
  let suppressHash = false;
  let resizeTimer = 0;
  let manualFold = loadManualFold();

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

  function relativeTime(value) {
    const then = Date.parse(value);
    if (!Number.isFinite(then)) return "刚刚";
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 45) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86_400)} 天前`;
  }

  async function api(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("X-SessionMap-Token", window.SESSIONMAP_TOKEN);
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
    if (!response.ok) throw new Error(payload?.error || `请求失败 (${response.status})`);
    return payload;
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

  function extractNodeId(data) {
    const content = data?.content || data?.payload?.content || "";
    const match = String(content).match(/data-node-id=["']([^"']+)["']/);
    return match?.[1] || null;
  }

  function walk(node, visit, depth = 0) {
    if (!node) return;
    visit(node, depth);
    for (const child of node.children || []) walk(child, visit, depth + 1);
  }

  function dataById(id) {
    let found = null;
    walk(mm?.state?.data, (node) => {
      if (!found && extractNodeId(node) === id) found = node;
    });
    return found;
  }

  function rememberFoldState() {
    const folds = new Map();
    walk(mm?.state?.data, (node) => {
      const id = extractNodeId(node);
      if (id) folds.set(id, Boolean(node.payload?.fold));
    });
    return folds;
  }

  function applyRememberedFolds(root, remembered) {
    walk(root, (node, depth) => {
      const id = extractNodeId(node);
      if (!id) return;
      if (Object.prototype.hasOwnProperty.call(manualFold, id)) {
        node.payload = node.payload || {};
        node.payload.fold = Boolean(manualFold[id]);
        return;
      }
      if (remembered.has(id)) {
        node.payload = node.payload || {};
        node.payload.fold = remembered.get(id);
        return;
      }
      const content = String(node.content || node.payload?.content || "");
      if (depth >= 2 && content.includes('data-default-fold="true"')) {
        node.payload = node.payload || {};
        node.payload.fold = true;
      }
    });
  }

  function centerAnchor(allowedIds) {
    if (!mm) return null;
    const box = svg.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    let nearest = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const group of svg.querySelectorAll("g.markmap-node")) {
      const line = group.querySelector(".fm-line[data-node-id], [data-node-id]");
      const id = line?.dataset.nodeId;
      if (!id) continue;
      if (allowedIds && !allowedIds.has(id)) continue;
      const rect = group.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const next = Math.hypot(x - cx, y - cy);
      if (next < distance) {
        distance = next;
        nearest = { id, x, y };
      }
    }
    return nearest;
  }

  function pinAnchor(anchor) {
    if (!anchor || !mm) return;
    const currentData = dataById(anchor.id);
    const candidates = [...svg.querySelectorAll("g.markmap-node")].filter((group) =>
      group.querySelector(`[data-node-id="${CSS.escape(anchor.id)}"]`),
    );
    // Markmap keys transitions by structural path. A sibling removal can leave
    // an exiting DOM duplicate with the same stable SessionMap id for one frame.
    const element = candidates.find((group) => group.__data__ === currentData) ?? candidates.at(-1);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const transform = window.d3.zoomTransform(svg);
    const adjusted = window.d3.zoomIdentity
      .translate(transform.x + anchor.x - x, transform.y + anchor.y - y)
      .scale(transform.k);
    mm.svg.call(mm.zoom.transform, adjusted);
  }

  function afterLayout() {
    return new Promise((resolve) => window.setTimeout(resolve, 350));
  }

  async function renderMap(markdown) {
    const remembered = rememberFoldState();
    const transformed = transformer.transform(markdown);
    const nextIds = new Set();
    walk(transformed.root, (node) => {
      const id = extractNodeId(node);
      if (id) nextIds.add(id);
    });
    const anchor = centerAnchor(nextIds);
    applyRememberedFolds(transformed.root, remembered);
    if (!mm) {
      mm = window.markmap.Markmap.create(svg, {
        autoFit: false,
        color: () => "#aab2be",
        duration: 320,
        embedGlobalCSS: true,
        fitRatio: 0.9,
        initialExpandLevel: -1,
        lineWidth: () => 1.25,
        maxInitialScale: 1.25,
        maxWidth: 520,
        nodeMinHeight: 24,
        paddingX: 12,
        pan: true,
        scrollForPan: false,
        spacingHorizontal: 74,
        spacingVertical: 7,
        toggleRecursively: false,
        zoom: true,
      });
    }
    await mm.setData(transformed.root);
    decorateInteractiveRows();
    if (firstRender) {
      // setData resolves before Markmap's enter transition finishes. Fitting
      // against that intermediate geometry can open on a clipped, overlapping
      // tree — exactly when the user most needs a stable three-second view.
      await afterLayout();
      await mm.fit(1.12);
      firstRender = false;
    } else {
      await afterLayout();
      pinAnchor(anchor);
    }
    loading.hidden = true;
  }

  function decorateInteractiveRows() {
    for (const row of svg.querySelectorAll(".fm-line")) {
      const action = row.dataset.action;
      if (action === "jump" || action === "toggle") {
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
      }
      const contextToggle = row.querySelector('[data-inline-action="toggle-context"]');
      if (contextToggle) {
        const data = dataById(row.dataset.nodeId);
        contextToggle.setAttribute("aria-expanded", String(!Boolean(data?.payload?.fold)));
      }
    }
  }

  window.SESSIONMAP_FIT = () => mm?.fit(1.12);

  function renderChrome(data) {
    statusLine.textContent = `${data.activeSessions} 个活跃 session · 更新于 ${relativeTime(data.updatedAt)}`;
    renderNow(data.now || []);
    renderGit(data.git || []);
    renderEngines(data.engines || [], data.engine);
    renderArchives(data.archived || []);
  }

  function renderNow(items) {
    nowBar.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "now-empty";
      const icon = document.createElement("span");
      icon.className = "icon icon-check-circle-2";
      const text = document.createElement("span");
      text.textContent = "没有等待你处理的工作线";
      empty.append(icon, text);
      nowBar.append(empty);
      return;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "now-item";
      button.dataset.kind = item.kind;
      if (item.sessionId) button.dataset.sessionId = item.sessionId;
      const label = document.createElement("span");
      label.className = "now-label";
      label.textContent = item.label;
      const detail = document.createElement("span");
      detail.className = "now-detail";
      detail.textContent = item.detail || item.mainline;
      const time = document.createElement("time");
      time.className = "now-time";
      time.textContent = relativeTime(item.at);
      button.append(label, detail, time);
      button.addEventListener("click", () => item.sessionId && jump(item.sessionId));
      nowBar.append(button);
    }
  }

  function renderGit(chips) {
    gitChips.replaceChildren();
    for (const chip of chips) {
      const element = document.createElement("div");
      element.className = "git-chip";
      element.title = `${chip.cwd}\n${chip.branch || "detached"}`;
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

  async function jump(sessionId, fromHash = false) {
    if (!sessionId) return;
    if (!fromHash) {
      suppressHash = true;
      history.replaceState(null, "", `#session=${encodeURIComponent(sessionId)}`);
      queueMicrotask(() => { suppressHash = false; });
    }
    const rows = [...svg.querySelectorAll(".fm-line[data-session-id]")]
      .filter((row) => row.dataset.sessionId === sessionId);
    for (const row of rows) {
      row.classList.add("is-jumping");
      row.setAttribute("aria-busy", "true");
    }
    const pending = toast("正在切回 session…");
    try {
      const result = await post("/api/jump", { sessionId });
      pending.remove();
      toast(result.message || "已切回 session");
    } catch (error) {
      pending.remove();
      toast(error.message || String(error));
    } finally {
      for (const row of rows) {
        row.classList.remove("is-jumping");
        row.removeAttribute("aria-busy");
      }
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

  async function toggleNodeById(id) {
    const node = id && dataById(id);
    if (!id || !node?.children?.length) return;
    const next = !Boolean(node.payload?.fold);
    manualFold[id] = next;
    saveManualFold();
    await mm.toggleNode(node);
    decorateInteractiveRows();
  }

  async function toggleRow(row) {
    await toggleNodeById(row.dataset.nodeId);
  }

  function inlineContextToggle(event) {
    const target = event.target;
    return target instanceof Element ? target.closest('[data-inline-action="toggle-context"]') : null;
  }

  function rowFromEvent(event) {
    const target = event.target;
    return target instanceof Element ? target.closest(".fm-line") : null;
  }

  svg.addEventListener("pointerdown", (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
    pointerDragged = false;
  }, true);
  svg.addEventListener("pointermove", (event) => {
    if (!pointerStart) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > DRAG_THRESHOLD) {
      pointerDragged = true;
    }
  }, true);
  svg.addEventListener("pointerup", () => {
    window.setTimeout(() => { pointerStart = null; }, 0);
  }, true);

  svg.addEventListener("click", async (event) => {
    if (pointerDragged) {
      event.preventDefault();
      event.stopPropagation();
      pointerDragged = false;
      return;
    }
    const contextToggle = inlineContextToggle(event);
    if (contextToggle) {
      event.preventDefault();
      event.stopPropagation();
      const sessionRow = contextToggle.closest(".fm-session");
      if (sessionRow) await toggleNodeById(sessionRow.dataset.nodeId);
      return;
    }
    const row = rowFromEvent(event);
    if (!row) {
      const target = event.target;
      const circle = target instanceof Element ? target.closest("g.markmap-node > circle") : null;
      if (circle) {
        // Markmap owns the native circle toggle. Record its resulting state after
        // its target listener runs so manual intent survives data refresh.
        window.setTimeout(() => {
          const node = circle.parentElement?.__data__;
          const id = extractNodeId(node);
          if (!id || !node?.children?.length) return;
          manualFold[id] = Boolean(node.payload?.fold);
          saveManualFold();
        }, 0);
      }
      return;
    }
    const sessionId = row.dataset.sessionId;
    if (event.altKey && sessionId) {
      event.preventDefault();
      event.stopPropagation();
      openSay(sessionId, row.textContent.trim());
      return;
    }
    if (row.dataset.action === "jump" && sessionId) {
      event.preventDefault();
      event.stopPropagation();
      await jump(sessionId);
    } else if (row.dataset.action === "toggle") {
      event.preventDefault();
      event.stopPropagation();
      await toggleRow(row);
    }
  }, true);

  svg.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const contextToggle = inlineContextToggle(event);
    if (contextToggle) {
      event.preventDefault();
      const sessionRow = contextToggle.closest(".fm-session");
      if (sessionRow) await toggleNodeById(sessionRow.dataset.nodeId);
      return;
    }
    const row = rowFromEvent(event);
    if (!row) return;
    event.preventDefault();
    if (event.altKey && row.dataset.sessionId) openSay(row.dataset.sessionId, row.textContent.trim());
    else if (row.dataset.action === "jump") await jump(row.dataset.sessionId);
    else if (row.dataset.action === "toggle") await toggleRow(row);
  });

  svg.addEventListener("contextmenu", async (event) => {
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

  svg.addEventListener("dblclick", (event) => {
    if (rowFromEvent(event)) return;
    event.preventDefault();
    mm?.fit(1.12);
  });

  document.getElementById("fit-button").addEventListener("click", () => {
    mm?.fit(1.12);
  });
  archivedButton.addEventListener("click", () => { archiveDrawer.hidden = false; });
  document.getElementById("archive-close").addEventListener("click", () => { archiveDrawer.hidden = true; });

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
    const match = location.hash.match(/^#session=([^&]+)$/);
    if (match) jump(decodeURIComponent(match[1]), true);
  });

  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!mm) return;
      void mm.fit(1.08);
    }, 180);
  });

  async function poll(force = false) {
    if (polling) return;
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
        snapshot = next;
        seenRevision = next.revision;
        seenAssetVersion = nextAsset;
      } else {
        renderChrome(next);
        snapshot = next;
      }
    } catch (error) {
      statusLine.textContent = `暂时无法刷新 · ${error.message || error}`;
      // Keep the last successful tree and revision. The next poll retries it.
      if (seenRevision < 0) loading.querySelector("span:last-child").textContent = "等待本地服务恢复";
    } finally {
      polling = false;
    }
  }

  function boot() {
    if (!window.SESSIONMAP_TOKEN) {
      statusLine.textContent = "请运行 sessionmap open 安全打开本地页面";
      loading.querySelector("span:last-child").textContent = "此页面没有本地访问凭据";
      return;
    }
    if (!window.d3 || !window.markmap?.Transformer || !window.markmap?.Markmap) {
      throw new Error("本地 markmap 资产未加载");
    }
    transformer = new window.markmap.Transformer();
    window.SESSIONMAP_READY = true;
    sessionStorage.removeItem("sessionmap.asset-reload");
    poll(true);
    window.setInterval(() => poll(false), POLL_MS);
  }

  try {
    boot();
  } catch (error) {
    statusLine.textContent = error.message || String(error);
  }
})();
