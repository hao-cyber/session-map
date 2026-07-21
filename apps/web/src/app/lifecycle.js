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
