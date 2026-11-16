const $ = (id) => document.getElementById(id);

function render(state) {
  $("enabled").checked = state.enabled;
  $("stateText").textContent = state.enabled ? "ON" : "OFF";
  $("count").textContent = state.count;
  $("download").disabled = state.count === 0;
  $("clear").disabled = state.count === 0;
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

$("clear").addEventListener("click", async () => {
  render(await chrome.runtime.sendMessage({ type: "clear" }));
});

$("download").addEventListener("click", () => {
  const skip = $("skipSmall").checked ? "1" : "0";
  chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?skipSmall=${skip}`) });
  window.close();
});

chrome.storage.local.get({ skipSmall: false }).then((s) => { $("skipSmall").checked = s.skipSmall; });
$("skipSmall").addEventListener("change", (e) => chrome.storage.local.set({ skipSmall: e.target.checked }));

chrome.storage.onChanged.addListener(refresh);
refresh();
