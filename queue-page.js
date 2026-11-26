// Volume queue page: edit the list and start/stop the queue (the work itself runs in the background).
const $ = (id) => document.getElementById(id);
const send = (type) => chrome.runtime.sendMessage({ type });
const DEF = { queue: [], queueRunning: false, queuePause: 30, queueSpeed: "normal", queueMsg: "" };

function parse(text) {
  const items = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/https?:\/\/\S+/);
    if (!m) continue;
    let name = line.replace(m[0], "").replace(/\t+/g, " ").trim();
    if (!name) { try { name = new URL(m[0]).searchParams.get("id") || ""; } catch {} }
    items.push({ name, url: m[0], status: "waiting", note: "" });
  }
  return items;
}

async function render() {
  const s = await chrome.storage.local.get(DEF);
  $("speed").value = s.queueSpeed;
  if (document.activeElement !== $("pause")) $("pause").value = s.queuePause;
  $("msg").textContent = s.queueRunning ? (s.queueMsg || "Running… keep this browser open.") : (s.queueMsg || "Not running.");
  const c = (st) => s.queue.filter((i) => i.status === st).length;
  $("summary").textContent = `${s.queue.length} in queue · ${c("done")} done · ${c("waiting")} waiting · ${c("failed")} failed · ${c("skipped")} skipped`;
  $("start").disabled = s.queueRunning || !s.queue.length;
  $("stop").disabled = $("skip").disabled = !s.queueRunning;
  $("load").disabled = $("add").disabled = $("empty").disabled = s.queueRunning;
  const tb = $("list");
  tb.textContent = "";
  s.queue.forEach((it, i) => {
    const tr = document.createElement("tr");
    const td = (cls, text) => { const d = document.createElement("td"); d.className = cls; d.textContent = text; tr.appendChild(d); return d; };
    td("n", String(i + 1));
    td("s " + it.status, it.status);
    const name = td("", it.name || it.url);
    if (it.note) { const n = document.createElement("div"); n.className = "note"; n.textContent = it.note; name.appendChild(n); }
    tb.appendChild(tr);
  });
}

$("load").onclick = async () => {
  const items = parse($("input").value);
  if (!items.length) { $("msg").textContent = "No links found in the box."; return; }
  await chrome.storage.local.set({ queue: items, queueMsg: `${items.length} pages loaded.` });
  $("input").value = "";
};
$("add").onclick = async () => {
  const items = parse($("input").value);
  const s = await chrome.storage.local.get(DEF);
  const have = new Set(s.queue.map((i) => i.url));
  const fresh = items.filter((i) => !have.has(i.url));
  await chrome.storage.local.set({ queue: s.queue.concat(fresh), queueMsg: `${fresh.length} pages added.` });
  $("input").value = "";
};
$("speed").onchange = (e) => chrome.storage.local.set({ queueSpeed: e.target.value });
$("pause").onchange = (e) => chrome.storage.local.set({ queuePause: Math.max(30, parseInt(e.target.value, 10) || 30) });
$("start").onclick = () => send("queueStart");
$("stop").onclick = () => send("queueStop");
$("skip").onclick = () => send("queueSkip");
$("retry").onclick = async () => {
  const s = await chrome.storage.local.get(DEF);
  s.queue.forEach((i) => { if (i.status === "failed" || i.status === "skipped") { i.status = "waiting"; i.note = ""; } });
  await chrome.storage.local.set({ queue: s.queue });
};
$("empty").onclick = async () => { await chrome.storage.local.set({ queue: [], queueMsg: "" }); };

chrome.storage.onChanged.addListener(render);
render();
