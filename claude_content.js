// Claude.ai content script for GFormToGPT v4.4.0 - Neural Interface
// Platform config only — shared logic lives in ai_common.js.

(function () {
  "use strict";

  console.log("[GFormToGPT Claude] Script loaded");

  GFormAI.createAdapter({
    platform: "claude",
    logPrefix: "[GFormToGPT Claude]",
    editorSelectors: ['[contenteditable="true"]', '.ProseMirror'],
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button:has(svg path[d*="M208.49"])',
      () => document.querySelector('button[type="button"] svg path[d*="M208.49"]')?.closest('button'),
      'button._claude_x02hl_108',
    ],
    blockSelectors: "pre, code, .prose, div.markdown, .font-mono",
    jsonKeyRegex: /"\d+"(\s*):|'\d+'(\s*):|(\s+)\d+:/,
  });
})();
