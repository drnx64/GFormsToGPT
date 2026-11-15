// Welcome page logic for GForm to GPT v4.6.0
document.addEventListener("DOMContentLoaded", () => {
  // ── Consent: one checkbox for Terms & Privacy ──
  const consentCheck = document.getElementById("legalConsentCheck");
  const consentBtn = document.getElementById("consentSubmitBtn");
  const consentStatus = document.getElementById("consentStatus");

  if (consentCheck && consentBtn) {
    const sync = () => {
      consentBtn.disabled = !consentCheck.checked;
    };
    consentCheck.addEventListener("change", sync);

    // Show a recorded state if consent was already given (e.g. via the popup).
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.get(["consentAccepted"], (data) => {
        if (data.consentAccepted === true) {
          consentCheck.checked = true;
          sync();
          if (consentStatus) consentStatus.style.display = "block";
        }
      });
    }

    consentBtn.addEventListener("click", () => {
      if (!consentCheck.checked) return;
      // Telemetry keeps its stored preference (default on); this only
      // records acceptance of the legal terms.
      if (typeof chrome !== "undefined" && chrome.storage) {
        chrome.storage.local.set({ consentAccepted: true, consentAt: Date.now() });
        if (chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            action: "preferenceSync",
            payload: { accepted: true },
          }).catch(() => {});
        }
      }
      if (consentStatus) consentStatus.style.display = "block";
      consentBtn.disabled = true;
      consentBtn.textContent = "Accepted";
    });
  }

  // ── Deep links (#legal, #consent) ──
  const hash = window.location.hash;
  if (hash) {
    const el = document.querySelector(hash);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  }
});
