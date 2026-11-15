// ChatGPT content script for GFormToGPT v4.6.0 - Neural Interface
// Platform config only — shared logic lives in ai_common.js.

(function () {
  "use strict";

  console.log("[GFormToGPT ChatGPT] Script loaded");

  GFormAI.createAdapter({
    platform: "chatgpt",
    logPrefix: "[GFormToGPT ChatGPT]",
    editorSelectors: ['#prompt-textarea', '[contenteditable="true"]'],
    sendSelectors: [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      '[data-testid="send-button"]:not([disabled])',
    ],
    blockSelectors: "pre, code, div.markdown, .markdown, .prose",
    jsonKeyRegex: /"\d+"(\s*):|'\d+'(\s*):/,
    acceptsAnyAiType: true,
    dispatchInputEvent: true,
    highlightTransition: true,
    waitForDom: true,
    observeTarget: () => document.querySelector("main") || document.body,
  });
})();
