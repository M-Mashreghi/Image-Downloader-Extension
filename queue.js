// Image Collector - volume queue (runs inside the background service worker).
// Opens each queued page, starts auto-scroll with "download & close" on, and
// when that page's ZIP has been saved, waits a little and opens the next one.
// State lives in chrome.storage.local so it survives the worker going to sleep.
const Q = {
  DEFAULTS: { queue: [], queueRunning: false, queueTabId: null, queueCurrent: -1,
    queuePause: 30, queueSpeed: "normal", queueMsg: "" },

  get() { return chrome.storage.local.get(Q.DEFAULTS); },
  set(v) { return chrome.storage.local.set(v); },

  // A finished ZIP for this item already exists in Downloads (e.g. saved by hand)?
  async alreadyDownloaded(item) {
    let key = "";
    try { key = new URL(item.url).searchParams.get("id") || ""; } catch {}
    key = key || item.name;
    if (!key) return false;
    const found = await chrome.downloads.search({ query: [key], state: "complete", exists: true }).catch(() => []);
    return found.some((d) => /\.zip$/i.test(d.filename || "") && (d.filename || "").includes(key));
  },

  async start() {
    const s = await Q.get();
    if (!s.queue.some((i) => i.status === "waiting" || i.status === "running")) {
      await Q.set({ queueMsg: "Nothing left to do in the queue." });
      return;
    }
    s.queue.forEach((i) => { if (i.status === "running") i.status = "waiting"; });
    await Q.set({ queue: s.queue, queueRunning: true, queueMsg: "", autoFinish: true });
    await setCollecting(true);
    await clearList();
    await Q.openNext();
  },

  async stop(msg) {
    const s = await Q.get();
    s.queue.forEach((i) => { if (i.status === "running") i.status = "waiting"; });
    await chrome.alarms.clear("queueNext");
    await Q.set({ queue: s.queue, queueRunning: false, queueTabId: null, queueCurrent: -1, queueMsg: msg || "Stopped." });
  },

  async openNext() {
    const s = await Q.get();
    if (!s.queueRunning) return;
    let idx = -1;
    for (let i = 0; i < s.queue.length; i++) {
      const it = s.queue[i];
      if (it.status !== "waiting") continue;
      if (await Q.alreadyDownloaded(it)) { it.status = "done"; it.note = "already in Downloads"; continue; }
      idx = i; break;
    }
    if (idx < 0) {
      await Q.set({ queue: s.queue, queueRunning: false, queueTabId: null, queueCurrent: -1, queueMsg: "All done ✓" });
      return;
    }
    s.queue[idx].status = "running";
    s.queue[idx].note = "";
    const tab = await chrome.tabs.create({ url: s.queue[idx].url, active: true });
    await Q.set({ queue: s.queue, queueTabId: tab.id, queueCurrent: idx, queueMsg: "" });
  },

  // The queued page finished loading: give the reader a moment, then start auto-scroll.
  async pageLoaded(tabId) {
    const s = await Q.get();
    if (!s.queueRunning || tabId !== s.queueTabId) return;
    const item = s.queue[s.queueCurrent];
    if (!item) return;
    await new Promise((r) => setTimeout(r, 6000));
    for (let attempt = 0; attempt < 6; attempt++) {
      const now = await Q.get();
      if (!now.queueRunning || now.queueTabId !== tabId) return;
      const r = await chrome.tabs.sendMessage(tabId, { type: "autoscroll", on: true, speed: now.queueSpeed, name: item.name, finish: true })
        .catch(() => null);
      if (r && r.ok) return;
      await new Promise((res) => setTimeout(res, 4000));
    }
    await Q.fail("Couldn't start scrolling on this page (blocked, error page, or not a book reader).");
  },

  // download.js saved the ZIP for the page it was asked to close.
  async saved(closedTabId, filename) {
    const s = await Q.get();
    if (!s.queueRunning || closedTabId !== s.queueTabId) return;
    const item = s.queue[s.queueCurrent];
    if (item) { item.status = "done"; item.note = filename || ""; }
    await Q.set({ queue: s.queue, queueTabId: null, queueCurrent: -1 });
    if (!s.queue.some((i) => i.status === "waiting")) return Q.openNext();  // nothing left: finish now
    const pause = Math.max(30, Number(s.queuePause) || 30);  // Chrome alarms can't fire sooner than 30 s
    await Q.set({ queueMsg: `Next page in ${pause} s…` });
    chrome.alarms.create("queueNext", { when: Date.now() + pause * 1000 });
  },

  async fail(note) {
    const s = await Q.get();
    const item = s.queue[s.queueCurrent];
    if (item) { item.status = "failed"; item.note = note; }
    await Q.set({ queue: s.queue });
    await Q.stop("Stopped: " + note);
  }
};

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "queueNext") return;
  await ready;
  await Q.set({ queueMsg: "" });
  await Q.openNext();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const s = await Q.get();
  if (s.queueRunning && tabId === s.queueTabId) Q.pageLoaded(tabId);
});

// The user closed the queued page themselves: stop instead of going on.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await Q.get();
  if (s.queueRunning && tabId === s.queueTabId) await Q.stop("Stopped: the page was closed before its ZIP was saved.");
});
