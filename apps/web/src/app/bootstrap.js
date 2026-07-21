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
