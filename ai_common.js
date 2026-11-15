// Shared AI adapter for GFormToGPT v4.6.0 - Neural Interface
// Loaded before chatgpt_content.js / claude_content.js / gemini_content.js in
// manifest.json so all three platforms share one implementation. Each platform
// file supplies its own selectors and platform-specific extras.

globalThis.GFormAI = (function () {
  "use strict";

  function createAdapter(config) {
    const {
      platform,
      logPrefix,
      editorSelectors,
      sendSelectors,
      blockSelectors,
      jsonKeyRegex,
      acceptsAnyAiType = false,
      dispatchInputEvent = false,
      highlightTransition = false,
      waitForDom = false,
      observeTarget = null,
      beforeInject = null,
    } = config;

    let verboseLogging = false;
    chrome.storage.local.get(["verboseLogging"], (data) => {
      verboseLogging = !!data.verboseLogging;
    });

    function log(...args) {
      if (verboseLogging) console.log(logPrefix, ...args);
    }

    function pushDiag(payload) {
      chrome.runtime.sendMessage({ action: "diagPush", payload }).catch(() => {});
    }

    pushDiag({ type: "ai_script_loaded", platform });

    let promptStartTime = null;
    let lastProcessedJson = "";

    function highlightElement(el, color = "#3d5a80") {
      if (!el) return;
      if (highlightTransition) el.style.transition = "all 0.5s ease";
      el.style.outline = `3px solid ${color}`;
      setTimeout(() => { el.style.outline = ""; }, 2000);
    }

    function findFirst(selectors) {
      for (const selector of selectors) {
        const el = typeof selector === "function" ? selector() : document.querySelector(selector);
        if (el) return el;
      }
      return null;
    }

    function editorHasJson(editor) {
      const text = (editor.value || "") + (editor.textContent || "");
      return text.includes("JSON");
    }

    async function autoSubmitPrompt() {
      const data = await chrome.storage.local.get(["pendingPrompt", "pendingAiType", "pendingImages"]);
      const aiType = data.pendingAiType;
      const typeMatches = acceptsAnyAiType ? (!aiType || aiType === platform) : aiType === platform;
      if (!data.pendingPrompt || !typeMatches) return;

      const prompt = data.pendingPrompt;
      log("Pending prompt found, attempting injection...");
      pushDiag({ type: "ai_prompt_found", platform, promptLength: prompt.length });

      if (beforeInject) {
        try {
          await beforeInject(data, log);
        } catch (e) {
          log("beforeInject failed:", e);
        }
      }

      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        const editor = findFirst(editorSelectors);
        const sendBtn = findFirst(sendSelectors);

        if (editor) {
          if (editorHasJson(editor)) {
            if (sendBtn && !sendBtn.disabled) {
              clearInterval(checkInterval);
              log("Clicking send...");
              promptStartTime = Date.now();
              highlightElement(sendBtn, "#4caf50");
              pushDiag({ type: "ai_prompt_sent", platform, attempts });
              setTimeout(() => {
                sendBtn.click();
                chrome.storage.local.remove(["pendingPrompt", "pendingAiType", "pendingImages"]);
              }, 500);
            }
            return;
          }

          log("Injecting...");
          editor.focus();
          document.execCommand("insertText", false, prompt);
          if (dispatchInputEvent) {
            editor.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }

        if (attempts > 30) {
          clearInterval(checkInterval);
          pushDiag({ type: "ai_inject_timeout", platform, attempts });
        }
      }, 1000);
    }

    function extractAndSendJson() {
      const blocks = document.querySelectorAll(blockSelectors);
      for (const block of blocks) {
        const text = block.textContent.trim();
        const startIdx = text.indexOf("{");
        const endIdx = text.lastIndexOf("}");
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) continue;

        const potentialJson = text.substring(startIdx, endIdx + 1);
        if (potentialJson === lastProcessedJson) continue;
        if (!jsonKeyRegex.test(potentialJson)) continue;

        try {
          const cleanedText = potentialJson
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'");
          const parsed = JSON.parse(cleanedText);
          log("Valid JSON detected!", parsed);
          lastProcessedJson = potentialJson;
          highlightElement(block, "#4caf50");
          const responseTime = promptStartTime ? Date.now() - promptStartTime : null;
          chrome.runtime.sendMessage({ action: "chatGptResponseReceived", data: parsed, rawJson: cleanedText });
          pushDiag({
            type: "ai_response_received",
            platform,
            responseTime,
            keyCount: Object.keys(parsed).length,
          });
          promptStartTime = null;
        } catch (e) {
          // Not valid JSON yet — keep waiting for more of the response.
        }
      }
    }

    const observer = new MutationObserver(extractAndSendJson);

    function startObserving() {
      const target = observeTarget ? observeTarget() : document.body;
      observer.observe(target, { childList: true, subtree: true });
      autoSubmitPrompt();
      setInterval(extractAndSendJson, 2000);
    }

    if (waitForDom && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserving);
    } else {
      startObserving();
    }

    return { log, pushDiag, highlightElement, autoSubmitPrompt, extractAndSendJson, startObserving };
  }

  return { createAdapter };
})();
