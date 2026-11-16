// Image Collector - background service worker.
// Keeps the ordered, de-duplicated list of images in chrome.storage.local
// (and bytes of in-page blob: images in IndexedDB) so nothing is lost when
// the service worker goes to sleep.
importScripts("db.js");

const ICON = (state) => ({
  16: `icons/${state}16.png`, 32: `icons/${state}32.png`,
  48: `icons/${state}48.png`, 128: `icons/${state}128.png`
});

let enabled = false;
let siteOnly = "";        // hostname, or "" for every site
let images = [];          // [{ url, page, name?, stored? }]
let seen = new Set();
let ready = load();
let saveTimer = null;

async function load() {
  const s = await chrome.storage.local.get({ enabled: false, images: [], siteOnly: "" });
  enabled = s.enabled;
  siteOnly = s.siteOnly;
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
  const where = siteOnly ? ` from ${siteOnly}` : "";
  chrome.action.setTitle({ title: `Image Collector (${enabled ? "ON" : "OFF"}) - ${images.length} images${where}` });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#2563eb" : "#6b7280" });
  chrome.action.setBadgeText({ text: images.length ? String(images.length > 9999 ? "9999+" : images.length) : "" });
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

// With "only this website" on, accept a page if it is that site or one of its subdomains.
function pageAllowed(page) {
  if (!siteOnly) return true;
  const h = hostOf(page);
  return h === siteOnly || h.endsWith("." + siteOnly);
}

function isImageUrl(url) {
  return typeof url === "string" && /^(https?:|data:image\/)/i.test(url) && url.length < 2_000_000;
}

function addImages(items, page) {
  if (!enabled || !pageAllowed(page)) return 0;
  let added = 0;
  for (const it of items) {
    const url = (typeof it === "string" ? it : it.url || "").trim();
    const name = typeof it === "string" ? "" : it.name || "";
    if (!isImageUrl(url)) continue;
    if (seen.has(url)) {
      // Seen first by the network listener; keep the name the page gave it.
      if (name) { const ex = images.find((i) => i.url === url); if (ex && !ex.name) { ex.name = name; scheduleSave(); } }
      continue;
    }
    seen.add(url);
    images.push(name ? { url, page: page || "", name } : { url, page: page || "" });
    added++;
  }
  if (added) { scheduleSave(); updateBadge(); }
  return added;
}

// A blob: image the page made itself. The content script sends its bytes;
// we keep them in IndexedDB and de-duplicate by content.
async function addBlob(msg, page) {
  if (!enabled || !pageAllowed(page)) return 0;
  const res = await fetch(msg.dataUrl);
  const buf = await res.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
    .slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Same picture under a different label (e.g. two blank book pages) is kept as its own file.
  const key = "stored:" + (msg.name ? msg.name + ":" : "") + hash;
  if (seen.has(key)) return 0;
  seen.add(key);
  await DB.put(hash, { type: res.headers.get("content-type") || "", data: buf });
  images.push({ url: key, page: page || "", name: msg.name || "", stored: hash, source: msg.source || "" });
  scheduleSave();
  updateBadge();
  return 1;
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

function state() {
  return { enabled, siteOnly, count: images.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    const page = sender.tab ? sender.tab.url : msg.page;
    switch (msg.type) {
      case "found":
        sendResponse({ added: addImages(msg.urls, page) });
        break;
      case "foundBlob":
        sendResponse({ added: await addBlob(msg, page).catch(() => 0) });
        break;
      case "getState":
        sendResponse(state());
        break;
      case "setEnabled":
        enabled = !!msg.enabled;
        await chrome.storage.local.set({ enabled });
        updateBadge();
        broadcastState();
        sendResponse(state());
        break;
      case "setSiteOnly":
        siteOnly = msg.site || "";
        await chrome.storage.local.set({ siteOnly });
        updateBadge();
        broadcastState();
        sendResponse(state());
        break;
      case "getImages":
        sendResponse({ images });
        break;
      case "clear":
        images = []; seen = new Set();
        await chrome.storage.local.set({ images });
        await DB.clear().catch(() => {});
        updateBadge();
        broadcastState(); // lets open pages report their images again
        sendResponse(state());
        break;
      default:
        sendResponse({});
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(() => ready);
chrome.runtime.onInstalled.addListener(() => ready);
