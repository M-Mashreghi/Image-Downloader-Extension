// Image Collector - runs inside the page itself (MAIN world) from the very start.
// Some sites (e.g. book readers like HathiTrust) download each page image with
// fetch(), turn it into a short-lived blob: URL, and throw it away when you
// scroll on. This keeps a reference to those image blobs (and where they were
// downloaded from) so the extension can save the real file, even after the
// page has revoked the blob: URL.
(() => {
  if (window.__imageCollectorHook) return;
  window.__imageCollectorHook = true;

  const MAX = 300;
  const blobs = new Map();          // blob: URL -> { blob, src }
  const sourceOf = new WeakMap();   // Blob -> URL it was downloaded from

  const origBlob = Response.prototype.blob;
  Response.prototype.blob = function () {
    const url = this.url;
    return origBlob.call(this).then((b) => {
      try { if (url) sourceOf.set(b, url); } catch {}
      return b;
    });
  };

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const u = origCreate.apply(this, arguments);
    try {
      if (obj instanceof Blob && (!obj.type || obj.type.startsWith("image/"))) {
        blobs.set(u, { blob: obj, src: sourceOf.get(obj) || "" });
        if (blobs.size > MAX) blobs.delete(blobs.keys().next().value);
      }
    } catch {}
    return u;
  };

  // Tell the extension the moment a page image is switched to a blob: URL,
  // so it can be saved even if the page swaps it out again right away.
  function announce(img, url) {
    try {
      if (typeof url === "string" && url.startsWith("blob:") && blobs.has(url)) {
        window.postMessage({ __imageCollector: "shown", url, label: img.getAttribute("aria-labelledby") || "" }, "*");
      }
    } catch {}
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (desc && desc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...desc,
      set(v) { desc.set.call(this, v); announce(this, String(v)); }
    });
  }
  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const r = origSetAttr.apply(this, arguments);
    if (this instanceof HTMLImageElement && String(name).toLowerCase() === "src") announce(this, String(value));
    return r;
  };

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__imageCollector !== "get") return;
    const rec = blobs.get(d.url);
    if (!rec) { window.postMessage({ __imageCollector: "blob", id: d.id, ok: false }, "*"); return; }
    try {
      const buf = await rec.blob.arrayBuffer();
      window.postMessage({ __imageCollector: "blob", id: d.id, ok: true, buf, type: rec.blob.type, src: rec.src }, "*", [buf]);
    } catch {
      window.postMessage({ __imageCollector: "blob", id: d.id, ok: false }, "*");
    }
  });
})();
