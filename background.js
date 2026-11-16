// Image Collector - background service worker.
// Keeps the ordered, de-duplicated list of image URLs in chrome.storage.local
// so nothing is lost when the service worker goes to sleep.

const ICON = (state) => ({
  16: `icons/${state}16.png`, 32: `icons/${state}32.png`,
  48: `icons/${state}48.png`, 128: `icons/${state}128.png`
});

let enabled = false;
let images = [];          // [{ url, page }]
let seen = new Set();
let ready = load();
let saveTimer = null;

async function load() {
  const s = await chrome.storage.local.get({ enabled: false, images: [] });
  enabled = s.enabled;
  images = s.images;
  seen = new Set(images.map((i) => i.url));
  updateBadge();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local.set({ images });
  }, 300);
}

function updateBadge() {
  chrome.action.setIcon({ path: ICON(enabled ? "on" : "off") });
  chrome.action.setTitle({ title: `Image Collector (${enabled ? "ON" : "OFF"}) - ${images.length} images` });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#2563eb" : "#6b7280" });
  chrome.action.setBadgeText({ text: images.length ? String(images.length > 9999 ? "9999+" : images.length) : "" });
}

function isImageUrl(url) {
  return typeof url === "string" && /^(https?:|data:image\/)/i.test(url) && url.length < 2_000_000;
}

function addImages(urls, page) {
  if (!enabled) return 0;
  let added = 0;
  for (const raw of urls) {
    const url = (raw || "").trim();
    if (!isImageUrl(url) || seen.has(url)) continue;
    seen.add(url);
    images.push({ url, page: page || "" });
    added++;
  }
  if (added) { scheduleSave(); updateBadge(); }
  return added;
}

// Catch images the network loads (CSS backgrounds, lazy loads, etc.).
chrome.webRequest.onCompleted.addListener(
  async (d) => {
    await ready;
    if (!enabled || d.statusCode < 200 || d.statusCode >= 300) return;
    if (d.initiator && d.initiator.startsWith("chrome-extension://")) return;
    addImages([d.url], d.documentUrl || d.initiator || "");
  },
  { urls: ["<all_urls>"], types: ["image"] }
);

async function broadcastState() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: "state", enabled }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case "found":
        sendResponse({ added: addImages(msg.urls, sender.tab ? sender.tab.url : msg.page) });
        break;
      case "getState":
        sendResponse({ enabled, count: images.length });
        break;
      case "setEnabled":
        enabled = !!msg.enabled;
        await chrome.storage.local.set({ enabled });
        updateBadge();
        broadcastState();
        sendResponse({ enabled, count: images.length });
        break;
      case "getImages":
        sendResponse({ images });
        break;
      case "clear":
        images = []; seen = new Set();
        await chrome.storage.local.set({ images });
        updateBadge();
        broadcastState(); // lets open pages report their images again
        sendResponse({ enabled, count: 0 });
        break;
      default:
        sendResponse({});
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(() => ready);
chrome.runtime.onInstalled.addListener(() => ready);
