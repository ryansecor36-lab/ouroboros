/* Offline support: after the first visit, every app file (including the ~30 MB audit engine)
   is served from this device, so the app works with no internet in a client's office.

   Updates: each build has its own cache (named by a hash of all its files). A new build installs in
   the background and WAITS; the app shows "A new version is ready" and tells it to take over
   ({type:"SKIP_WAITING"}) when the person taps Refresh now, so a report on screen is never swapped out.
   The app's own pages and scripts are fetched network-first (3 s timeout, then the saved copy) so an
   online open gets the latest; the big engine files (pyodide/, wheels) never change within a build
   and are served from the cache. */
const VERSION = "77c9d1d75166";
const FILES = ["./", "app.css", "app.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "manifest.webmanifest", "py/crm_audit.zip", "py/et_xmlfile-2.0.0-py3-none-any.whl", "py/openpyxl-3.1.5-py2.py3-none-any.whl", "py/phonenumbers-9.0.43-py2.py3-none-any.whl", "py/wheels.json", "pyodide/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pandas-2.2.3-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pyodide-lock.json", "pyodide/pyodide.asm.js", "pyodide/pyodide.asm.wasm", "pyodide/pyodide.js", "pyodide/python_dateutil-2.9.0.post0-py2.py3-none-any.whl", "pyodide/python_stdlib.zip", "pyodide/pytz-2024.1-py2.py3-none-any.whl", "pyodide/six-1.16.0-py2.py3-none-any.whl", "tour.js", "worker.js"];
const CACHE = "crm-audit-" + VERSION;
const NETWORK_TIMEOUT_MS = 3000;

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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("crm-audit-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Files that never change inside one build: the Python engine and its libraries.
const isImmutable = (path) => /\/(pyodide|py)\/[^/]+$/.test(path) && !/\/py\/(crm_audit\.zip|wheels\.json)$/.test(path);

function networkFirst(req, cache) {
  return new Promise((resolve) => {
    let settled = false;
    const fromCache = async () => (await cache.match(req, { ignoreSearch: true })) || (await cache.match("./"));
    const timer = setTimeout(async () => {
      const hit = await fromCache();
      if (hit && !settled) { settled = true; resolve(hit); }
    }, NETWORK_TIMEOUT_MS);
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(async (res) => {
      clearTimeout(timer);
      if (res.ok) {
        cache.put(req, res.clone()).catch(() => {});
        if (!settled) { settled = true; resolve(res); }
      } else if (!settled) {
        settled = true;
        resolve((await fromCache()) || res);
      }
    }).catch(async () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const hit = await fromCache();
      resolve(hit || Response.error());
    });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      if (req.mode === "navigate" || !isImmutable(url.pathname)) return networkFirst(req, cache);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
