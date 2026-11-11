/* Offline support: after the first visit, every app file (including the ~30 MB audit engine)
   is served from this device, so the app works with no internet in a client's office. */
const VERSION = "112e8412bacf";
const FILES = ["./", "app.css", "app.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "manifest.webmanifest", "py/crm_audit.zip", "py/et_xmlfile-2.0.0-py3-none-any.whl", "py/openpyxl-3.1.5-py2.py3-none-any.whl", "py/phonenumbers-9.0.43-py2.py3-none-any.whl", "py/wheels.json", "pyodide/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pandas-2.2.3-cp312-cp312-pyodide_2024_0_wasm32.whl", "pyodide/pyodide-lock.json", "pyodide/pyodide.asm.js", "pyodide/pyodide.asm.wasm", "pyodide/pyodide.js", "pyodide/python_dateutil-2.9.0.post0-py2.py3-none-any.whl", "pyodide/python_stdlib.zip", "pyodide/pytz-2024.1-py2.py3-none-any.whl", "pyodide/six-1.16.0-py2.py3-none-any.whl", "worker.js"];
const CACHE = "crm-audit-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
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
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
