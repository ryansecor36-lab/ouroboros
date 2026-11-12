/* Offline support: after the first visit, every app file (including the ~30 MB audit engine)
   is served from this device, so the app works with no internet in a client's office.

   Updates: each build has its own cache (named by a hash of all its files). Only the install step
   writes into a build's cache; after that the active worker serves every file of its build from that
   cache and NEVER stores anything fetched later, so one page load can never mix two builds. A new
   build installs in the background and WAITS; the app shows "A new version is ready" and tells it to
   take over ({type:"SKIP_WAITING"}) when the person taps Refresh now, so a report on screen is never
   swapped out. New builds are noticed by the browser's service-worker update check and by the app's
   version probe (index.html?__uroboric_probe=<time>), which goes straight to the network and is never cached. */
const VERSION = "23f778a66948";
const FILES = ["./", "app.css", "app.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "manifest.webmanifest", "py/crm_audit.zip", "py/et_xmlfile-2.0.0-py3-none-any.whl", "py/openpyxl-3.1.5-py2.py3-none-any.whl", "py/phonenumbers-9.0.43-py2.py3-none-any.whl", "py/wheels.json", "pyodide/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pandas-2.2.3-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pyodide-lock.json", "pyodide/pyodide.asm.js", "pyodide/pyodide.asm.wasm", "pyodide/pyodide.js", "pyodide/python_dateutil-2.9.0.post0-py2.py3-none-any.whl", "pyodide/python_stdlib.zip", "pyodide/pytz-2024.1-py2.py3-none-any.whl", "pyodide/six-1.16.0-py2.py3-none-any.whl", "tour.js", "worker.js"];
const CACHE = "crm-audit-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // "reload" skips the browser's HTTP cache (GitHub Pages lets it keep files for 10 minutes), so the
    // saved copy is really this build's.
    await cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    // Nobody has the app open: nothing to interrupt, so take over at once.
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open.length === 0) await self.skipWaiting();
  })());
});

// Before the app switches to a new build, a page asks us whether any OTHER window is busy (a report or
// guided demo open). We message each other window and wait up to ASK_MS for its answer; a window that does
// not answer (frozen, or an older build that cannot) is counted as "silent" so the person can decide.
// Limitation: activation is registration-wide, so once the new build takes over, every window, including
// one that was forced past this check, is controlled by it; those windows show "updated in another window".
const ASK_MS = 1500;
async function askOtherWindows(event) {
  const port = event.ports && event.ports[0];
  if (!port) return;
  const me = event.source && event.source.id;
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const others = all.filter((c) => c.id !== me);
  const replies = [];
  await Promise.all(others.map((c) => new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(resolve, ASK_MS);
    ch.port1.onmessage = (e) => { replies.push({ busy: !!(e.data && e.data.busy) }); clearTimeout(timer); resolve(); };
    try { c.postMessage({ type: "ARE_YOU_BUSY?" }, [ch.port2]); } catch (_) { clearTimeout(timer); resolve(); }
  })));
  port.postMessage({ others: others.length, replies, silent: others.length - replies.length });
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (!d) return;
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  else if (d.type === "CAN_UPDATE?") event.waitUntil(askOtherWindows(event));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("crm-audit-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // The app's "is there a newer version?" probe (index.html?__uroboric_probe=<time>, a fetch, never a page
  // navigation): straight to the network, never cached. Any other URL, whatever its query string, is
  // served from this build's saved copy.
  if (url.searchParams.has("__uroboric_probe") && req.mode !== "navigate") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await cache.match("./") : null);
    // Not part of this build (should not happen): ask the network, and keep nothing.
    return hit || fetch(req);
  })());
});
