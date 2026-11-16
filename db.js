// Tiny IndexedDB store for image bytes captured inside pages (blob: images).
const DB = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const req = indexedDB.open("image-collector", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("blobs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("blobs", mode);
      const r = fn(t.objectStore("blobs"));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  },
  put(key, value) { return this.tx("readwrite", (s) => s.put(value, key)); },
  get(key) { return this.tx("readonly", (s) => s.get(key)); },
  clear() { return this.tx("readwrite", (s) => s.clear()); }
};
