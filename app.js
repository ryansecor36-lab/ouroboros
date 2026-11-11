/* Uroboric: the app screen. Talks to worker.js, which runs the Python audit. */

/* ---------------------------------------------------------------- back up / restore (pure logic)
   No page or storage access of its own: every function takes the storage (or data) it works on, so
   tests/js/backup.test.mjs can run it under Node. A backup holds the app's saved settings only:
   branding, audit history (scores and counts, never client records) and the unfinished-audit draft. */
const UroboricBackup = (() => {
  const FORMAT = "uroboric-backup", VERSION = 1, MAX_LOGO_BYTES = 1024 * 1024, MAX_PER_CLIENT = 24;
  // "crm-audit-loaded-once" is deliberately not backed up: it only says this origin has downloaded the
  // audit engine, which is not true on a new address.
  const KEYS = { branding: "ouroboros-branding-v1", history: "ouroboros-history-v1", draft: "crm-audit-draft-v1" };
  const ALL_KEYS = Object.values(KEYS);
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const histKey = (client) => String(client || "").trim().toLowerCase();
  const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

  const MSG = {
    damaged: "That file looks damaged, so nothing was restored. Back up again from the old address and pick the new file.",
    notBackup: "That isn't a Uroboric backup. Pick the file named uroboric-backup-(date).json that you saved with Back up.",
    newer: "That backup was made by a newer version of Uroboric than this one. Reload this page to get the latest version, then try again.",
    empty: "That backup has nothing in it to restore.",
  };

  function cleanBranding(b) {
    const warnings = [];
    if (!isObj(b)) return { value: undefined, warnings };
    const out = {};
    if (typeof b.prepared_by === "string" && b.prepared_by.trim()) out.prepared_by = b.prepared_by.slice(0, 200);
    if (typeof b.contact === "string" && b.contact.trim()) out.contact = b.contact.slice(0, 300);
    if (typeof b.accent_color === "string" && /^#[0-9a-fA-F]{6}$/.test(b.accent_color)) out.accent_color = b.accent_color;
    if (typeof b.logo_data === "string" && /^data:image\/(png|jpeg|svg\+xml)[;,]/.test(b.logo_data)) {
      if (b.logo_data.length * 0.75 > MAX_LOGO_BYTES) warnings.push("The logo in this backup is over 1 MB, so it was left out.");
      else out.logo_data = b.logo_data;
    }
    if (b.show_powered_by === false) out.show_powered_by = false;
    return { value: Object.keys(out).length ? out : undefined, warnings };
  }

  // Groups snapshots by client, drops anything that doesn't look like a snapshot, sorts by date.
  function cleanHistory(h) {
    if (!isObj(h)) return { value: undefined, dropped: 0 };
    const out = {};
    let dropped = 0;
    for (const list of Object.values(h)) {
      if (!Array.isArray(list)) { dropped++; continue; }
      for (const snap of list) {
        if (!isObj(snap) || !isDate(snap.audit_date) || typeof snap.client !== "string" || !histKey(snap.client)) { dropped++; continue; }
        const k = histKey(snap.client);
        (out[k] = out[k] || []).push(snap);
      }
    }
    for (const k of Object.keys(out)) {
      const byDate = new Map();
      for (const s of out[k]) byDate.set(s.audit_date, s);
      out[k] = [...byDate.values()].sort((a, b) => (a.audit_date < b.audit_date ? -1 : 1)).slice(-MAX_PER_CLIENT);
    }
    return { value: Object.keys(out).length ? out : undefined, dropped };
  }

  function cleanDraft(d) { return isObj(d) && Object.keys(d).length ? d : undefined; }

  function cleanData(raw) {
    const data = {}, warnings = [];
    const b = cleanBranding(raw[KEYS.branding]);
    if (b.value) data[KEYS.branding] = b.value;
    warnings.push(...b.warnings);
    const h = cleanHistory(raw[KEYS.history]);
    if (h.value) data[KEYS.history] = h.value;
    if (h.dropped) warnings.push(`${h.dropped} saved audit${h.dropped === 1 ? "" : "s"} in the file couldn't be read and ${h.dropped === 1 ? "was" : "were"} skipped.`);
    const d = cleanDraft(raw[KEYS.draft]);
    if (d) data[KEYS.draft] = d;
    return { data, warnings };
  }

  function readAll(storage) {
    const raw = {};
    for (const k of ALL_KEYS) {
      let v;
      try { v = storage.getItem(k); } catch (_) { v = null; }
      if (v === null || v === undefined) continue;
      try { raw[k] = JSON.parse(v); } catch (_) { /* unreadable value: left out */ }
    }
    return cleanData(raw).data;
  }

  function summarize(data) {
    const hist = data[KEYS.history] || {};
    const snaps = Object.values(hist).flat();
    const dates = snaps.map((s) => s.audit_date).sort();
    const clients = Object.values(hist).map((l) => l[l.length - 1].client).sort((a, b) => a.localeCompare(b));
    const br = data[KEYS.branding];
    return {
      branding: !!br, logo: !!(br && br.logo_data), brandingName: (br && br.prepared_by) || "",
      audits: snaps.length, clients, firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null,
      draft: !!data[KEYS.draft],
    };
  }

  function describe(data) {
    const s = summarize(data);
    const lead = s.branding ? "your branding (name, contact, logo)" : "no branding (none saved yet)";
    const n = s.audits ? `${s.audits} past audit${s.audits === 1 ? "" : "s"} for ${s.clients.length === 1 ? "this client" : "these clients"}: ${s.clients.join(", ")}`
      : "0 past audits";
    return `${lead} and ${n} (scores and counts only — no records from any client's CRM).` + (s.draft ? " Also the client name and answers you were typing in." : "");
  }

  function makeBackup(storage, meta) {
    meta = meta || {};
    return {
      format: FORMAT, version: VERSION, app_version: meta.appVersion || "",
      exported_at: meta.now || new Date().toISOString(), origin: meta.origin || "",
      data: readAll(storage),
    };
  }

  function backupFileName(now) { return `uroboric-backup-${(now || new Date().toISOString()).slice(0, 10)}.json`; }

  function parseBackup(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: MSG.damaged };
    let doc;
    try { doc = JSON.parse(text.replace(/^﻿/, "")); } catch (_) { return { ok: false, error: MSG.damaged }; }
    if (!isObj(doc) || doc.format !== FORMAT) return { ok: false, error: MSG.notBackup };
    if (typeof doc.version !== "number" || !(doc.version >= 1)) return { ok: false, error: MSG.damaged };
    if (doc.version > VERSION) return { ok: false, error: MSG.newer };
    if (!isObj(doc.data)) return { ok: false, error: MSG.damaged };
    const { data, warnings } = cleanData(doc.data);
    if (!Object.keys(data).length) return { ok: false, error: MSG.empty };
    const backup = { format: FORMAT, version: doc.version, app_version: String(doc.app_version || ""),
      exported_at: typeof doc.exported_at === "string" ? doc.exported_at : "", origin: String(doc.origin || ""), data };
    return { ok: true, backup, summary: summarize(data), warnings };
  }

  function brandingConflict(current, backup) {
    const a = current[KEYS.branding], b = (backup.data || backup)[KEYS.branding];
    return !!a && !!b && JSON.stringify(a) !== JSON.stringify(b);
  }

  // current: data read from this device (readAll). backup: parseBackup(...).backup.
  // mode: "merge" | "replace". brandingChoice: "device" | "backup" (only matters when both have branding).
  // Returns {data, stats}. In "replace", keys missing from data are removed by applyToStorage.
  function mergeBackup(current, backup, mode, brandingChoice) {
    const theirs = backup.data || {};
    const stats = { added: 0, duplicates: 0, brandingFrom: "none", brandingAsked: false };
    if (mode === "replace") {
      stats.added = summarize(theirs).audits;
      stats.brandingFrom = theirs[KEYS.branding] ? "backup" : "none";
      return { data: { ...theirs }, stats };
    }
    const data = { ...current };
    const mine = current[KEYS.branding], other = theirs[KEYS.branding];
    if (mine && other) {
      stats.brandingAsked = true;
      if (brandingChoice === "backup") { data[KEYS.branding] = other; stats.brandingFrom = "backup"; }
      else stats.brandingFrom = "device";
    } else if (other) { data[KEYS.branding] = other; stats.brandingFrom = "backup"; }
    else if (mine) stats.brandingFrom = "device";
    // History: union by client + audit date. A snapshot has no save time, so on a tie the audit already
    // on this device wins (it was saved after the backup was made).
    const hist = {};
    for (const [k, list] of Object.entries(current[KEYS.history] || {})) hist[k] = list.slice();
    for (const [k, list] of Object.entries(theirs[KEYS.history] || {})) {
      const have = hist[k] || (hist[k] = []);
      for (const snap of list) {
        if (have.some((s) => s.audit_date === snap.audit_date)) stats.duplicates++;
        else { have.push(snap); stats.added++; }
      }
      have.sort((a, b) => (a.audit_date < b.audit_date ? -1 : 1));
      hist[k] = have.slice(-MAX_PER_CLIENT);
    }
    if (Object.keys(hist).length) data[KEYS.history] = hist;
    if (!data[KEYS.draft] && theirs[KEYS.draft]) data[KEYS.draft] = theirs[KEYS.draft];
    return { data, stats };
  }

  // Writes data to storage. On any failure puts everything back as it was and says why.
  function applyToStorage(storage, data, mode) {
    const before = {};
    for (const k of ALL_KEYS) { try { before[k] = storage.getItem(k); } catch (_) { before[k] = null; } }
    try {
      for (const k of ALL_KEYS) {
        if (data[k] !== undefined) storage.setItem(k, JSON.stringify(data[k]));
        else if (mode === "replace") storage.removeItem(k);
      }
      return { ok: true };
    } catch (e) {
      for (const k of ALL_KEYS) {
        try { if (before[k] === null || before[k] === undefined) storage.removeItem(k); else storage.setItem(k, before[k]); } catch (_) {}
      }
      const full = e && (e.name === "QuotaExceededError" || /quota|full/i.test(String(e.message)));
      return { ok: false, error: full
        ? "This device has no room left to save that (a large logo can cause this). Nothing was changed."
        : "This browser won't let Uroboric save settings right now (private browsing can cause this). Nothing was changed." };
    }
  }

  return { FORMAT, VERSION, KEYS, MSG, makeBackup, backupFileName, parseBackup, summarize, describe, readAll,
    brandingConflict, mergeBackup, applyToStorage };
})();
if (typeof module !== "undefined" && module.exports) module.exports = UroboricBackup;

/* Set to "https://app.uroboric.com/" when the app moves. On any other address the app then shows a
   banner that walks the user through backing up here and restoring there. null = off. */
const NEW_HOME = null;

(() => {
  "use strict";
  if (typeof document === "undefined") return; // loaded by the Node test: only the logic above is needed
  const $ = (id) => document.getElementById(id);
  const AREAS = {
    1: "Duplicate records", 2: "Wrong or outdated contact info", 3: "Missing or messy fields",
    4: "Leads and deals slipping through the cracks", 5: "How new data gets in", 6: "Habits that keep it clean",
  };
  const DRAFT_KEY = "crm-audit-draft-v1";

  // ---------------------------------------------------------------- worker plumbing
  const worker = new Worker("worker.js");
  const pending = new Map();
  let nextId = 1;
  let engineReady = false;
  let checklist = [];
  let onProgress = null;

  function call(method, args, transfer) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args }, transfer || []);
    });
  }

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "engine") return setEngine(m);
    if (m.type === "progress") return onProgress && onProgress(m.text);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === "error") p.reject(m);
    else p.resolve(m);
  };
  worker.onerror = (e) => setEngine({ state: "error", text: "The audit engine stopped", detail: e.message });

  function setEngine(m) {
    const el = $("engine");
    el.className = "engine is-" + m.state;
    el.querySelector("span").textContent = m.state === "ready" ? "Ready" : m.text;
    if (m.state === "loading" && onProgress) onProgress(m.text);
    if (m.state === "ready") {
      engineReady = true;
      checklist = m.checklist || [];
      renderQuestions();
      refreshFiles();
      try { localStorage.setItem("crm-audit-loaded-once", "1"); } catch (_) {}
    }
    if (m.state === "error") {
      engineError = m;
      if (currentRun) currentRun.reject({ message: m.text + ". Check the internet connection and reload the page.", detail: m.detail });
    }
  }
  let engineError = null;
  let currentRun = null;

  // ---------------------------------------------------------------- views
  function show(view) {
    for (const v of ["start", "working", "error", "result"]) $("view-" + v).hidden = v !== view;
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- draft (per-device convenience)
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch (_) { return {}; }
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collectSettings())); } catch (_) {}
  }
  const draft = loadDraft();
  $("client").value = draft.client || "";
  $("reps").value = (draft.impact && draft.impact.reps) || "";
  $("touches").value = (draft.impact && draft.impact.touches_per_rep_per_day) || "";
  for (const id of ["client", "reps", "touches"]) $(id).addEventListener("input", saveDraft);

  // ---------------------------------------------------------------- your branding (this device only)
  // Prepared-by name, contact line, accent color, logo (a data: URI) and the "Powered by" switch.
  // Kept in localStorage, sent to the audit engine only to build the report, never uploaded.
  const BRAND_KEY = "ouroboros-branding-v1";
  const MAX_LOGO_BYTES = 1024 * 1024;
  const DEFAULT_ACCENT = "#1f3a5f";
  let brand = loadBrand();
  let pendingLogo = null; // logo shown in the open panel (a data URI), not kept until "Save"

  function loadBrand() {
    try {
      const b = JSON.parse(localStorage.getItem(BRAND_KEY) || "{}");
      return b && typeof b === "object" ? b : {};
    } catch (_) { return {}; }
  }
  function saveBrand() {
    try {
      if (Object.keys(brand).length) localStorage.setItem(BRAND_KEY, JSON.stringify(brand));
      else localStorage.removeItem(BRAND_KEY);
      return true;
    } catch (_) { return false; } // storage unavailable or full: branding still applies until the page closes
  }
  function brandForEngine() {
    return {
      prepared_by: brand.prepared_by || "", contact: brand.contact || "",
      accent_color: brand.accent_color || "", logo_data: brand.logo_data || "",
      show_powered_by: brand.show_powered_by !== false,
    };
  }
  function refreshBrandDot() {
    $("brand-dot").hidden = !(brand.prepared_by || brand.contact || brand.accent_color || brand.logo_data);
  }
  refreshBrandDot();

  function showLogoPreview(uri) {
    const img = $("b-logo-preview");
    img.hidden = !uri;
    if (uri) img.src = uri; else img.removeAttribute("src");
    $("b-logo-clear").hidden = !uri;
  }
  function fillBrandForm() {
    $("b-prepared").value = brand.prepared_by || "";
    $("b-contact").value = brand.contact || "";
    $("b-color").value = brand.accent_color || DEFAULT_ACCENT;
    $("b-color").dataset.unset = brand.accent_color ? "" : "1";
    $("b-powered").checked = brand.show_powered_by !== false;
    pendingLogo = brand.logo_data || null;
    showLogoPreview(pendingLogo);
    $("b-logo-msg").textContent = "";
  }
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  // Shrink big pictures so the saved copy stays small; PNG stays PNG (keeps transparency).
  function downscale(uri, type) {
    return new Promise((resolve) => {
      if (type === "image/svg+xml") return resolve(uri);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 480 / Math.max(img.width, img.height));
        if (k === 1 && uri.length < 300000) return resolve(uri);
        try {
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL(type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9));
        } catch (_) { resolve(uri); }
      };
      img.onerror = () => resolve(null);
      img.src = uri;
    });
  }

  const brandDialog = $("brand-dialog");
  $("brand-open").addEventListener("click", () => {
    fillBrandForm();
    if (brandDialog.showModal) brandDialog.showModal(); else brandDialog.setAttribute("open", "");
  });
  const closeBrand = () => (brandDialog.close ? brandDialog.close() : brandDialog.removeAttribute("open"));
  $("brand-cancel").addEventListener("click", closeBrand);
  $("b-color").addEventListener("input", () => { $("b-color").dataset.unset = ""; });
  $("b-color-reset").addEventListener("click", () => { $("b-color").value = DEFAULT_ACCENT; $("b-color").dataset.unset = "1"; });
  $("b-logo-clear").addEventListener("click", () => { pendingLogo = null; showLogoPreview(null); $("b-logo-msg").textContent = ""; });
  $("b-logo").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    const msg = $("b-logo-msg");
    if (!f) return;
    if (!/^image\/(png|jpeg|svg\+xml)$/.test(f.type) && !/\.(png|jpe?g|svg)$/i.test(f.name)) {
      msg.textContent = "That isn't a PNG, JPG or SVG picture."; return;
    }
    if (f.size > 8 * MAX_LOGO_BYTES) { msg.textContent = "That picture is too big. Pick one under 1 MB."; return; }
    try {
      const type = f.type || (/\.svg$/i.test(f.name) ? "image/svg+xml" : /\.png$/i.test(f.name) ? "image/png" : "image/jpeg");
      let uri = await readAsDataURL(f);
      uri = uri.replace(/^data:[^;,]*/, "data:" + type);
      uri = await downscale(uri, type);
      if (!uri) { msg.textContent = "That picture couldn't be read."; return; }
      if (uri.length * 0.75 > MAX_LOGO_BYTES) { msg.textContent = "That picture is too big. Pick one under 1 MB."; return; }
      pendingLogo = uri; showLogoPreview(uri); msg.textContent = "";
    } catch (_) { msg.textContent = "That picture couldn't be read."; }
  });
  $("brand-clear").addEventListener("click", () => {
    brand = {}; saveBrand(); refreshBrandDot(); fillBrandForm(); closeBrand();
  });
  $("brand-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = {};
    const prepared = $("b-prepared").value.trim(), contact = $("b-contact").value.trim();
    if (prepared) next.prepared_by = prepared;
    if (contact) next.contact = contact;
    if ($("b-color").dataset.unset !== "1") next.accent_color = $("b-color").value;
    if (pendingLogo) next.logo_data = pendingLogo;
    if (!$("b-powered").checked) next.show_powered_by = false;
    brand = next;
    if (!saveBrand()) alert("This browser won't keep your branding after you close it, but it will be used until then.");
    refreshBrandDot();
    closeBrand();
  });

  // ---------------------------------------------------------------- back up / restore (this device)
  const bkDialog = $("backup-dialog");
  const openDialog = (d) => { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); };
  const closeDialog = (d) => (d.close ? d.close() : d.removeAttribute("open"));
  const appVersion = () => {
    const el = document.querySelector(".app-version");
    return el ? el.textContent.replace(/^\s*Uroboric\s*/i, "").trim() : "";
  };
  let parsed = null; // the backup chosen for restore

  function storageOrNull() { try { return window.localStorage; } catch (_) { return null; } }

  function refreshBackupSummary() {
    const st = storageOrNull();
    $("bk-includes").textContent = st
      ? "Includes: " + UroboricBackup.describe(UroboricBackup.readAll(st))
      : "This browser isn't letting Uroboric read its saved settings, so there is nothing to back up.";
    $("bk-save").disabled = $("bk-share").disabled = !st;
  }
  function currentBackup() {
    const st = storageOrNull();
    if (!st) return null;
    const b = UroboricBackup.makeBackup(st, { appVersion: appVersion(), origin: location.origin });
    return { text: JSON.stringify(b, null, 2), name: UroboricBackup.backupFileName(b.exported_at) };
  }
  function rsStatus(text, bad) { const m = $("rs-msg"); m.textContent = text; m.className = "hint" + (bad ? " bad" : ""); }
  function clearRestorePanel() { parsed = null; $("rs-panel").hidden = true; $("rs-confirm").hidden = true; rsStatus(""); }
  function openBackupDialog() {
    $("rs-file").value = "";
    clearRestorePanel();
    $("bk-msg").textContent = "";
    refreshBackupSummary();
    $("bk-share").hidden = !(navigator.share && navigator.canShare && typeof File === "function");
    openDialog(bkDialog);
  }
  $("backup-open").addEventListener("click", openBackupDialog);
  $("backup-close").addEventListener("click", () => closeDialog(bkDialog));

  $("bk-save").addEventListener("click", () => {
    const b = currentBackup();
    if (!b) return;
    try {
      const url = URL.createObjectURL(new Blob([b.text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = b.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $("bk-msg").textContent = `Saved ${b.name}. On an iPad it goes to Downloads in the Files app; if nothing appeared, tap Share or save instead.`;
    } catch (_) {
      $("bk-msg").textContent = "This browser couldn't save the file. Try Share or save, or another browser.";
    }
  });
  $("bk-share").addEventListener("click", async () => {
    const b = currentBackup();
    if (!b) return;
    try {
      const file = new File([b.text], b.name, { type: "application/json" });
      if (!navigator.canShare({ files: [file] })) throw new Error("no-share");
      await navigator.share({ files: [file], title: "Uroboric backup" });
      $("bk-msg").textContent = "Shared. Choose Save to Files to keep it.";
    } catch (e) {
      $("bk-msg").textContent = e && e.name === "AbortError" ? "" : "Sharing isn't available here. Tap Download backup instead.";
    }
  });

  const rsMode = () => (document.querySelector('input[name="rs-mode"]:checked') || {}).value || "merge";
  const rsBrand = () => (document.querySelector('input[name="rs-brand"]:checked') || {}).value || "device";

  function refreshRestoreOptions() {
    if (!parsed) return;
    const st = storageOrNull();
    $("rs-brand").hidden = !(st && rsMode() === "merge" && UroboricBackup.brandingConflict(UroboricBackup.readAll(st), parsed.backup));
    $("rs-confirm").hidden = true;
    $("rs-go").hidden = false;
  }
  $("rs-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    clearRestorePanel();
    if (!f) return;
    let text;
    try { text = await f.text(); } catch (_) { return rsStatus(UroboricBackup.MSG.damaged, true); }
    const r = UroboricBackup.parseBackup(text);
    if (!r.ok) return rsStatus(r.error, true);
    parsed = r;
    const s = r.summary, ul = $("rs-summary");
    ul.textContent = "";
    const add = (t) => { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); };
    add(s.branding ? `Branding: yes${s.brandingName ? " (" + s.brandingName + ")" : ""}${s.logo ? ", with a logo" : ""}` : "Branding: none");
    add(s.audits ? `${s.audits} past audit${s.audits === 1 ? "" : "s"} for ${s.clients.length} client${s.clients.length === 1 ? "" : "s"}: ${s.clients.join(", ")}` : "Past audits: none");
    if (s.audits) add(`Audit dates: ${s.firstDate === s.lastDate ? s.firstDate : s.firstDate + " to " + s.lastDate}`);
    if (r.backup.exported_at) add(`Backed up ${r.backup.exported_at.slice(0, 10)}${r.backup.origin ? " from " + r.backup.origin : ""}`);
    r.warnings.forEach(add);
    $("rs-panel").hidden = false;
    rsStatus("Backup read. Choose how to restore it.");
    refreshRestoreOptions();
  });
  for (const r of document.querySelectorAll('input[name="rs-mode"], input[name="rs-brand"]')) r.addEventListener("change", refreshRestoreOptions);

  $("rs-go").addEventListener("click", () => {
    if (!parsed) return;
    const withBrand = $("rs-brand").hidden ? "" : (rsBrand() === "backup" ? " and uses the backup's branding" : " and keeps this device's branding");
    $("rs-confirm-text").textContent = rsMode() === "replace"
      ? "This erases the branding and audit history on this device and puts the backup's in their place. Continue?"
      : "This adds the backup's audits to what is here" + withBrand + ". Nothing already here is deleted. Continue?";
    $("rs-confirm").hidden = false;
    $("rs-go").hidden = true;
    $("rs-yes").focus();
  });
  $("rs-no").addEventListener("click", () => { $("rs-confirm").hidden = true; $("rs-go").hidden = false; $("rs-go").focus(); });
  $("rs-yes").addEventListener("click", () => {
    const st = storageOrNull();
    if (!st || !parsed) return rsStatus("This browser isn't letting Uroboric save settings, so nothing was restored.", true);
    const mode = rsMode();
    const { data, stats } = UroboricBackup.mergeBackup(UroboricBackup.readAll(st), parsed.backup, mode, rsBrand());
    const res = UroboricBackup.applyToStorage(st, data, mode);
    $("rs-confirm").hidden = true;
    if (!res.ok) { $("rs-go").hidden = false; return rsStatus(res.error, true); }
    brand = loadBrand(); refreshBrandDot();
    const d = loadDraft();
    $("client").value = d.client || ""; $("reps").value = (d.impact && d.impact.reps) || ""; $("touches").value = (d.impact && d.impact.touches_per_rep_per_day) || "";
    if (engineReady) renderQuestions();
    const parts = [mode === "replace" ? "Restored. This device now matches the backup." : "Restored."];
    if (stats.added) parts.push(`${stats.added} audit${stats.added === 1 ? "" : "s"} added.`);
    if (stats.duplicates) parts.push(`${stats.duplicates} already here and kept.`);
    if (stats.brandingFrom === "backup") parts.push("Branding from the backup is in use.");
    $("rs-panel").hidden = true; parsed = null;
    refreshBackupSummary();
    rsStatus(parts.join(" "));
  });

  // ---------------------------------------------------------------- "we've moved" banner (off unless NEW_HOME is set)
  (function movedBanner() {
    let moved = false, host = "";
    try { const u = new URL(NEW_HOME); moved = u.origin !== location.origin; host = u.host; } catch (_) {}
    if (!NEW_HOME || !moved) return;
    $("moved-host").textContent = host;
    $("moved-link").href = NEW_HOME;
    $("moved-link").textContent = host;
    $("moved-banner").hidden = false;
    $("moved-backup").addEventListener("click", openBackupDialog);
    $("moved-hide").addEventListener("click", () => { $("moved-banner").hidden = true; });
  })();

  // ---------------------------------------------------------------- interview questions
  function renderQuestions() {
    const box = $("questions");
    box.textContent = "";
    const saved = loadDraft();
    let lastCat = null;
    let group = null;
    for (const q of checklist) {
      if (q.category !== lastCat) {
        group = document.createElement("div");
        group.className = "q-group";
        const h = document.createElement("h3");
        h.textContent = AREAS[q.category];
        group.appendChild(h);
        box.appendChild(group);
        lastCat = q.category;
      }
      const wrap = document.createElement("div");
      wrap.className = "q";
      const t = document.createElement("div");
      t.className = "q-title";
      t.textContent = q.title;
      const how = document.createElement("div");
      how.className = "q-how";
      how.textContent = `${q.how}. Healthy: ${q.target}.`.replace("?.", "?");
      wrap.append(t, how);
      if (q.mode === "manual") {
        const seg = document.createElement("div");
        seg.className = "seg";
        seg.setAttribute("role", "radiogroup");
        seg.setAttribute("aria-label", q.title);
        const current = saved.manual_scores && saved.manual_scores[q.id];
        for (const [val, label] of [["", "Not asked"], ["2", "Good"], ["1", "Needs work"], ["0", "Problem"]]) {
          const id = `q-${q.id.replace(".", "-")}-${val || "na"}`;
          const input = document.createElement("input");
          input.type = "radio"; input.name = "q-" + q.id; input.id = id; input.value = val;
          input.checked = current === undefined ? val === "" : String(current) === val;
          input.addEventListener("change", () => { saveDraft(); countAnswers(); });
          const lab = document.createElement("label");
          lab.htmlFor = id; lab.textContent = label;
          seg.append(input, lab);
        }
        wrap.appendChild(seg);
      } else {
        const m = document.createElement("div");
        m.className = "measure";
        const input = document.createElement("input");
        input.type = "number"; input.inputMode = "decimal"; input.step = "any"; input.min = "0";
        input.id = "m-" + q.id.replace(".", "-"); input.dataset.check = q.id;
        input.setAttribute("aria-label", q.title);
        const v = saved.measured && saved.measured[q.id];
        if (v !== undefined && v !== null && v !== "") input.value = v;
        input.addEventListener("input", () => { saveDraft(); countAnswers(); });
        const unit = document.createElement("span");
        unit.textContent = q.unit === "%" ? "%" : q.unit;
        m.append(input, unit);
        wrap.appendChild(m);
      }
      group.appendChild(wrap);
    }
    countAnswers();
  }

  function countAnswers() {
    const s = collectSettings();
    const n = Object.keys(s.manual_scores).length + Object.keys(s.measured).length;
    $("interview-count").textContent = n ? `${n} of ${checklist.length} answered` : "optional";
  }

  function collectSettings() {
    const manual = {};
    const measured = {};
    for (const q of checklist) {
      if (q.mode === "manual") {
        const picked = document.querySelector(`input[name="q-${q.id}"]:checked`);
        if (picked && picked.value !== "") manual[q.id] = Number(picked.value);
      } else {
        const el = $("m-" + q.id.replace(".", "-"));
        if (el && el.value !== "") measured[q.id] = Number(el.value);
      }
    }
    if (!checklist.length) { // engine not ready yet: keep whatever was saved
      Object.assign(manual, draft.manual_scores || {});
      Object.assign(measured, draft.measured || {});
    }
    const num = (id) => ($(id).value === "" ? null : Number($(id).value));
    return {
      client: $("client").value.trim(),
      impact: { reps: num("reps"), touches_per_rep_per_day: num("touches") },
      manual_scores: manual, measured,
    };
  }

  // ---------------------------------------------------------------- files
  const files = new Map(); // name -> File
  let kinds = {};

  function addFiles(list) {
    for (const f of list) if (/\.(csv|xlsx)$/i.test(f.name) || f.type === "text/csv") files.set(f.name, f);
    refreshFiles();
  }
  $("files").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });

  async function refreshFiles() {
    if (engineReady && files.size) {
      try { kinds = (await call("identify", { names: [...files.keys()] })).value; } catch (_) { kinds = {}; }
    }
    const ul = $("file-list");
    ul.textContent = "";
    for (const [name, f] of files) {
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.className = "name"; n.textContent = name;
      const k = document.createElement("span");
      const kind = kinds[name];
      k.className = "kind" + (engineReady && !kind ? " unknown" : "");
      k.textContent = !engineReady ? `${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB` : (kind || "Not recognized");
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "remove"; rm.setAttribute("aria-label", "Remove " + name); rm.textContent = "×";
      rm.addEventListener("click", () => { files.delete(name); refreshFiles(); });
      li.append(n, k, rm);
      ul.appendChild(li);
    }
    const recognized = Object.values(kinds);
    const hasContacts = !engineReady ? files.size > 0 : recognized.includes("Contacts");
    const unknown = engineReady ? [...files.keys()].filter((n) => !kinds[n]) : [];
    $("run-real").disabled = !files.size || (engineReady && !recognized.length);
    $("form-hint").textContent = !files.size ? "Add a contacts export to start."
      : unknown.length ? `Rename unrecognized files after what's in them (for example contacts.csv); they'll be skipped otherwise.`
      : !hasContacts ? "Most checks need a contacts export. You can still run with what's here."
      : `${files.size} file${files.size === 1 ? "" : "s"} ready.`;
  }

  // ---------------------------------------------------------------- running
  function startWorking(title) {
    $("work-title").textContent = title;
    const steps = $("steps");
    steps.textContent = "";
    let loadedOnce = false;
    try { loadedOnce = localStorage.getItem("crm-audit-loaded-once") === "1"; } catch (_) {}
    $("first-run-note").hidden = engineReady || loadedOnce;
    onProgress = (text) => {
      const prev = steps.querySelector("li.now");
      if (prev && prev.textContent === text) return;
      if (prev) prev.classList.remove("now");
      const li = document.createElement("li");
      li.className = "now"; li.textContent = text;
      steps.appendChild(li);
    };
    if (!engineReady) onProgress($("engine").querySelector("span").textContent);
    show("working");
  }

  async function run(method, args, transfer, title) {
    if (engineError) return showError({ message: engineError.text + ". Check the internet connection and reload the page.", detail: engineError.detail });
    startWorking(title);
    try {
      const reply = await new Promise((resolve, reject) => {
        currentRun = { reject };
        call(method, args, transfer).then(resolve, reject);
      });
      currentRun = null;
      showResult(reply.result, reply.xlsx, reply.kit);
    } catch (err) {
      currentRun = null;
      showError(err);
    } finally {
      onProgress = null;
    }
  }

  let saveAfterRun = false;
  $("run-sample").addEventListener("click", () => {
    saveAfterRun = false; // the made-up sample company isn't kept in history
    // The sample keeps its own made-up company name and interview answers
    const crm = (document.querySelector('input[name="sample-crm"]:checked') || {}).value || "salesforce";
    run("runSample", { settings: { client: "", impact: {}, crm, branding: brandForEngine() } }, [], "Auditing the sample company");
  });

  // ---------------------------------------------------------------- audit history (this device only)
  const HIST_KEY = "ouroboros-history-v1";
  const histKey = (client) => (client || "").trim().toLowerCase();
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "{}"); } catch (_) { return {}; }
  }
  function previousFor(client, today) {
    const list = loadHistory()[histKey(client)] || [];
    const earlier = list.filter((s) => s.audit_date < today);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }
  function remember(snap) {
    if (!snap || !histKey(snap.client)) return;
    try {
      const all = loadHistory();
      const list = (all[histKey(snap.client)] || []).filter((s) => s.audit_date !== snap.audit_date);
      list.push(snap);
      list.sort((a, b) => (a.audit_date < b.audit_date ? -1 : 1));
      all[histKey(snap.client)] = list.slice(-24);
      localStorage.setItem(HIST_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  $("audit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!files.size) return;
    const payload = [];
    for (const [name, f] of files) payload.push({ name, buffer: await f.arrayBuffer() });
    const settings = collectSettings();
    const today = new Date().toISOString().slice(0, 10);
    settings.previous = settings.client ? previousFor(settings.client, today) : null;
    settings.branding = brandForEngine();
    saveAfterRun = true;
    run("runUploaded", { files: payload, settings }, payload.map((p) => p.buffer),
      `Auditing ${settings.client || "the CRM"}`);
  });

  function showError(err) {
    $("error-msg").textContent = (err && err.message) || "Something went wrong.";
    $("error-detail").textContent = (err && err.detail) || "";
    show("error");
  }
  $("error-back").addEventListener("click", () => show("start"));

  // ---------------------------------------------------------------- results
  let last = null;

  function mountReport(html) {
    // The report is a full page with its own styles. Show it in a shadow root so its styles
    // and the app's never collide, and so printing (Save as PDF) prints the report itself.
    const doc = new DOMParser().parseFromString(html, "text/html");
    let css = doc.querySelector("style") ? doc.querySelector("style").textContent : "";
    css = css.replace(/:root\s*\{/g, ":host{")
      .replace(/(^|[\s{};])html\s*\{[^}]*\}/g, "$1")
      .replace(/(^|[\s{};])body\s*\{/g, "$1.rb{");
    const host = $("report");
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}
      .rb{color-scheme:light}
      @media print{.page{padding-top:0}}</style><div class="rb">${doc.body.innerHTML}</div>`;
  }

  function showResult(result, xlsxBuffer, kitBuffer) {
    last = {
      result,
      kit: new Blob([kitBuffer], { type: "application/zip" }),
      xlsx: new Blob([xlsxBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      htmlFile: new File([result.html], result.html_name, { type: "text/html" }),
    };
    mountReport(result.html);
    setQuoteOpen(false);
    if (saveAfterRun) remember(result.snapshot);
    // A heads-up for the consultant (a CRM not yet checked against a real export): shown here, never in the report
    const note = $("result-note");
    note.textContent = (result.consultant_notes || []).join(" ");
    note.hidden = !note.textContent;
    $("result-grade").textContent = result.grade
      ? `${result.client}: grade ${result.grade} (${result.score}/100)${result.unscored ? ", preliminary" : ""}`
      : result.client;
    const xlsxFile = new File([last.xlsx], result.xlsx_name, { type: last.xlsx.type });
    last.xlsxFile = xlsxFile;
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [last.htmlFile] })); } catch (_) {}
    $("share").hidden = !canShare;
    document.title = `${result.client} - Uroboric`;
    show("result");
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  $("save-xlsx").addEventListener("click", () => last && download(last.xlsx, last.result.xlsx_name));
  $("save-kit").addEventListener("click", () => last && download(last.kit, last.result.kit_name));
  $("save-pdf").addEventListener("click", () => window.print());

  // ---------------------------------------------------------------- apply review (returned workbook -> ready-to-load zip)
  const applyDialog = $("apply-dialog");
  const openApply = () => { $("apply-msg").textContent = ""; $("apply-file").value = ""; applyDialog.showModal(); };
  $("apply-open").addEventListener("click", openApply);
  $("apply-open-2").addEventListener("click", openApply);
  $("apply-close").addEventListener("click", () => applyDialog.close());
  $("apply-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    const msg = $("apply-msg");
    if (!f) return;
    if (!engineReady) { msg.textContent = "The audit engine is still starting. Try again in a moment."; return; }
    msg.textContent = "Reading the reviewed workbook...";
    try {
      const buffer = await f.arrayBuffer();
      const reply = await call("applyReview", { buffer }, [buffer]);
      if (reply.value.error) { msg.textContent = reply.value.error; return; }
      download(new Blob([reply.zip], { type: "application/zip" }), reply.value.zip_name);
      msg.textContent = reply.value.line;
    } catch (err) {
      msg.textContent = (err && err.message) || "Something went wrong reading that file.";
    }
  });

  // ---------------------------------------------------------------- quote (consultant only, never printed)
  const quoteEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
  let quoteSeq = 0;
  function renderQuote(q) {
    const box = $("quote-lines");
    box.textContent = "";
    for (const l of q.lines) {
      const row = quoteEl("div", `quote-row ${l.key}${l.alt ? " alt" : ""}`, "");
      row.append(quoteEl("b", "", l.label), quoteEl("span", "amt", l.display), quoteEl("span", "why", l.why));
      box.appendChild(row);
    }
    const notes = $("quote-notes");
    notes.textContent = "";
    for (const n of q.notes) notes.appendChild(quoteEl("li", "", n));
    $("quote-fallback").value = q.text;
    $("quote-copied").textContent = "";
    if (last) last.quote = q;
  }
  async function refreshQuote() {
    if (!last) return;
    const mine = ++quoteSeq;
    const reps = $("quote-reps").value.trim();
    const settings = { ...last.result.quote_inputs, pilot: $("quote-pilot").checked, reps: reps === "" ? null : Number(reps) };
    try {
      const reply = await call("quote", { settings });
      if (mine === quoteSeq) renderQuote(reply.value);
    } catch (err) {
      if (mine === quoteSeq) $("quote-lines").textContent = (err && err.message) || "Couldn't work out the quote.";
    }
  }
  function setQuoteOpen(open) {
    $("quote-panel").hidden = !open;
    $("open-quote").setAttribute("aria-expanded", String(open));
    if (open) refreshQuote();
  }
  $("open-quote").addEventListener("click", () => {
    if (!last) return;
    const opening = $("quote-panel").hidden;
    if (opening) {
      const qi = last.result.quote_inputs || {};
      $("quote-reps").value = qi.reps == null ? "" : qi.reps;
      $("quote-pilot").checked = false;
      renderQuote(last.result.quote);
    }
    setQuoteOpen(opening);
  });
  $("quote-close").addEventListener("click", () => setQuoteOpen(false));
  $("quote-pilot").addEventListener("change", refreshQuote);
  $("quote-reps").addEventListener("input", refreshQuote);
  $("quote-copy").addEventListener("click", async () => {
    if (!last || !last.quote) return;
    const text = last.quote.text, msg = $("quote-copied"), fb = $("quote-fallback");
    try {
      await navigator.clipboard.writeText(text);
      fb.hidden = true; msg.textContent = "Copied.";
      return;
    } catch (_) { /* fall through to the select-and-copy fallback */ }
    try {
      fb.hidden = false; fb.value = text; fb.focus(); fb.select();
      fb.setSelectionRange(0, text.length);
      msg.textContent = document.execCommand && document.execCommand("copy") ? "Copied." : "Select the text below and copy it.";
    } catch (_) { msg.textContent = "Select the text below and copy it."; }
  });
  $("share").addEventListener("click", async () => {
    if (!last) return;
    const both = [last.htmlFile, last.xlsxFile];
    const filesToShare = navigator.canShare && navigator.canShare({ files: both }) ? both : [last.htmlFile];
    try { await navigator.share({ files: filesToShare, title: `${last.result.client} CRM health report` }); }
    catch (_) { /* the person closed the share sheet */ }
  });
  $("back").addEventListener("click", () => { document.title = "Uroboric"; show("start"); });
  window.addEventListener("afterprint", () => {});

  // ---------------------------------------------------------------- offline support
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
