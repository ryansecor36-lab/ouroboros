/* Runs the Python audit engine (Pyodide) off the main thread so the screen stays responsive.
   Every file stays inside this browser: CSVs are written to Pyodide's in-memory disk. */
importScripts("pyodide/pyodide.js");

const SITE = "/lib/python3.12/site-packages";
let py = null;
let web = null;

self.reportProgress = (text) => postMessage({ type: "progress", text: String(text) });

async function fetchBuffer(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
  return res.arrayBuffer();
}

async function init() {
  postMessage({ type: "engine", state: "loading", text: "Loading the audit engine" });
  py = await loadPyodide({ indexURL: new URL("pyodide/", self.location).href });
  postMessage({ type: "engine", state: "loading", text: "Loading data tools" });
  await py.loadPackage(["pandas"], { messageCallback: () => {} });
  const wheels = await (await fetch("py/wheels.json")).json();
  for (const w of wheels) {
    py.unpackArchive(await fetchBuffer("py/" + w), "wheel", { extractDir: SITE });
  }
  py.unpackArchive(await fetchBuffer("py/crm_audit.zip"), "zip", { extractDir: "/home/pyodide/app" });
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide/app'); import crm_audit.web");
  web = py.pyimport("crm_audit.web");
  postMessage({ type: "engine", state: "ready", text: "Ready", checklist: JSON.parse(web.checklist_json()) });
}

const ready = init().catch((err) => {
  postMessage({ type: "engine", state: "error", text: "Couldn't load the audit engine", detail: String(err && err.stack || err) });
  throw err;
});

function friendly(err) {
  const msg = String((err && err.message) || err);
  const last = msg.trim().split("\n").filter(Boolean).pop() || msg;
  return { message: last.replace(/^\w+Error: /, ""), detail: msg };
}

function finish(id, resultJson) {
  const result = JSON.parse(resultJson);
  const xlsx = py.FS.readFile(result.xlsx_path); // Uint8Array
  const kit = py.FS.readFile(result.kit_path);
  postMessage({ type: "result", id, result, xlsx: xlsx.buffer, kit: kit.buffer }, [xlsx.buffer, kit.buffer]);
}

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data;
  try {
    await ready;
    if (method === "identify") {
      postMessage({ type: "reply", id, value: JSON.parse(web.identify(JSON.stringify(args.names))) });
    } else if (method === "quote") {
      postMessage({ type: "reply", id, value: JSON.parse(web.quote_json(JSON.stringify(args.settings))) });
    } else if (method === "runSample") {
      finish(id, web.run_sample(JSON.stringify(args.settings)));
    } else if (method === "runUploaded") {
      const dir = web.reset_data_dir();
      for (const f of args.files) {
        const safe = f.name.replace(/[\\/]/g, "_");
        py.FS.writeFile(`${dir}/${safe}`, new Uint8Array(f.buffer));
      }
      self.reportProgress(`Loaded ${args.files.length} file${args.files.length === 1 ? "" : "s"}`);
      finish(id, web.run_uploaded(JSON.stringify(args.settings)));
    }
  } catch (err) {
    postMessage({ type: "error", id, ...friendly(err) });
  }
};
