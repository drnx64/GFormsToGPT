// Gemini content script for GFormToGPT v4.6.0 - Neural Interface
// Platform config + Gemini-only image upload — shared logic lives in ai_common.js.

(function () {
  "use strict";

  console.log("[GFormToGPT Gemini] Script loaded");

  const uploadedUrls = new Set();

  async function uploadImageToGemini(imageUrl, questionNum, log) {
    try {
      const resp = await fetch(imageUrl, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const ext = blob.type.split("/")[1] || "png";
      const file = new File([blob], `question_${questionNum}.${ext}`, { type: blob.type });

      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        log(`Uploaded image for Q${questionNum}:`, file.name);
        return true;
      }

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      pasteEvent.clipboardData.items.add(file);
      const target = document.querySelector('[contenteditable="true"], .ql-editor, .rich-textarea');
      if (target) {
        target.dispatchEvent(pasteEvent);
        log(`Pasted image for Q${questionNum}:`, file.name);
        return true;
      }

      log("No upload target found for image");
      return false;
    } catch (e) {
      log("Image upload failed:", e);
      return false;
    }
  }

  async function uploadAllImages(images, log) {
    const entries = Object.entries(images).slice(0, 10);
    for (const [qNum, urls] of entries) {
      for (const url of urls) {
        if (uploadedUrls.has(url)) continue;
        uploadedUrls.add(url);
        const ok = await uploadImageToGemini(url, qNum, log);
        if (ok) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  GFormAI.createAdapter({
    platform: "gemini",
    logPrefix: "[GFormToGPT Gemini]",
    editorSelectors: [
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      '.rich-textarea',
    ],
    sendSelectors: [
      'button[aria-label="Send message"]',
      '.send-button-container button',
      'button:has(mat-icon)',
    ],
    blockSelectors: "pre, code, div.markdown, .message-content, .model-response-text",
    jsonKeyRegex: /"\d+"(\s*):|'\d+'(\s*):|(\s+)\d+:/,
    beforeInject: async (data, log) => {
      if (data.pendingImages && Object.keys(data.pendingImages).length > 0) {
        log("Uploading images...");
        await uploadAllImages(data.pendingImages, log);
        log("Image upload complete");
      }
    },
  });
})();
