// Image Collector - content script.
// While the collector is ON, finds every image on the page (img, srcset,
// <picture>, CSS backgrounds, video posters, SVG <image>, lazy-load attributes)
// and keeps watching the page for new ones as you scroll.
(() => {
  if (window.__imageCollectorLoaded) return;
  window.__imageCollectorLoaded = true;

  let enabled = false;
  let observer = null;
  let pending = new Set();
  let reported = new Set();
  let flushTimer = null;
  let scanTimer = null;
  const names = new Map();      // url -> file name (from aria-labelledby)
  const blobDone = new Set();   // blob: URLs already captured

  // File name for an image, e.g. aria-labelledby="caption492" -> "caption492".
  function nameFor(el) {
    const v = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/)[0];
    return v ? v.replace(/[^\w.-]+/g, "_").slice(0, 100) : "";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Fallback when the blob: URL was already revoked: copy the shown image.
  function canvasBlob(img) {
    return new Promise((resolve) => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        if (!c.width || !c.height) return resolve(null);
        c.getContext("2d").drawImage(img, 0, 0);
        c.toBlob((b) => resolve(b), "image/png");
      } catch { resolve(null); }
    });
  }

  // Ask the page-side hook (page-hook.js) for the bytes behind a blob: URL.
  const waiting = new Map();
  let reqId = 0;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__imageCollector !== "blob") return;
    const cb = waiting.get(d.id);
    if (cb) { waiting.delete(d.id); cb(d); }
  });
  function askPage(url) {
    return new Promise((resolve) => {
      const id = ++reqId;
      const t = setTimeout(() => { waiting.delete(id); resolve(null); }, 3000);
      waiting.set(id, (d) => { clearTimeout(t); resolve(d.ok ? d : null); });
      window.postMessage({ __imageCollector: "get", id, url }, "*");
    });
  }

  // Save the image behind a blob: URL (the page's own copy), named after its label.
  async function captureUrl(u, name, img) {
    if (!enabled || !u || blobDone.has(u)) return;
    blobDone.add(u);
    let blob = null, source = "";
    const fromPage = await askPage(u);                        // 1) the original file, kept by page-hook.js
    if (fromPage) { blob = new Blob([fromPage.buf], { type: fromPage.type }); source = fromPage.src || ""; }
    if (!blob || !blob.size) {                                 // 2) read the blob: URL directly
      try { const r = await fetch(u); if (r.ok) blob = await r.blob(); } catch {}
    }
    if ((!blob || !blob.size) && img) blob = await canvasBlob(img);   // 3) copy the picture on screen
    if (!blob || !blob.size) { blobDone.delete(u); return; }
    const dataUrl = await blobToDataUrl(blob);
    chrome.runtime.sendMessage({ type: "foundBlob", dataUrl, name, source, page: location.href }).catch(() => {});
  }

  // The page hook reports blob: images the instant they are put on screen.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__imageCollector !== "shown") return;
    const label = String(d.label || "").trim().split(/\s+/)[0];
    captureUrl(d.url, label ? label.replace(/[^\w.-]+/g, "_").slice(0, 100) : "", null);
  });

  // blob: images found while scanning the page.
  function captureBlob(img) {
    const u = img.currentSrc || img.src;
    if (!enabled || !u || !u.startsWith("blob:") || blobDone.has(u)) return;
    const name = nameFor(img);
    if (img.complete && img.naturalWidth) captureUrl(u, name, img);
    else {
      const go = () => captureUrl(u, name, img);
      img.addEventListener("load", go, { once: true });
      img.addEventListener("error", go, { once: true });
    }
  }

  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url",
    "data-hi-res-src", "data-full", "data-large", "data-zoom-image", "data-srcset", "data-lazy-srcset"];

  function abs(u) {
    if (!u) return null;
    u = u.trim();
    if (!u || u.startsWith("blob:") || u.startsWith("javascript:")) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  }

  function add(u, name) {
    const a = abs(u);
    if (!a || reported.has(a)) return;
    if (!/^(https?:|data:image\/)/i.test(a)) return;
    if (name) names.set(a, name);
    pending.add(a);
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }

  function flush() {
    flushTimer = null;
    if (!pending.size || !enabled) { pending.clear(); return; }
    const urls = [...pending].map((u) => (names.has(u) ? { url: u, name: names.get(u) } : u));
    pending.clear();
    urls.forEach((u) => reported.add(u.url || u));
    chrome.runtime.sendMessage({ type: "found", urls, page: location.href }).catch(() => {});
  }

  // Pick every candidate from a srcset ("a.jpg 1x, b.jpg 2x").
  function addSrcset(s) {
    if (!s) return;
    s.split(/,\s+(?=\S)/).forEach((part) => add(part.trim().split(/\s+/)[0]));
  }

  function addCssUrls(value) {
    if (!value || value === "none" || !value.includes("url(")) return;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) add(m[2]);
  }

  function scanElement(el) {
    if (!(el instanceof Element)) return;
    const tag = el.tagName;
    if (tag === "IMG") {
      const src = el.currentSrc || el.src;
      if (src && src.startsWith("blob:")) captureBlob(el);
      else add(src, src && src.startsWith("data:") ? "" : nameFor(el));
      addSrcset(el.getAttribute("srcset"));
    } else if (tag === "SOURCE" && el.parentElement && el.parentElement.tagName === "PICTURE") {
      addSrcset(el.getAttribute("srcset"));
    } else if (tag === "VIDEO") {
      add(el.getAttribute("poster"));
    } else if (tag === "INPUT" && el.type === "image") {
      add(el.src);
    } else if (tag === "image" || tag === "IMAGE") { // SVG <image>
      add(el.getAttribute("href") || el.getAttribute("xlink:href"));
    }
    for (const a of LAZY_ATTRS) {
      const v = el.getAttribute(a);
      if (v) (a.includes("srcset") ? addSrcset(v) : add(v));
    }
    const inline = el.getAttribute("style");
    if (inline && inline.includes("url(")) addCssUrls(inline);
  }

  function scanComputed(el) {
    try {
      const cs = getComputedStyle(el);
      addCssUrls(cs.backgroundImage);
      addCssUrls(cs.listStyleImage);
      addCssUrls(cs.borderImageSource);
      addCssUrls(getComputedStyle(el, "::before").backgroundImage);
      addCssUrls(getComputedStyle(el, "::after").backgroundImage);
    } catch {}
  }

  // Full page scan, done in small chunks so the page stays responsive.
  function fullScan() {
    if (!enabled) return;
    const all = document.querySelectorAll("*");
    let i = 0;
    const step = (deadline) => {
      if (!enabled) return;
      const end = performance.now() + 12;
      while (i < all.length && performance.now() < end) {
        const el = all[i++];
        scanElement(el);
        scanComputed(el);
      }
      if (i < all.length) schedule(step);
    };
    schedule(step);
  }

  function schedule(fn) {
    if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 16);
  }

  function scanSubtree(node) {
    if (!(node instanceof Element)) return;
    scanElement(node);
    scanComputed(node);
    const kids = node.querySelectorAll("*");
    for (let k = 0; k < kids.length && k < 3000; k++) { scanElement(kids[k]); scanComputed(kids[k]); }
  }

  function debouncedScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(fullScan, 1500);
  }

  function onScroll() { if (enabled) debouncedScan(); }

  function start() {
    if (observer) return;
    fullScan();
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") m.addedNodes.forEach(scanSubtree);
        else if (m.type === "attributes") { scanElement(m.target); if (m.attributeName !== "src") scanComputed(m.target); }
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["src", "srcset", "style", "class", "poster", "href", ...LAZY_ATTRS]
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("load", fullScan);
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("load", fullScan);
    clearTimeout(scanTimer);
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled) { reported.clear(); blobDone.clear(); start(); } else stop();
  }

  // ---- Auto-scroll (top frame only): slowly scrolls the page so lazy images load ----
  const SPEEDS = { slow: 120, normal: 300, fast: 700 };   // pixels per second
  let auto = null;   // { timer, target, speed, lastPos, stuckSince, badge }

  function scrollTargets() {
    const list = [];
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 50) list.push(root);
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollHeight <= el.clientHeight + 50 || el.clientHeight < 150) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") list.push(el);
    }
    // The biggest visible scroll area is usually the reader / main content.
    const area = (el) => (el === root ? innerWidth * innerHeight : el.clientWidth * el.clientHeight);
    return list.sort((a, b) => area(b) - area(a));
  }

  function posOf(el) { return el.scrollTop; }

  function makeBadge(speed) {
    const b = document.createElement("div");
    b.textContent = "⬇ Auto-scrolling (" + speed + ") – click or press Esc to stop";
    Object.assign(b.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483647, padding: "8px 12px",
      background: "#2563eb", color: "#fff", font: "600 13px system-ui, sans-serif", borderRadius: "8px",
      boxShadow: "0 2px 10px rgba(0,0,0,.3)", cursor: "pointer"
    });
    b.addEventListener("click", () => stopAuto("Stopped"));
    (document.body || document.documentElement).appendChild(b);
    return b;
  }

  function onKey(e) { if (e.key === "Escape") stopAuto("Stopped"); }

  function startAuto(speedName) {
    stopAuto();
    const targets = scrollTargets();
    if (!targets.length) return { ok: false, error: "Nothing to scroll on this page." };
    const speed = SPEEDS[speedName] || SPEEDS.normal;
    auto = { targets, i: 0, speedName, step: speed / 10, lastPos: -1, stuckSince: Date.now(), carry: 0 };
    auto.badge = makeBadge(speedName);
    addEventListener("keydown", onKey, true);
    auto.timer = setInterval(tick, 100);
    return { ok: true };
  }

  function tick() {
    if (!auto) return;
    const t = auto.targets[auto.i];
    auto.carry += auto.step;
    const px = Math.floor(auto.carry);
    auto.carry -= px;
    t.scrollTop += px;
    const pos = posOf(t);
    if (pos !== auto.lastPos) { auto.lastPos = pos; auto.stuckSince = Date.now(); return; }
    const stuck = Date.now() - auto.stuckSince;
    // This area doesn't move at all: try the next scrollable area.
    if (stuck > 1500 && auto.lastPos <= 0 && auto.i < auto.targets.length - 1) {
      auto.i++; auto.lastPos = -1; auto.stuckSince = Date.now(); return;
    }
    // Reached the bottom and nothing new loaded for 10 seconds: done.
    if (stuck > 10000) stopAuto("Reached the end");
  }

  function stopAuto(msg) {
    if (!auto) return;
    clearInterval(auto.timer);
    removeEventListener("keydown", onKey, true);
    const b = auto.badge;
    auto = null;
    if (b) {
      if (msg) { b.textContent = "✓ Auto-scroll: " + msg; b.style.background = "#16a34a"; setTimeout(() => b.remove(), 4000); }
      else b.remove();
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "state") setEnabled(msg.enabled);
    if (window !== window.top) return;
    if (msg.type === "autoscroll") sendResponse(msg.on ? startAuto(msg.speed) : (stopAuto("Stopped"), { ok: true }));
    else if (msg.type === "autoscrollState") sendResponse({ running: !!auto, speed: auto ? auto.speedName : "" });
  });

  chrome.storage.local.get({ enabled: false }).then((s) => setEnabled(s.enabled));
})();
