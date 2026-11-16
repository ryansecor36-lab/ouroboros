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

/* When to tell the person a newer Uroboric is available. Pure functions so tests/js/update.test.mjs can
   run them under Node. waiting: a new version is downloaded and waiting. busy: an audit report or the
   Guided demo is open. pageVersion / networkVersion: the version string of the page on screen and of the
   one currently on the web server (null when unknown, e.g. offline). */
const UroboricUpdate = (() => {
  const TEXT = "A new version of Uroboric is ready.";
  const TEXT_BUSY = "A new version of Uroboric is ready. Refresh when you're done — your current report stays open until then.";
  function shouldShowUpdate(s) {
    s = s || {};
    if (s.hasController && s.waiting) return true;
    return !!(s.pageVersion && s.networkVersion && s.pageVersion !== s.networkVersion);
  }
  const TEXT_OTHER_BUSY = "Uroboric is open with a report in another window. Finish there, or close it, then tap Refresh now.";
  const TEXT_OTHER_SILENT = "Uroboric is open in another window that isn't responding. Close that window, then tap Refresh now.";
  const TEXT_UPDATED_ELSEWHERE = "Uroboric was updated in another window. Refresh to continue.";
  const bannerText = (busy) => (busy ? TEXT_BUSY : TEXT);
  // res: what the service worker found out about the OTHER open windows: {others, replies:[{busy}], silent}.
  // "busy" (a window with a report open) blocks the update; "silent" (no answer) asks the person; else go.
  function decideUpdate(res) {
    if (!res) return "proceed";
    if ((res.replies || []).some((r) => r && r.busy)) return "busy";
    if ((res.silent || 0) > 0) return "silent";
    return "proceed";
  }
  const otherWindowText = (decision) => (decision === "busy" ? TEXT_OTHER_BUSY : decision === "silent" ? TEXT_OTHER_SILENT : null);
  function parseVersion(html) {
    const m = /class="[^"]*\bapp-version\b[^"]*"[^>]*>\s*Uroboric\s+([^<\s][^<]*?)\s*</i.exec(String(html || ""));
    return m ? m[1] : null;
  }
  return { TEXT, TEXT_BUSY, TEXT_OTHER_BUSY, TEXT_OTHER_SILENT, TEXT_UPDATED_ELSEWHERE, shouldShowUpdate, bannerText, decideUpdate, otherWindowText, parseVersion };
})();
if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { UroboricUpdate });

/* "Start another client": what is cleared and what is kept. Pure functions so tests/js/session.test.mjs can run
   them under Node. One client's files, answers, result, quote and draft never carry over to the next client.
   Kept: the consultant's own branding and the saved audit history (scores and counts only). */
const UroboricSession = (() => {
  const DRAFT_KEY = "crm-audit-draft-v1";
  const KEPT_KEYS = ["ouroboros-branding-v1", "ouroboros-history-v1", "crm-audit-loaded-once"];
  const CLEARED_FIELDS = ["files", "kinds", "client", "reps", "touches", "draft", "last", "quote", "tourOpen",
    "reportHtml", "applyMessage", "saveAfterRun", "tourAfterRun"];
  const name = (c) => String(c || "").trim();
  const emptyDraft = () => ({ client: "", impact: { reps: null, touches_per_rep_per_day: null }, manual_scores: {}, measured: {} });
  const confirmText = (client) =>
    `This clears ${name(client) ? name(client) + "'s" : "this client's"} files and answers from this screen. Saved history and your branding are kept.`;
  // state in, new state out: every CLEARED_FIELDS entry is reset, every other entry (brand, history...) is passed through
  function blankState(state) {
    const next = Object.assign({}, state);
    Object.assign(next, { files: new Map(), kinds: {}, client: "", reps: "", touches: "", draft: emptyDraft(), last: null,
      quote: null, tourOpen: false, reportHtml: "", applyMessage: "", saveAfterRun: false, tourAfterRun: false });
    return next;
  }
  // storage: anything with getItem/removeItem. Removes the client's draft only.
  function clearStorage(storage) {
    let removed = false;
    try { if (storage.getItem(DRAFT_KEY) !== null) { storage.removeItem(DRAFT_KEY); removed = true; } } catch (_) { /* unavailable */ }
    return { removed, kept: KEPT_KEYS.filter((k) => { try { return storage.getItem(k) !== null; } catch (_) { return false; } }) };
  }
  // The name to show on the start screen when a draft from before was restored and not yet changed
  function bannerClient(restored, current) {
    return name(restored) && name(restored) === name(current) ? name(restored) : "";
  }
  return { DRAFT_KEY, KEPT_KEYS, CLEARED_FIELDS, emptyDraft, confirmText, blankState, clearStorage, bannerClient };
})();
if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { UroboricSession });

/* "Check your files": what each chosen file is, what blocks the run and what only deserves a warning.
   Pure functions so tests/js/files.test.mjs can run them under Node. The audit engine (Python) supplies the
   facts about each file (inspect_files); everything the person reads on the screen is decided here. */
const UroboricFiles = (() => {
  const OPTIONS = [
    { value: "contacts", label: "Contacts" },
    { value: "accounts", label: "Companies (accounts)" },
    { value: "opportunities", label: "Deals (opportunities)" },
    { value: "leads", label: "Leads" },
    { value: "users", label: "Users" },
    { value: "tasks", label: "Activities" },
    { value: "opportunity_history", label: "Deal history" },
    { value: "skip", label: "Don't use this file" },
  ];
  // Kinds the engine can detect from a name but that aren't in the everyday list: shown only when they apply
  const EXTRA = { contact_roles: "Deal contacts", job_orders: "Job orders (Bullhorn)" };
  const CORE = ["contacts", "accounts", "opportunities", "leads"];
  const CRMS = [
    { value: "salesforce", label: "Salesforce" }, { value: "hubspot", label: "HubSpot" },
    { value: "dynamics", label: "Dynamics 365" }, { value: "bullhorn", label: "Bullhorn (pilot)" },
  ];
  const crmName = (k) => (CRMS.find((c) => c.value === k) || {}).label || "";
  const tableLabel = (t) => (OPTIONS.find((o) => o.value === t) || {}).label || EXTRA[t] || "";
  const optionsFor = (table) => (EXTRA[table] ? OPTIONS.slice(0, -1).concat([{ value: table, label: EXTRA[table] }, OPTIONS[OPTIONS.length - 1]]) : OPTIONS);
  const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  const sentence = (list) => (list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]);

  // One row. f: a file's facts from the engine. chosen: what the person picked in the drop-down for it, or undefined.
  function rowStatus(f, chosen) {
    if (chosen === "skip") return { status: "skip", note: "Not used in the audit.", blocks: false };
    if (f.error) {
      if (f.error_kind === "empty") return { status: "warn", note: "Empty file: there is nothing in it.", blocks: !!f.table };
      return { status: "error", note: "Couldn't be read: " + String(f.error).replace(/^'[^']*'\s*/, "").replace(/\s+/g, " ").trim(), blocks: true };
    }
    if (!f.table) return { status: "warn", note: "Not recognized: tell us what this is, or set it to Don't use this file.", blocks: false };
    if (!f.rows) return { status: "warn", note: "Empty file: it has no rows.", blocks: true };
    const label = tableLabel(f.table);
    if (!f.useful) {
      const core = CORE.includes(f.table);
      return { status: "warn", note: `None of the columns look like ${label} columns. Is this the right kind of file?`, blocks: core };
    }
    const note = `${plural(f.rows, "row", "rows")} · ${plural(f.useful, "useful column", "useful columns")} found`;
    if (f.bad_lines) return { status: "warn", note: note + ` · ${plural(f.bad_lines, "damaged line", "damaged lines")} skipped`, blocks: false };
    return { status: "ok", note, blocks: false };
  }

  // Tables with more than one file assigned: {contacts: ["a.csv", "b.csv"]}
  function duplicates(files) {
    const by = {};
    for (const f of files) if (f.table && f.table !== "skip") (by[f.table] = by[f.table] || []).push(f.name);
    const out = {};
    for (const [t, names] of Object.entries(by)) if (names.length > 1) out[t] = names;
    return out;
  }

  // What blocks the run and what is only worth a heads-up. chosen: {name: table|"skip"} picked by the person.
  function checkSet(files, chosen) {
    chosen = chosen || {};
    const blockers = [], warnings = [];
    const rows = files.map((f) => ({ f, s: rowStatus(f, chosen[f.name]) }));
    const used = files.filter((f) => f.table && chosen[f.name] !== "skip");
    const dups = duplicates(used);
    for (const [t, names] of Object.entries(dups)) {
      const many = names.length > 2 ? `${names.length} files are` : "Two files are";
      blockers.push(`${many} marked as ${tableLabel(t)}. Pick one, or set the other${names.length > 2 ? "s" : ""} to Don't use this file.`);
    }
    for (const { f, s } of rows) {
      if (!s.blocks || (f.table && dups[f.table])) continue;
      if (s.status === "error") blockers.push(`${f.name}: ${s.note} Set it to Don't use this file, or choose it again.`);
      else blockers.push(`${f.name}: ${s.note.replace(/\.$/, "")}. Set it to Don't use this file, or choose a different file.`);
    }
    const has = (t) => used.some((f) => f.table === t && !f.error && f.rows);
    if (!used.some((f) => f.table === "contacts")) {
      blockers.push("There is no Contacts file. Pick which file holds the contacts, or choose different files.");
    }
    if (used.some((f) => f.table === "contacts")) {
      if (!has("accounts")) warnings.push("No Companies file: duplicate-company and company-link checks will be skipped.");
      if (!has("opportunities") && !has("job_orders")) warnings.push("No Deals file: the pipeline checks will be skipped.");
      if (!has("users")) warnings.push("No Users file: owner checks will be limited.");
    }
    for (const { f, s } of rows) {
      if (chosen[f.name] === "skip") continue;
      if (s.status === "warn" && !s.blocks && !f.table) warnings.push(`${f.name} isn't being used because it wasn't recognized.`);
      if (f.bad_lines && f.table) warnings.push(`${f.name}: ${plural(f.bad_lines, "line", "lines")} had the wrong number of columns and ${f.bad_lines === 1 ? "was" : "were"} skipped, so the numbers may be slightly low.`);
    }
    const seen = [...new Set(used.map((f) => f.crm).filter(Boolean))];
    if (seen.length > 1) {
      const per = used.filter((f) => f.crm).map((f) => `${f.name} looks like ${crmName(f.crm)}`);
      warnings.push(`These files look like they come from different CRMs (${sentence(per)}). Check they all belong to one client.`);
    }
    return { blockers, warnings, canRun: blockers.length === 0, rows };
  }

  // The name -> kind map sent to the engine: what the person (or the file name) says, "skip" for the rest
  function fileMap(files, chosen) {
    const map = {};
    for (const f of files) map[f.name] = (chosen && chosen[f.name]) || f.table || f.detected || "skip";
    return map;
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso || "");
  }
  // dates: the engine's date facts. choice: "dmy" when the person ticked "day/month/year", else anything.
  function dateReading(dates, choice) {
    if (!dates || !dates.slash_dates) return null;
    if (dates.proof) {
      const dmy = dates.proof === "dmy";
      return { toggle: false, order: dates.proof, examples: [],
        text: dmy ? "Dates are read as day/month/year: some dates in the files (like 31/12/2026) show that is the order."
                  : "Dates are read as month/day/year: some dates in the files (like 12/31/2026) show that is the order." };
    }
    if (dates.mixed) return { toggle: false, order: "mdy", examples: [], text: "The files use dates in more than one order. They will be read as month/day/year." };
    if (!dates.has_ambiguous) return null;
    const order = choice === "dmy" ? "dmy" : "mdy";
    return { toggle: true, order,
      text: "Some dates could be read two ways. Check an example, and tick the box if the order is wrong.",
      examples: dates.examples.slice(0, 3).map((e) => `${e.raw} → ${fmtDate(order === "dmy" ? e.dmy : e.mdy)}`) };
  }

  // Reps and calls per rep: left empty, the report has no dollar figures
  const empty = (v) => v === "" || v === null || v === undefined || !(Number(v) > 0);
  function typicalNote(reps, touches) {
    if (!empty(reps) && !empty(touches)) return "";
    return "Leave these empty and the report skips the dollar figures. Typical teams have about 10 reps making 60 calls and emails a day. Enter this team's own numbers so the dollar figures fit them.";
  }
  function costNote(reps, touches) {
    return empty(reps) || empty(touches) ? "No dollar figures in the report yet: enter this team's reps and calls per rep on the first screen." : "";
  }

  return { OPTIONS, CRMS, CORE, crmName, tableLabel, optionsFor, rowStatus, duplicates, checkSet, fileMap, fmtDate, dateReading, typicalNote, costNote };
})();
if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { UroboricFiles });

/* Client names: history is keyed by the typed company name, so a typo quietly loses the "since last audit"
   comparison. These functions find saved clients that match what was typed, or nearly match. Pure (Node tests). */
const UroboricClients = (() => {
  const SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "lp", "llp", "the"]);
  function normalize(s) {
    const words = String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    const kept = words.filter((w) => !SUFFIXES.has(w));
    return (kept.length ? kept : words).join(" ");
  }
  function distance(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // history: {key: [{client, audit_date}, ...]} as saved on this device -> [{key, name, count, last}]
  function list(history) {
    const out = [];
    for (const [key, snaps] of Object.entries(history || {})) {
      if (!Array.isArray(snaps) || !snaps.length) continue;
      const lastSnap = snaps[snaps.length - 1] || {};
      out.push({ key, name: String(lastSnap.client || key), count: snaps.length, last: lastSnap.audit_date || "" });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(iso, today) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "";
    const year = String(today || "").slice(0, 4);
    return `${MON[Number(m[2]) - 1]} ${Number(m[3])}${m[1] !== year ? ", " + m[1] : ""}`;
  }
  function describe(c, today) {
    return `${c.name} — ${c.count} earlier audit${c.count === 1 ? "" : "s"}, last ${shortDate(c.last, today)}`;
  }
  // Saved clients that start with, or contain, what is being typed
  function suggestions(typed, clients, limit) {
    const t = String(typed || "").trim().toLowerCase(), n = normalize(typed);
    if (!t) return [];
    return clients.filter((c) => c.key.includes(t) || (n && normalize(c.name).includes(n))).slice(0, limit || 6);
  }
  // kind: blank | match (same name as a saved client) | suggest (nearly the same) | none
  function check(typed, clients) {
    const t = String(typed || "").trim();
    if (!t) return { kind: "blank" };
    const exact = clients.find((c) => c.key === t.toLowerCase());
    if (exact) return { kind: "match", client: exact };
    const n = normalize(t);
    if (!n) return { kind: "none" };
    const same = clients.find((c) => normalize(c.name) === n);
    if (same) return { kind: "suggest", client: same };
    let best = null, bestD = Infinity;
    for (const c of clients) {
      const cn = normalize(c.name);
      const d = distance(n, cn);
      const limit = Math.min(n.length, cn.length) >= 9 ? 2 : Math.min(n.length, cn.length) >= 4 ? 1 : 0;
      if (d <= limit && d < bestD) { best = c; bestD = d; }
    }
    return best ? { kind: "suggest", client: best } : { kind: "none" };
  }
  function message(res, today) {
    if (res.kind === "match") return `Matches ${res.client.count} earlier audit${res.client.count === 1 ? "" : "s"} of ${res.client.name} (last ${shortDate(res.client.last, today)}). The report will show progress since then.`;
    if (res.kind === "suggest") return `Did you mean ${res.client.name}? It has ${res.client.count} earlier audit${res.client.count === 1 ? "" : "s"}.`;
    if (res.kind === "none") return "No earlier audit under this name. This will be saved as a new client.";
    return "";
  }
  return { normalize, distance, list, shortDate, describe, suggestions, check, message };
})();
if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { UroboricClients });

/* Drop-down menus (More, Share / PDF, the narrow-screen Menu): what happens to the open/closed state and to
   keyboard focus. Pure, so tests/js/files.test.mjs can run it under Node. */
const UroboricMenu = (() => {
  // events: toggle | escape | outside | choose | tab. focus: where focus goes next ("first" item, back to the "button", or null)
  function reduce(state, event) {
    const open = !!(state && state.open);
    switch (event) {
      case "toggle": return { open: !open, focus: open ? "button" : "first" };
      case "escape": return { open: false, focus: open ? "button" : null };
      case "choose": return { open: false, focus: null };
      case "outside": case "tab": return { open: false, focus: null };
      default: return { open, focus: null };
    }
  }
  // Arrow keys inside the open menu: returns the item to focus
  function moveFocus(index, count, key) {
    if (!count) return -1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return (index + 1) % count;
    if (key === "ArrowUp") return (index - 1 + count) % count;
    return index;
  }
  return { reduce, moveFocus };
})();
if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { UroboricMenu });

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
  let worker = null;
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

  function spawnWorker() {
    const w = new Worker("worker.js");
    worker = w;
    w.onmessage = (ev) => {
      if (w !== worker) return; // a worker that was cancelled
      const m = ev.data;
      if (m.type === "engine") return setEngine(m);
      if (m.type === "progress") return onProgress && onProgress(m.text);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === "error") p.reject(m);
      else p.resolve(m);
    };
    w.onerror = (e) => { if (w === worker) setEngine({ state: "error", text: "The audit engine stopped", detail: e.message }); };
  }
  spawnWorker();

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
      if (typeof check !== "undefined" && !$("view-check").hidden && files.size) inspectNow();
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
  let tour = null; // the Guided demo controller, created below
  function show(view) {
    if (tour && tour.isOpen()) tour.stop(false);
    for (const v of ["start", "check", "working", "error", "result"]) $("view-" + v).hidden = v !== view;
    window.scrollTo(0, 0);
    try { refreshUpdateText(); } catch (_) { /* not set up yet */ }
  }

  // ---------------------------------------------------------------- draft (per-device convenience)
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch (_) { return {}; }
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collectSettings())); } catch (_) {}
  }
  let draft = loadDraft();
  const restoredClient = draft.client || "";   // a draft from before: show whose it is on the start screen
  $("client").value = draft.client || "";
  $("reps").value = (draft.impact && draft.impact.reps) || "";
  $("touches").value = (draft.impact && draft.impact.touches_per_rep_per_day) || "";
  function refreshPrevClient() {
    const who = UroboricSession.bannerClient(restoredClient, $("client").value);
    $("prev-client").hidden = !who;
    $("prev-client-name").textContent = who;
  }
  function refreshTypical() { $("typical-note").textContent = UroboricFiles.typicalNote($("reps").value, $("touches").value); }
  const todayIso = () => new Date().toISOString().slice(0, 10);
  function clientList() { return UroboricClients.list(loadHistory()); }
  function refreshClientList() {
    const dl = $("client-list");
    dl.textContent = "";
    const typed = $("client").value;
    const all = clientList();
    let shown = typed.trim() ? UroboricClients.suggestions(typed, all, 8) : [];
    if (!shown.length) shown = all.slice(0, 8); // a typo matches nothing: still offer the saved clients
    for (const c of shown) {
      const o = document.createElement("option");
      o.value = c.name; o.label = UroboricClients.describe(c, todayIso());
      dl.appendChild(o);
    }
  }
  function refreshClientMatch() {
    const res = UroboricClients.check($("client").value, clientList());
    const el = $("client-match");
    el.textContent = UroboricClients.message(res, todayIso());
    el.classList.toggle("is-suggest", res.kind === "suggest");
    return res;
  }
  for (const id of ["client", "reps", "touches"]) $(id).addEventListener("input", () => {
    saveDraft(); refreshPrevClient(); refreshTypical(); refreshClientList(); refreshClientMatch();
  });
  refreshPrevClient();

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
    const on = !!(brand.prepared_by || brand.contact || brand.accent_color || brand.logo_data);
    $("brand-dot").hidden = !on;
    $("menu-dot").hidden = !on;
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
    $("bk-version").textContent = appVersion();
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
    refreshTypical(); refreshClientList(); refreshClientMatch();
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
      const qid = document.createElement("span");
      qid.className = "q-id"; qid.textContent = "check " + q.id;
      t.appendChild(qid);
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
    $("run-real").disabled = !files.size;
    $("form-hint").textContent = !files.size ? "Add a contacts export to start."
      : unknown.length ? "Some files aren't recognized by name. On the next screen you can say what each one is."
      : !hasContacts ? "Most checks need a contacts export. The next screen shows what's missing."
      : `${files.size} file${files.size === 1 ? "" : "s"} chosen. Next, check them.`;
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
      if (err && err.cancelled) return;
      currentRun = null;
      showError(err);
    } finally {
      onProgress = null;
    }
  }

  let saveAfterRun = false;
  let tourAfterRun = false; // set by the Guided demo button: start the tour when the report is ready
  function runSample(demo) {
    check.fromCheck = false;
    saveAfterRun = false; // the made-up sample company isn't kept in history
    tourAfterRun = demo;
    // The sample keeps its own made-up company name and interview answers. In demo mode the engine also
    // adds a labelled example earlier audit so the progress section can be shown (never saved).
    const crm = (document.querySelector('input[name="sample-crm"]:checked') || {}).value || "salesforce";
    run("runSample", { settings: { client: "", impact: {}, crm, demo, branding: brandForEngine() } }, [],
      demo ? "Getting the guided demo ready" : "Auditing the sample company");
  }
  $("run-sample").addEventListener("click", () => runSample(false));
  $("run-demo").addEventListener("click", () => runSample(true));

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
    try { refreshClientList(); refreshClientMatch(); } catch (_) { /* not set up yet */ }
  }

  $("audit-form").addEventListener("submit", (e) => { e.preventDefault(); if (files.size) openCheck(); });

  // ---------------------------------------------------------------- "Check your files"
  const safeName = (n) => n.replace(/[\\/]/g, "_");
  const check = { facts: null, chosen: {}, crm: null, dmy: false, seq: 0, held: null, fromCheck: false };
  const filesSig = () => [...files.values()].map((f) => `${f.name}|${f.size}|${f.lastModified}`).join("\n");

  function openCheck() {
    check.facts = null; check.chosen = {}; check.crm = null; check.dmy = false; check.held = null;
    renderCheck();
    show("check");
    $("check-h").focus();
    inspectNow();
  }
  async function inspectNow() {
    const mine = ++check.seq;
    $("check-loading").hidden = false;
    $("check-run").disabled = true;
    try {
      const args = { settings: { file_map: check.chosen, date_order: null } };
      let transfer = [];
      if (check.held !== filesSig()) {
        const list = [];
        for (const f of files.values()) list.push({ name: f.name, buffer: await f.arrayBuffer() });
        args.files = list; transfer = list.map((x) => x.buffer);
      }
      const sigNow = filesSig();
      const reply = await call("inspect", args, transfer);
      if (mine !== check.seq) return;
      check.held = sigNow;
      check.facts = reply.value;
      if (!check.crm) check.crm = check.facts.crm;
    } catch (err) {
      if (mine !== check.seq || (err && err.cancelled)) return;
      check.facts = { files: [], crm: "salesforce", crm_evidence: false, dates: {}, failed: (err && err.message) || "The files couldn't be read." };
    }
    $("check-loading").hidden = true;
    renderCheck();
  }
  const MARK = { ok: "\u2713", warn: "\u26A0", error: "\u26A0", skip: "\u2013" };
  function renderCheck() {
    const facts = check.facts;
    const client = $("client").value.trim();
    $("check-client-name").textContent = client || "No company name entered";
    const res = UroboricClients.check(client, clientList());
    $("check-client-match").textContent = res.kind === "blank" ? "Add a company name on the first screen to keep a history for this client." : UroboricClients.message(res, todayIso());
    const use = $("check-use-suggestion");
    use.hidden = res.kind !== "suggest";
    if (res.kind === "suggest") { use.textContent = "Use " + res.client.name; use.dataset.name = res.client.name; }
    const cost = UroboricFiles.costNote($("reps").value, $("touches").value);
    $("check-cost-note").textContent = cost; $("check-cost-note").hidden = !cost;
    const ul = $("check-files");
    ul.textContent = "";
    if (!facts) { $("check-blockers").hidden = $("check-warnings").hidden = $("check-dates").hidden = true; $("check-crm").textContent = ""; return; }
    const set = UroboricFiles.checkSet(facts.files, check.chosen);
    if (facts.failed) set.blockers.unshift(facts.failed), set.canRun = false;
    for (const { f, s } of set.rows) {
      const li = document.createElement("li");
      li.className = "is-" + s.status;
      const mark = document.createElement("span"); mark.className = "mark"; mark.textContent = MARK[s.status]; mark.setAttribute("aria-label", s.status === "ok" ? "Looks good" : s.status === "skip" ? "Not used" : "Needs a look");
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = f.name; nm.title = f.name;
      if (f.crm && f.table) { const c = document.createElement("span"); c.className = "fcrm"; c.textContent = UroboricFiles.crmName(f.crm); nm.appendChild(c); }
      const note = document.createElement("span"); note.className = "fnote"; note.textContent = s.note;
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", "What is " + f.name + "?");
      const current = check.chosen[f.name] || f.table || "";
      if (!current) { const o = document.createElement("option"); o.value = ""; o.textContent = "Choose what this is\u2026"; sel.appendChild(o); }
      for (const o of UroboricFiles.optionsFor(f.detected || f.table)) {
        const opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label;
        sel.appendChild(opt);
      }
      sel.value = current;
      sel.addEventListener("change", () => {
        if (sel.value) check.chosen[f.name] = sel.value; else delete check.chosen[f.name];
        inspectNow();
      });
      const assign = document.createElement("label"); assign.className = "fassign";
      const lead = document.createElement("span"); lead.textContent = "This file is:";
      assign.append(lead, sel);
      li.append(mark, nm, assign, note);
      ul.appendChild(li);
    }
    const crmSel = $("check-crm");
    crmSel.textContent = "";
    for (const c of UroboricFiles.CRMS) { const o = document.createElement("option"); o.value = c.value; o.textContent = c.label; crmSel.appendChild(o); }
    crmSel.value = check.crm || facts.crm;
    $("check-crm-note").textContent = crmSel.value !== facts.crm ? `Detected: ${UroboricFiles.crmName(facts.crm)}. You changed it, so the audit will use ${UroboricFiles.crmName(crmSel.value)}.`
      : facts.crm_evidence ? `Detected automatically from the column names: ${UroboricFiles.crmName(facts.crm)}.`
      : `Couldn't tell from the column names, so ${UroboricFiles.crmName(facts.crm)} is assumed. Change it if that's wrong.`;
    const dr = UroboricFiles.dateReading(facts.dates, check.dmy ? "dmy" : null);
    $("check-dates").hidden = !dr;
    if (dr) {
      $("check-dates-text").textContent = dr.text;
      const ex = $("check-dates-examples");
      ex.textContent = "";
      for (const t of dr.examples) { const li = document.createElement("li"); li.textContent = t; ex.appendChild(li); }
      $("check-dmy-wrap").hidden = !dr.toggle;
      $("check-dmy").checked = check.dmy;
    }
    const fill = (box, list, items) => { list.textContent = ""; for (const t of items) { const li = document.createElement("li"); li.textContent = t; list.appendChild(li); } box.hidden = !items.length; };
    fill($("check-blockers"), $("check-blockers-list"), set.blockers);
    fill($("check-warnings"), $("check-warnings-list"), set.warnings);
    $("check-run").disabled = !set.canRun || !$("check-loading").hidden;
  }
  $("check-crm").addEventListener("change", () => { check.crm = $("check-crm").value; renderCheck(); });
  $("check-dmy").addEventListener("change", () => { check.dmy = $("check-dmy").checked; renderCheck(); });
  $("check-use-suggestion").addEventListener("click", () => {
    $("client").value = $("check-use-suggestion").dataset.name; saveDraft(); refreshPrevClient(); refreshClientMatch(); renderCheck();
  });
  $("check-back").addEventListener("click", () => show("start"));
  $("check-different").addEventListener("click", () => {
    files.clear(); kinds = {}; check.facts = null; check.held = null; check.seq++;
    refreshFiles(); show("start");
    try { $("files").click(); } catch (_) { /* the picker needs a tap on some browsers: the Choose files box is right there */ }
  });
  $("check-run").addEventListener("click", async () => {
    if (!check.facts || $("check-run").disabled) return;
    $("check-run").disabled = true;
    const payload = [];
    for (const [name, f] of files) payload.push({ name, buffer: await f.arrayBuffer() });
    const settings = collectSettings();
    settings.previous = settings.client ? previousFor(settings.client, todayIso()) : null;
    settings.branding = brandForEngine();
    settings.file_map = {};
    for (const f of check.facts.files) settings.file_map[f.name] = f.table || "skip";
    const dr = UroboricFiles.dateReading(check.facts.dates, check.dmy ? "dmy" : null);
    if (dr && dr.toggle && check.dmy) settings.date_order = "dmy";
    if (check.crm && check.crm !== check.facts.crm) settings.crm_override = check.crm;
    saveAfterRun = true;
    check.fromCheck = true;
    run("runUploaded", { files: payload, settings }, payload.map((p) => p.buffer), `Auditing ${settings.client || "the CRM"}`);
  });

  // Cancel while an audit runs: stop the engine, start a fresh one, and go back with the files kept
  $("work-cancel").addEventListener("click", () => {
    const back = check.fromCheck && check.facts ? "check" : "start";
    if (currentRun) currentRun = null;
    worker.terminate();
    for (const p of pending.values()) p.reject({ cancelled: true, message: "Cancelled." });
    pending.clear();
    engineReady = false; engineError = null; check.held = null; onProgress = null; tourAfterRun = false;
    const el = $("engine"); el.className = "engine is-loading"; el.querySelector("span").textContent = "Restarting";
    spawnWorker();
    show(back);
    if (back === "check") { renderCheck(); inspectNow(); }
  });

  function showError(err) {
    tourAfterRun = false;
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
    $("share-btn").setAttribute("aria-describedby", "pdf-hint");
    document.title = `${result.client} - Uroboric`;
    show("result");
    if (tourAfterRun) { tourAfterRun = false; startTour(); }
  }

  // ---------------------------------------------------------------- guided demo (nothing here is saved)
  tour = UroboricTour.createTour({
    document, window,
    getReportRoot: () => $("report").shadowRoot,
    onStart: () => setQuoteOpen(false), // the consultant's Quote panel is never shown during the tour
  });
  function startTour() {
    if (last && last.result.tour) { tour.start(last.result.tour); refreshUpdateText(); }
  }
  $("walk-through").addEventListener("click", startTour);

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  $("save-xlsx").addEventListener("click", () => last && download(last.xlsx, last.result.xlsx_name));
  $("save-kit").addEventListener("click", () => last && download(last.kit, last.result.kit_name));

  // ---------------------------------------------------------------- apply review (returned workbook -> ready-to-load zip)
  // The zip is only downloaded after the person has seen "What will change" and tapped Download.
  const applyDialog = $("apply-dialog");
  let pendingApply = null; // { blob, name, line } waiting for the person's OK
  function resetApplyDialog() {
    pendingApply = null;
    $("apply-msg").textContent = ""; $("apply-file").value = "";
    $("apply-summary").textContent = ""; $("apply-warnings").textContent = "";
    $("apply-review-box").hidden = true;
  }
  const openApply = () => { resetApplyDialog(); applyDialog.showModal(); };
  $("apply-open").addEventListener("click", openApply);
  $("apply-open-home").addEventListener("click", openApply);
  $("apply-close").addEventListener("click", () => { resetApplyDialog(); applyDialog.close(); });
  $("apply-cancel").addEventListener("click", () => {
    resetApplyDialog();
    $("apply-msg").textContent = "Cancelled. Nothing was downloaded.";
  });
  $("apply-go").addEventListener("click", () => {
    if (!pendingApply) return;
    download(pendingApply.blob, pendingApply.name);
    $("apply-msg").textContent = pendingApply.line;
    $("apply-review-box").hidden = true;
    pendingApply = null;
  });
  $("apply-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    const msg = $("apply-msg");
    $("apply-review-box").hidden = true; pendingApply = null;
    if (!f) return;
    if (!engineReady) { msg.textContent = "The audit engine is still starting. Try again in a moment."; return; }
    msg.textContent = "Reading the reviewed workbook...";
    try {
      const buffer = await f.arrayBuffer();
      const manifest = last && last.result && last.result.manifest ? last.result.manifest : null;
      const reply = await call("applyReview", { buffer, manifest }, [buffer]);
      if (reply.value.error) { msg.textContent = reply.value.error; return; }
      const sm = reply.value.summary;
      pendingApply = { blob: new Blob([reply.zip], { type: "application/zip" }), name: reply.value.zip_name, line: reply.value.line };
      $("apply-summary").textContent = sm.approval.join("\n");
      const ul = $("apply-warnings");
      ul.textContent = "";
      for (const w of sm.warnings.slice(0, 6)) { const li = document.createElement("li"); li.textContent = w; ul.appendChild(li); }
      if (sm.warnings.length > 6) { const li = document.createElement("li"); li.textContent = `...and ${sm.warnings.length - 6} more (listed in the zip's CHECKLIST.txt).`; ul.appendChild(li); }
      $("apply-review-box").hidden = false;
      msg.textContent = "Check what will change, then download the load files.";
      $("apply-go").focus();
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
  // "Edit this audit": back to the form with everything kept
  $("back").addEventListener("click", () => { document.title = "Uroboric"; show("start"); });

  // "Start another client": nothing from the previous client stays on this device's screen or in the worker
  const newClientDialog = $("newclient-dialog");
  function askStartAnother() {
    $("newclient-text").textContent = UroboricSession.confirmText($("client").value || (last && last.result.client));
    openDialog(newClientDialog);
    $("newclient-cancel").focus();
  }
  $("new-client").addEventListener("click", askStartAnother);
  $("prev-client-new").addEventListener("click", askStartAnother);
  $("newclient-cancel").addEventListener("click", () => closeDialog(newClientDialog));
  $("newclient-yes").addEventListener("click", async () => {
    const next = UroboricSession.blankState({ files, kinds, client: $("client").value, last, draft });
    if (tour && tour.isOpen()) tour.stop(false);
    files.clear();
    kinds = next.kinds; draft = next.draft; last = null; quoteSeq++;
    saveAfterRun = next.saveAfterRun; tourAfterRun = next.tourAfterRun;
    for (const id of ["client", "reps", "touches"]) $(id).value = "";
    UroboricSession.clearStorage(storageOrNull() || { getItem() { return null; }, removeItem() {} });
    check.facts = null; check.chosen = {}; check.crm = null; check.dmy = false; check.held = null; check.seq++; check.fromCheck = false;
    refreshTypical(); refreshClientList(); refreshClientMatch();
    renderQuestions();                       // reads the (now empty) draft: every answer back to "Not asked"
    refreshFiles();
    const host = $("report");
    if (host.shadowRoot) host.shadowRoot.innerHTML = "";
    setQuoteOpen(false);
    $("quote-lines").textContent = ""; $("quote-notes").textContent = "";
    $("quote-fallback").value = ""; $("quote-fallback").hidden = true; $("quote-copied").textContent = "";
    $("quote-reps").value = ""; $("quote-pilot").checked = false;
    $("result-grade").textContent = ""; $("result-note").textContent = ""; $("result-note").hidden = true;
    $("share").hidden = true;
    resetApplyDialog();
    document.title = "Uroboric";
    refreshPrevClient();
    closeDialog(newClientDialog);
    show("start");
    try { await call("resetWorkspace", {}); }
    catch (_) { alert("The screen is cleared, but the audit engine couldn't delete its working copy of the last client's files. Reload this page to clear it."); }
  });
  window.addEventListener("afterprint", () => {});

  // ---------------------------------------------------------------- drop-down menus (More, Share / PDF, narrow Menu)
  function makeMenu(btn, panel, opts) {
    opts = opts || {};
    const wrap = btn.parentElement;
    let state = { open: false };
    const items = () => [...panel.querySelectorAll('[role="menuitem"]')].filter((b) => !b.hidden);
    function apply(next) {
      state = { open: next.open };
      panel.hidden = !next.open;
      btn.setAttribute("aria-expanded", String(next.open));
      if (next.focus === "first") (items()[0] || btn).focus();
      else if (next.focus === "button") btn.focus();
    }
    btn.addEventListener("click", () => {
      if (opts.direct && !state.open && opts.direct()) return;
      apply(UroboricMenu.reduce(state, "toggle"));
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (state.open) { e.stopPropagation(); apply(UroboricMenu.reduce(state, "escape")); } return; }
      if (e.key === "Tab") { if (state.open) apply(UroboricMenu.reduce(state, "tab")); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      if (!state.open) { apply({ open: true, focus: "first" }); return; }
      const list = items();
      const at = list.indexOf(document.activeElement);
      const to = at < 0 ? (e.key === "ArrowUp" ? list.length - 1 : 0) : UroboricMenu.moveFocus(at, list.length, e.key);
      if (list[to]) list[to].focus();
    });
    panel.addEventListener("click", (e) => { if (e.target.closest('[role="menuitem"]')) apply(UroboricMenu.reduce(state, "choose")); });
    document.addEventListener("pointerdown", (e) => { if (state.open && !wrap.contains(e.target)) apply(UroboricMenu.reduce(state, "outside")); });
    return { close: () => apply(UroboricMenu.reduce(state, "outside")), isOpen: () => state.open };
  }
  const moreMenu = makeMenu($("more-btn"), $("more-menu"));
  const shareMenu = makeMenu($("share-btn"), $("share-menu"), { direct: () => { if ($("share").hidden) { window.print(); return true; } return false; } });
  const barMenu = makeMenu($("bar-menu-btn"), $("bar-menu"));
  $("bar-menu").addEventListener("click", (e) => { const t = e.target.closest("[data-click]"); if (t) $(t.dataset.click).click(); });
  window.addEventListener("beforeprint", () => { moreMenu.close(); shareMenu.close(); barMenu.close(); });
  $("save-pdf").addEventListener("click", () => window.print());
  refreshTypical(); refreshClientList(); refreshClientMatch();

  // ---------------------------------------------------------------- offline support and updates
  // A new version downloads in the background and waits. We tell the person ("A new version of Uroboric
  // is ready"), and only swap when they tap Refresh now, so a report on screen is never pulled away.
  const updBanner = $("update-banner");
  let swReg = null;
  let refreshRequested = false; // only reload after the person asked: guards against reload loops
  let reloaded = false;
  let staleWindow = false; // another window updated the app; this one still runs the old files
  let hasHadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const isBusy = () => !$("view-result").hidden || !$("view-working").hidden || !!(tour && tour.isOpen());
  function refreshUpdateText() {
    $("update-text").textContent = UroboricUpdate.bannerText(isBusy());
  }
  // Other open windows: before switching the app, the waiting worker asks every other window whether it has
  // a report open. This window answers such questions here.
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "ARE_YOU_BUSY?" && e.ports && e.ports[0]) e.ports[0].postMessage({ busy: isBusy() });
  });
  function askOtherWindows(worker) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => finish(e.data);
        worker.postMessage({ type: "CAN_UPDATE?" }, [ch.port2]);
      } catch (_) { finish(null); }
      setTimeout(() => finish(null), 4000); // the worker did not answer at all: nothing to go on, so carry on
    });
  }
  function showUpdatedElsewhere() {
    staleWindow = true;
    $("update-text").textContent = UroboricUpdate.TEXT_UPDATED_ELSEWHERE;
    $("update-now").disabled = false;
    $("update-now").textContent = "Refresh";
    $("update-later").hidden = true;
    $("update-anyway").hidden = true;
    updBanner.hidden = false;
  }
  function showUpdateBanner() {
    if (staleWindow) return; refreshUpdateText(); updBanner.hidden = false; }
  function reloadOnce() { if (reloaded) return; reloaded = true; location.reload(); }
  function evaluateUpdate(networkVersion) {
    const hasController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (UroboricUpdate.shouldShowUpdate({ hasController, waiting: !!(swReg && swReg.waiting),
        busy: isBusy(), pageVersion: appVersion(), networkVersion: networkVersion || null })) showUpdateBanner();
  }
  async function fetchNetworkVersion() {
    try {
      const r = await fetch("./index.html?__uroboric_probe=" + Date.now(), { cache: "no-store" });
      return r.ok ? UroboricUpdate.parseVersion(await r.text()) : null;
    } catch (_) { return null; }
  }
  async function checkForUpdate() {
    if (!swReg || navigator.onLine === false) return;
    try { await swReg.update(); } catch (_) { /* offline or the server is down: try again later */ }
    evaluateUpdate(await fetchNetworkVersion());
  }
  function watchInstalling(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") evaluateUpdate(null);
    });
  }
  async function refreshNow(force) {
    if (staleWindow) { reloadOnce(); return; }
    $("update-now").disabled = true;
    $("update-anyway").hidden = true;
    $("update-text").textContent = "Updating…";
    try {
      if (!swReg.waiting) { // the page noticed a newer version before its files finished downloading
        const w = swReg.installing || (await swReg.update().then(() => swReg.installing).catch(() => null));
        if (w && w.state !== "installed" && w.state !== "activated") {
          await new Promise((res) => { w.addEventListener("statechange", () => w.state === "installed" && res()); setTimeout(res, 90000); });
        }
      }
      if (!swReg.waiting) { refreshRequested = true; reloadOnce(); return; }
      if (force !== true) {
        const decision = UroboricUpdate.decideUpdate(await askOtherWindows(swReg.waiting));
        const text = UroboricUpdate.otherWindowText(decision);
        if (text) {
          $("update-text").textContent = text;
          $("update-now").disabled = false;
          $("update-anyway").hidden = decision !== "silent";
          return;
        }
      }
      refreshRequested = true;
      swReg.waiting.postMessage({ type: "SKIP_WAITING" });
      setTimeout(reloadOnce, 4000); // controllerchange reloads; this is the fallback
    } catch (_) { refreshRequested = true; reloadOnce(); }
  }
  $("update-now").addEventListener("click", () => refreshNow(false));
  $("update-anyway").addEventListener("click", () => refreshNow(true));
  $("update-later").addEventListener("click", () => { updBanner.hidden = true; });
  window.UroboricCheckForUpdate = checkForUpdate; // lets a test or the console trigger the same check

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshRequested) reloadOnce();
      else if (!hasHadController) hasHadController = true; // the first install taking control of this page
      else showUpdatedElsewhere(); // never reload by itself: the person may be mid-report
    });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      swReg = reg;
      watchInstalling(reg.installing);
      reg.addEventListener("updatefound", () => watchInstalling(reg.installing));
      evaluateUpdate(null); // a worker may already be waiting (the app was closed mid-update)
      checkForUpdate();
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
      window.addEventListener("online", checkForUpdate);
      setInterval(checkForUpdate, 30 * 60 * 1000);
    }).catch(() => {});
  }
})();
