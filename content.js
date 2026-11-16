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

  // blob: images only exist inside this page, so grab their bytes right away.
  function captureBlob(img) {
    const u = img.currentSrc || img.src;
    if (!enabled || !u || !u.startsWith("blob:") || blobDone.has(u)) return;
    blobDone.add(u);
    const go = async () => {
      let blob = null;
      try { const r = await fetch(u); if (r.ok) blob = await r.blob(); } catch {}
      if (!blob || !blob.size || !blob.type.startsWith("image/")) blob = (await canvasBlob(img)) || blob;
      if (!blob || !blob.size) { blobDone.delete(u); return; }
      const dataUrl = await blobToDataUrl(blob);
      chrome.runtime.sendMessage({ type: "foundBlob", dataUrl, name: nameFor(img), page: location.href }).catch(() => {});
    };
    if (img.complete && img.naturalWidth) go();
    else img.addEventListener("load", go, { once: true });
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
      else add(src, nameFor(el));
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "state") setEnabled(msg.enabled);
  });

  chrome.storage.local.get({ enabled: false }).then((s) => setEnabled(s.enabled));
})();
