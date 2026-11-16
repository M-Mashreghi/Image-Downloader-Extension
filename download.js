// Fetches every collected image, names them 1, 2, 3… and saves one ZIP.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SKIP_SMALL = params.get("skipSmall") === "1";
const MIN_SIDE = 50;
const CONCURRENCY = 6;

const TYPE_EXT = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/tiff": "tiff", "image/apng": "png",
  "image/heic": "heic", "image/heif": "heif", "image/jxl": "jxl"
};

function sniff(b) {
  const h = (i) => b[i];
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) return "jpg";
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47) return "png";
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46) return "gif";
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46 && h(8) === 0x57 && h(9) === 0x45) return "webp";
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith("avi")) return "avif";
    if (brand.startsWith("hei") || brand.startsWith("mif")) return "heic";
  }
  if (h(0) === 0x42 && h(1) === 0x4d) return "bmp";
  if (h(0) === 0 && h(1) === 0 && h(2) === 1 && h(3) === 0) return "ico";
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (m && ["jpg","jpeg","png","gif","webp","avif","svg","bmp","ico","tiff","tif","heic","jxl"].includes(m[1]))
      return m[1] === "jpeg" ? "jpg" : m[1];
  } catch {}
  return null;
}

async function tooSmall(blob, ext) {
  if (ext === "svg") return false;
  try {
    const bmp = await createImageBitmap(blob);
    const small = bmp.width < MIN_SIDE || bmp.height < MIN_SIDE;
    bmp.close();
    return small;
  } catch { return false; }
}

async function fetchImage(item) {
  if (item.stored) {
    const rec = await DB.get(item.stored);
    if (!rec) throw new Error("saved copy missing");
    const bytes = new Uint8Array(rec.data);
    const ext = sniff(bytes) || TYPE_EXT[rec.type] || "png";
    if (SKIP_SMALL && await tooSmall(new Blob([bytes]), ext)) return { skipped: true };
    return { bytes, ext };
  }
  const res = await fetch(item.url, { credentials: "include", cache: "force-cache", referrer: item.page || "about:client" })
    .catch(() => fetch(item.url, { cache: "force-cache" }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("empty response");
  const ext = sniff(bytes) || TYPE_EXT[type] || extFromUrl(item.url);
  if (!ext) throw new Error(`not an image (${type || "unknown type"})`);
  if (SKIP_SMALL && await tooSmall(new Blob([bytes]), ext)) return { skipped: true };
  return { bytes, ext };
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function run() {
  const { images } = await chrome.runtime.sendMessage({ type: "getImages" });
  const total = images.length;
  if (!total) { $("status").textContent = "No images collected yet."; return; }

  const results = new Array(total);
  let next = 0, finished = 0;
  const failed = [];
  let skipped = 0;

  async function worker() {
    while (next < total) {
      const i = next++;
      try {
        const r = await fetchImage(images[i]);
        if (r.skipped) skipped++; else results[i] = r;
      } catch (e) {
        failed.push(`${images[i].url}  ->  ${e.message}`);
      }
      finished++;
      $("status").textContent = `Downloading images… ${finished} / ${total}`;
      $("bar").style.width = `${(finished / total) * 100}%`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  $("status").textContent = "Creating ZIP…";
  const zip = new ZipWriter();
  const index = [];
  const used = new Set();
  let n = 0, num = 0;
  for (let i = 0; i < total; i++) {
    const r = results[i];
    if (!r) continue;
    n++;
    // Named images (aria-labelledby, e.g. caption492.jpg) keep their name; others get 1, 2, 3...
    let base = images[i].name;
    if (!base) { do { base = String(++num); } while (used.has(`${base}.${r.ext}`)); }
    let name = `${base}.${r.ext}`;
    for (let k = 2; used.has(name); k++) name = `${base}_${k}.${r.ext}`;
    used.add(name);
    zip.add(name, r.bytes);
    index.push(`${name}\t${images[i].stored ? (images[i].source || "(image made inside the page, blob:)") : images[i].url.startsWith("data:") ? "(embedded data image)" : images[i].url}\t${images[i].page}`);
  }
  if (!n) {
    $("status").textContent = "None of the images could be downloaded.";
    $("detail").textContent = failed.slice(0, 20).join("\n");
    return;
  }
  zip.add("_sources.txt", new TextEncoder().encode("file\timage url\tfound on page\n" + index.join("\n") + "\n"));
  if (failed.length) zip.add("_failed.txt", new TextEncoder().encode(failed.join("\n") + "\n"));

  const blob = zip.finish();
  const url = URL.createObjectURL(blob);
  const filename = `images_${stamp()}.zip`;
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.textContent = `Save ${filename} again`;
  document.body.appendChild(a); a.click(); a.remove();

  const mb = (blob.size / 1048576).toFixed(1);
  $("status").textContent = `Done! ${n} images saved to ${filename} (${mb} MB).`;
  $("detail").textContent = [
    skipped ? `${skipped} tiny images skipped.` : "",
    failed.length ? `${failed.length} could not be downloaded (listed in _failed.txt).` : ""
  ].filter(Boolean).join(" ");
  const done = $("done");
  const again = document.createElement("a");
  again.href = url; again.download = filename; again.textContent = "Download again";
  done.appendChild(again);
  done.style.display = "block";
}

run().catch((e) => { $("status").textContent = "Something went wrong: " + e.message; });
