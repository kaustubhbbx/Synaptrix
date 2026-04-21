// popup.js — handles API key save/load and provider selection

const geminiInput = document.getElementById("geminiKey");
const groqInput   = document.getElementById("groqKey");
const saveBtn     = document.getElementById("saveBtn");
const savedMsg    = document.getElementById("savedMsg");
const activeBadge = document.getElementById("activeBadge");
const activeBadgeText = document.getElementById("activeBadgeText");

const providerTabs = document.querySelectorAll(".provider-tab");
let selectedProvider = "auto";

// ── Determine active provider (mirrors background.js logic) ──
function resolveActiveProvider(geminiKey, groqKey, provider) {
  const hasGemini = geminiKey && geminiKey !== "YOUR_GEMINI_API_KEY_HERE" && geminiKey.trim().length > 0;
  const hasGroq   = groqKey   && groqKey   !== "YOUR_GROQ_API_KEY_HERE"   && groqKey.trim().length > 0;

  if (provider === "gemini" && hasGemini) return "gemini";
  if (provider === "groq"   && hasGroq)   return "groq";

  if (provider === "auto") {
    if (hasGemini) return "gemini";
    if (hasGroq)   return "groq";
  }

  if (hasGemini) return "gemini";
  if (hasGroq)   return "groq";

  return "none";
}

// ── Update the active provider badge ─────────────────────────
function updateActiveBadge(geminiKey, groqKey, provider) {
  const active = resolveActiveProvider(geminiKey, groqKey, provider);

  activeBadge.className = "active-badge " + active;

  if (active === "gemini") {
    activeBadgeText.textContent = "Using Gemini Flash — with Google Search grounding";
  } else if (active === "groq") {
    activeBadgeText.textContent = "Using Groq Llama 3.3 — fast inference mode";
  } else {
    activeBadgeText.textContent = "No API key configured — enter a key below";
  }
}

// ── Load saved settings on open ──────────────────────────────
chrome.storage.local.get(["geminiApiKey", "groqApiKey", "aiProvider"], (result) => {
  if (result.geminiApiKey) geminiInput.value = result.geminiApiKey;
  if (result.groqApiKey)   groqInput.value   = result.groqApiKey;

  selectedProvider = result.aiProvider || "auto";

  // Highlight the active tab
  providerTabs.forEach(tab => {
    tab.classList.toggle("active", tab.dataset.provider === selectedProvider);
  });

  // Update badge
  updateActiveBadge(
    result.geminiApiKey || "",
    result.groqApiKey || "",
    selectedProvider
  );
});

// ── Provider tab click handlers ──────────────────────────────
providerTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    selectedProvider = tab.dataset.provider;
    providerTabs.forEach(t => t.classList.toggle("active", t === tab));

    // Live-update badge
    updateActiveBadge(
      geminiInput.value.trim(),
      groqInput.value.trim(),
      selectedProvider
    );
  });
});

// ── Save button ──────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const geminiKey = geminiInput.value.trim();
  const groqKey   = groqInput.value.trim();

  if (!geminiKey && !groqKey) {
    savedMsg.style.color = "#ff6666";
    savedMsg.textContent = "⚠️ Enter at least one API key.";
    return;
  }

  const data = { aiProvider: selectedProvider };
  if (geminiKey) data.geminiApiKey = geminiKey;
  if (groqKey)   data.groqApiKey   = groqKey;

  // Clear keys that were emptied
  if (!geminiKey) data.geminiApiKey = "";
  if (!groqKey)   data.groqApiKey   = "";

  chrome.storage.local.set(data, () => {
    savedMsg.style.color = "#4caf94";
    savedMsg.textContent = "✅ Settings saved! Reload your ChatGPT tab.";
    setTimeout(() => { savedMsg.textContent = ""; }, 3000);

    // Update badge
    updateActiveBadge(geminiKey, groqKey, selectedProvider);
  });
});
