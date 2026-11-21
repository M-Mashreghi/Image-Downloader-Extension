const $ = (id) => document.getElementById(id);
let currentHost = "";

async function activeHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { const u = new URL(tab.url); return /^https?:$/.test(u.protocol) ? u.hostname : ""; } catch { return ""; }
}

function render(state) {
  $("enabled").checked = state.enabled;
  $("stateText").textContent = state.enabled ? "ON" : "OFF";
  $("count").textContent = state.count;
  $("download").disabled = state.count === 0;
  $("clear").disabled = state.count === 0;
  $("siteOnly").checked = !!state.siteOnly;
  $("siteName").textContent = state.siteOnly || (currentHost ? currentHost : "");
  $("hint").textContent = state.enabled
    ? "Collecting… scroll around and open pages to grab more."
    : "Turn it on, then browse. Every image you see is added.";
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: "getState" }));
}

$("enabled").addEventListener("change", async (e) => {
  render(await chrome.runtime.sendMessage({ type: "setEnabled", enabled: e.target.checked }));
});

$("siteOnly").addEventListener("change", async (e) => {
  if (e.target.checked && !currentHost) { e.target.checked = false; $("hint").textContent = "Open a website tab first, then tick this."; return; }
  render(await chrome.runtime.sendMessage({ type: "setSiteOnly", site: e.target.checked ? currentHost : "" }));
});

$("clear").addEventListener("click", async () => {
  render(await chrome.runtime.sendMessage({ type: "clear" }));
});

$("download").addEventListener("click", () => {
  const skip = $("skipSmall").checked ? "1" : "0";
  const q = new URLSearchParams({ skipSmall: skip, name: $("zipName").value.trim() });
  chrome.tabs.create({ url: chrome.runtime.getURL("download.html?" + q) });
  window.close();
});

chrome.storage.local.get({ skipSmall: false }).then((s) => { $("skipSmall").checked = s.skipSmall; });
$("skipSmall").addEventListener("change", (e) => chrome.storage.local.set({ skipSmall: e.target.checked }));

chrome.storage.onChanged.addListener(refresh);
activeHost().then((h) => { currentHost = h; refresh(); });

// ---- Auto-scroll ----
let autoRunning = false;
function renderAuto(running) {
  autoRunning = running;
  $("autoBtn").textContent = running ? "■ Stop scrolling" : "⬇ Auto-scroll";
  $("autoBtn").classList.toggle("running", running);
}
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}
chrome.storage.local.get({ speed: "normal" }).then((s) => { $("speed").value = s.speed; });
$("speed").addEventListener("change", (e) => chrome.storage.local.set({ speed: e.target.value }));
activeTabId().then((id) => chrome.tabs.sendMessage(id, { type: "autoscrollState" }))
  .then((r) => renderAuto(!!(r && r.running))).catch(() => {});
$("autoBtn").addEventListener("click", async () => {
  try {
    const id = await activeTabId();
    if (!autoRunning) {
      // Make sure collecting is on while it scrolls.
      if (!$("enabled").checked) render(await chrome.runtime.sendMessage({ type: "setEnabled", enabled: true }));
      const r = await chrome.tabs.sendMessage(id, { type: "autoscroll", on: true, speed: $("speed").value, name: $("zipName").value.trim() });
      if (r && r.ok) { renderAuto(true); window.close(); }
      else $("autoHint").textContent = (r && r.error) || "Couldn't scroll this page.";
    } else {
      await chrome.tabs.sendMessage(id, { type: "autoscroll", on: false });
      renderAuto(false);
    }
  } catch {
    $("autoHint").textContent = "Reload this page first (F5), then try again.";
  }
});

chrome.storage.local.get({ autoFinish: false }).then((s) => { $("autoFinish").checked = s.autoFinish; });
$("autoFinish").addEventListener("change", (e) => chrome.storage.local.set({ autoFinish: e.target.checked }));

// ZIP name: remembered while you browse, emptied when the list is cleared.
chrome.storage.local.get({ zipName: "" }).then((s) => { $("zipName").value = s.zipName; });
$("zipName").addEventListener("input", (e) => chrome.storage.local.set({ zipName: e.target.value }));
chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
  if (t && t.title && /^https?:/.test(t.url || "")) $("zipName").placeholder = t.title.slice(0, 60);
});
