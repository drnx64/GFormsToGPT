// Popup script for GFormToGPT v4.5.0 - Neural Interface

// ── Escaping (form titles / answers / diag fields are untrusted page text) ──
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

// ── Consent gate: block all use until Terms/Privacy are accepted ──
const consentGate = document.getElementById("consentGate");
const consentCheck = document.getElementById("consentCheck");
const consentTelemetry = document.getElementById("consentTelemetry");
const consentAcceptBtn = document.getElementById("consentAcceptBtn");

async function initConsentGate() {
  if (!consentGate || !consentCheck || !consentAcceptBtn) return;
  let state = { consentAccepted: false, diagnosticEnabled: true };
  try {
    state = (await chrome.runtime.sendMessage({ action: "getConsent" })) || state;
  } catch (e) { /* worker unavailable — keep gated */ }

  if (state.consentAccepted) {
    consentGate.style.display = "none";
    return;
  }

  consentGate.style.display = "flex"; // fail-closed: gate stays up on any error
  if (consentTelemetry) consentTelemetry.checked = state.diagnosticEnabled !== false;
  consentCheck.checked = false;
  consentAcceptBtn.disabled = true;

  const sync = () => { consentAcceptBtn.disabled = !consentCheck.checked; };
  consentCheck.addEventListener("change", sync);

  consentAcceptBtn.addEventListener("click", async () => {
    if (!consentCheck.checked) return;
    consentAcceptBtn.disabled = true;
    const telemetry = consentTelemetry ? consentTelemetry.checked : true;
    await chrome.storage.local.set({ diagnosticEnabled: telemetry });
    chrome.runtime.sendMessage({
      action: "consentGiven",
      payload: { accepted: true, telemetry },
    }).catch(() => {});
    consentGate.style.display = "none";
  });
}

// ── Personal profile fields ──
const PROFILE_FIELDS = {
  pfFamilyName: "familyName",
  pfGivenName: "givenName",
  pfMiddleName: "middleName",
  pfBirthday: "birthday",
  pfSection: "section",
  pfYear: "year",
  pfSubject: "subject",
  pfCourse: "course",
};

async function loadPersonalProfile() {
  const data = await chrome.storage.local.get(["personalProfile"]);
  const profile = data.personalProfile || {};
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) {
    const el = document.getElementById(id);
    if (el && profile[key]) el.value = profile[key];
  }
}

function collectPersonalProfile() {
  const profile = {};
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) profile[key] = el.value.trim();
  }
  return profile;
}

// ── Tab switching functionality ──
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabName = btn.getAttribute("data-tab");
    document.querySelectorAll(".tab-content").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((button) => button.classList.remove("active"));

    const targetTab = document.getElementById(tabName);
    if (targetTab) {
      targetTab.classList.add("active");
      btn.classList.add("active");
      if (tabName === "history") loadHistory();
      if (tabName === "diagnostics") loadDiagnostics();
    }
  });
});

// ── History Logic ──
const historyList = document.getElementById("historyList");

async function loadHistory() {
  const data = await chrome.storage.local.get(["history", "totalSecondsSaved", "formCount"]);
  const history = data.history || [];

  const totalSeconds = data.totalSecondsSaved || 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (document.getElementById("totalTimeSaved")) document.getElementById("totalTimeSaved").textContent = `${minutes}m ${seconds}s`;
  if (document.getElementById("totalFormsFilled")) document.getElementById("totalFormsFilled").textContent = `${data.formCount || 0} forms automated`;

  if (history.length === 0) {
    if (historyList) historyList.innerHTML = '<div class="empty-history">No forms scanned yet.</div>';
    return;
  }

  if (historyList) {
    historyList.innerHTML = history.map(item => `
      <div class="history-item" data-id="${escapeHtml(item.id)}">
        <div class="history-header">
          <div>
            <h4>${escapeHtml(item.formTitle || "Untitled Form")}</h4>
            <span>${escapeHtml(new Date(item.timestamp).toLocaleString())}</span>
          </div>
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="history-content">
          ${(item.questions || []).map((q, idx) => `
            <div class="history-q-row">
              <div class="history-q">[Q${idx + 1}] ${escapeHtml(q.q)}</div>
              <div class="history-a">${escapeHtml(q.a)}</div>
            </div>
          `).join('')}
          <div class="export-btn-container">
            <button class="btn btn-outline export-btn" style="width:100%; font-size:11px; padding:6px;">Export to Text</button>
          </div>
        </div>
      </div>
    `).join('');

    document.querySelectorAll(".history-header").forEach(header => {
      header.addEventListener("click", () => header.parentElement.classList.toggle("open"));
    });

    document.querySelectorAll(".export-btn").forEach((btn, idx) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); exportEntry(history[idx]); });
    });
  }
}

function exportEntry(entry) {
  let text = `FORM: ${entry.formTitle}\nDATE: ${new Date(entry.timestamp).toLocaleString()}\n\n`;
  (entry.questions || []).forEach((q, idx) => { text += `[Q${idx + 1}] ${q.q}\n${q.a}\n\n`; });
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(entry.formTitle || "Untitled_Form").replace(/[^a-z0-9]/gi, '_')}_history.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Engine Logic ──
const scanBtn = document.getElementById("gf-scan-btn");
const aiTypeSelect = document.getElementById("gf-ai-type");
const engineStatus = document.getElementById("engineStatus");

function showEngineStatus(msg, type = "loading") {
  if (!engineStatus) return;
  engineStatus.className = `status ${type}`;
  engineStatus.textContent = msg;
  engineStatus.style.display = "block";
}

if (scanBtn) {
  scanBtn.onclick = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes("docs.google.com/forms")) {
      showEngineStatus("Please open a Google Form first.", "error");
      return;
    }

    showEngineStatus("Scanning form questions...");
    chrome.tabs.sendMessage(tab.id, { action: "scanForm" }, async (response) => {
      if (chrome.runtime.lastError) {
        showEngineStatus("Could not connect to page. Refresh the form.", "error");
        return;
      }

      if (response && response.success) {
        showEngineStatus(`Scanned ${response.qc} questions.`, "success");
        const aiType = aiTypeSelect.value;
        let url = "";
        if (aiType === "claude") url = `https://claude.ai/new`;
        else if (aiType === "gemini") url = `https://gemini.google.com/app`;
        else url = `https://chatgpt.com/`;

        const toStore = { pendingPrompt: response.prompt, pendingAiType: aiType, lastGFormTabId: tab.id };
        if (aiType === "gemini" && response.images && Object.keys(response.images).length > 0) {
          toStore.pendingImages = response.images;
        }
        await chrome.storage.local.set(toStore);

        setTimeout(() => {
          showEngineStatus("Redirecting to AI...");
          chrome.runtime.sendMessage({ action: "openAI", url: url, aiType, email: response.email, scannedCount: response.qc, fromTabId: tab.id });
        }, 800);
      } else {
        showEngineStatus(response?.error || "Scan failed.", "error");
      }
    });
  };
}

// ── Settings Logic ──
const customPromptInput = document.getElementById("customPrompt");
const humanTypingInput = document.getElementById("humanTyping");
const verboseLoggingInput = document.getElementById("verboseLogging");
const diagnosticToggle = document.getElementById("diagnosticToggle");
const saveSettingsBtn = document.getElementById("saveSettings");
const settingsStatus = document.getElementById("settingsStatus");
const checkUpdateBtn = document.getElementById("checkUpdateBtn");
const updateStatus = document.getElementById("updateStatus");

const charCount = document.getElementById("charCount");

function updateCharCount() {
  if (charCount && customPromptInput) {
    const len = customPromptInput.value.length;
    charCount.textContent = `${len}/500`;
    charCount.style.color = len > 450 ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.3)";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadHistory();
  initConsentGate();
  loadPersonalProfile();

  chrome.runtime.sendMessage({ action: "fetchUserEmail" });

  if (customPromptInput) {
    customPromptInput.addEventListener("input", updateCharCount);
  }
  
  chrome.storage.local.get(["customPrompt", "humanTyping", "verboseLogging", "diagnosticEnabled", "diagnosticCaptured"], (data) => {
    if (data.customPrompt && customPromptInput) {
      customPromptInput.value = data.customPrompt;
      updateCharCount();
    }
    
    // Default humanTyping to true if not set
    const humanTypingEnabled = data.humanTyping !== undefined ? data.humanTyping : true;
    if (humanTypingInput) humanTypingInput.checked = humanTypingEnabled;
    
    // Default verboseLogging to true if not set
    const verbLogEnabled = data.verboseLogging !== undefined ? data.verboseLogging : true;
    if (verboseLoggingInput) verboseLoggingInput.checked = verbLogEnabled;

    // Default diagnosticEnabled to true if not set
    const diagEnabled = data.diagnosticEnabled !== undefined ? data.diagnosticEnabled : true;
    if (diagnosticToggle) diagnosticToggle.checked = diagEnabled;
  });
});

if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener("click", () => {
    const isDiagEnabled = diagnosticToggle ? diagnosticToggle.checked : true;
    const isVerbLogEnabled = verboseLoggingInput ? verboseLoggingInput.checked : true;
    
    chrome.storage.local.set({
      customPrompt: customPromptInput.value.trim(),
      humanTyping: humanTypingInput.checked,
      verboseLogging: isVerbLogEnabled,
      diagnosticEnabled: isDiagEnabled,
      personalProfile: collectPersonalProfile()
    }, () => {
      settingsStatus.className = "status success";
      settingsStatus.textContent = "✓ Settings saved!";
      settingsStatus.style.display = "block";
      setTimeout(() => { if (settingsStatus) settingsStatus.style.display = "none"; }, 2000);
    });
  });
}

if (checkUpdateBtn) {
  checkUpdateBtn.addEventListener("click", () => {
    checkUpdateBtn.disabled = true;
    updateStatus.className = "status loading";
    updateStatus.textContent = "Checking...";
    updateStatus.style.display = "block";
    chrome.runtime.sendMessage({ action: "manualUpdateCheck" }, (response) => {
      checkUpdateBtn.disabled = false;
      if (chrome.runtime.lastError || !response) {
        updateStatus.className = "status error";
        updateStatus.textContent = "Update check failed.";
        setTimeout(() => { if (updateStatus) updateStatus.style.display = "none"; }, 3000);
        return;
      }
      updateStatus.className = "status success";
      updateStatus.textContent = response.updateAvailable ? `✓ New version ${response.version} found!` : "✓ Latest version.";
      setTimeout(() => { if (updateStatus) updateStatus.style.display = "none"; }, 3000);
    });
  });
}

const clearBtn = document.getElementById("clearBtn");
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    const statusDiv = document.getElementById("status");
    clearBtn.disabled = true;
    statusDiv.className = "status loading";
    statusDiv.textContent = "Clearing...";
    statusDiv.style.display = "block";
    chrome.runtime.sendMessage({ action: "clearChatGPTData" }, (response) => {
      clearBtn.disabled = false;
      if (chrome.runtime.lastError || !response) {
        statusDiv.className = "status error";
        statusDiv.textContent = "Failed to clear ChatGPT data.";
        return;
      }
      statusDiv.className = response.success ? "status success" : "status error";
      statusDiv.textContent = response.message;
    });
  });
}

if (document.getElementById("viewFullLegalBtn")) {
  document.getElementById("viewFullLegalBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#legal") });
  });
}

// ── Diagnostics Tab ──
const diagRefreshBtn = document.getElementById("diagRefreshBtn");
const diagClearBtn = document.getElementById("diagClearBtn");
const diagLogList = document.getElementById("diagLogList");
const diagFormsScanned = document.getElementById("diagFormsScanned");
const diagFormsFilled = document.getElementById("diagFormsFilled");
const diagAiResponses = document.getElementById("diagAiResponses");
const diagErrors = document.getElementById("diagErrors");

function renderDiagEntry(entry) {
  const time = new Date(entry.ts).toLocaleTimeString();
  const typeColors = {
    form_scanned: "rgba(108,99,255,0.15)",
    form_filled: "rgba(34,197,94,0.15)",
    ai_response_received: "rgba(59,130,246,0.15)",
    ai_prompt_sent: "rgba(59,130,246,0.1)",
    ai_script_loaded: "rgba(255,255,255,0.05)",
    ai_prompt_found: "rgba(255,255,255,0.05)",
    ai_inject_timeout: "rgba(239,68,68,0.15)",
    form_page_load: "rgba(108,99,255,0.1)",
    error: "rgba(239,68,68,0.15)",
    diagnostic_screenshot: "rgba(255,255,255,0.05)",
  };
  const bg = typeColors[entry.type] || "rgba(255,255,255,0.03)";
  
  let detail = "";
  if (entry.formTitle) detail = entry.formTitle;
  else if (entry.platform) detail = `${entry.platform}${entry.responseTime ? ` (${(entry.responseTime/1000).toFixed(1)}s)` : ""}`;
  else if (entry.questionCount) detail = `${entry.questionCount} questions`;
  else if (entry.filled !== undefined) detail = `${entry.filled}/${entry.total} filled`;
  else if (entry.keyCount) detail = `${entry.keyCount} keys`;
  else if (entry.error) detail = entry.error;
  else if (entry.url) {
    try { detail = new URL(entry.url).pathname.split("/").pop() || entry.url; }
    catch (e) { detail = entry.url; }
  }

  return `
    <div style="background:${bg}; border-radius:8px; padding:8px 10px; margin-bottom:6px; font-size:11px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="color:rgba(255,255,255,0.7); font-weight:500;">${escapeHtml(String(entry.type || "").replace(/_/g, " "))}</span>
        <span style="color:rgba(255,255,255,0.3); font-size:10px;">${escapeHtml(time)}</span>
      </div>
      ${detail ? `<div style="color:rgba(255,255,255,0.5); margin-top:3px; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(detail)}</div>` : ""}
    </div>
  `;
}

async function loadDiagnostics() {
  const res = await chrome.runtime.sendMessage({ action: "diagGetLogs" });
  const logs = res?.logs || [];
  
  if (diagLogList) {
    if (logs.length === 0) {
      diagLogList.innerHTML = '<div class="empty-history">No diagnostic data yet.</div>';
    } else {
      diagLogList.innerHTML = logs.map(renderDiagEntry).join("");
    }
  }
  
  const counts = { form_scanned: 0, form_filled: 0, ai_response_received: 0, error: 0 };
  for (const entry of logs) {
    if (counts[entry.type] !== undefined) counts[entry.type]++;
  }
  if (diagFormsScanned) diagFormsScanned.textContent = counts.form_scanned;
  if (diagFormsFilled) diagFormsFilled.textContent = counts.form_filled;
  if (diagAiResponses) diagAiResponses.textContent = counts.ai_response_received;
  if (diagErrors) diagErrors.textContent = counts.error;
}

if (diagRefreshBtn) {
  diagRefreshBtn.addEventListener("click", loadDiagnostics);
}

if (diagClearBtn) {
  diagClearBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "diagClearLogs" });
    loadDiagnostics();
  });
}

// ── Developer Modal Logic ──
document.addEventListener("DOMContentLoaded", () => {
  const devModalBtn = document.getElementById("devModalBtn");
  const devModal = document.getElementById("devModal");
  const closeDevModal = document.getElementById("closeDevModal");

  if (devModalBtn && devModal && closeDevModal) {
    devModalBtn.addEventListener("click", (e) => {
      e.preventDefault();
      devModal.style.display = "flex";
    });

    closeDevModal.addEventListener("click", () => {
      devModal.style.display = "none";
    });

    window.addEventListener("click", (e) => {
      if (e.target === devModal) {
        devModal.style.display = "none";
      }
    });
  }
});
