/* Uroboric: the Guided demo. A step-by-step tour of the report for the consultant to present on an iPad.
   Two parts:
   1. buildTourSteps(summary): pure. Turns the report's own numbers (the "tour" dict the audit engine returns)
      into the cards. No page access, so tests/js/tour.test.mjs runs it under Node.
   2. createTour(...): the small DOM layer: spotlight, card, buttons, keyboard, swipe.
   Nothing here is saved anywhere, and nothing needs the network. */
const UroboricTour = (() => {
  const num = (n) => Math.round(n).toLocaleString("en-US");
  const isNum = (v) => typeof v === "number" && isFinite(v);

  const LADDER = [
    "A free check, which is what you just saw.",
    "The full audit on your data, delivered within 2 business days.",
    "A cleanup you approve change by change.",
    "A monthly retainer that re-audits and shows the trend.",
  ];

  /* summary: { grade, score, grade_line, areas:[{name, rating, pct}], problems:[{title, headline}], cost, cost_text,
                hours, sources_headline, has_progress, progress_headline, progress_is_example, has_cleanup,
                crm_name, client_name, is_sample }
     returns [{ id, target, title, text, list? }]; target is a data-tour name, "app:<element id>" or null. */
  function buildTourSteps(s) {
    s = s || {};
    const sample = !!s.is_sample;
    const steps = [];
    const add = (id, target, title, text, list) => steps.push(list ? { id, target, title, text, list } : { id, target, title, text });

    // 1. Grade
    if (s.grade && isNum(s.score)) {
      add("grade", "grade", "The grade",
        `${sample ? "This sample CRM" : "This CRM"} scores a ${s.grade}, ${num(s.score)} out of 100.` +
        (s.grade_line ? ` ${s.grade_line}` : ""));
    }

    // 2. The six areas
    const rated = (s.areas || []).filter((a) => a && isNum(a.pct));
    if (rated.length) {
      const n = (r) => rated.filter((a) => a.rating === r).length;
      const weakest = rated.reduce((w, a) => (a.pct < w.pct ? a : w), rated[0]);
      const parts = [];
      if (n("Good")) parts.push(`${n("Good")} good`);
      if (n("Needs work")) parts.push(`${n("Needs work")} needing work`);
      if (n("Problem")) parts.push(`${n("Problem")} ${n("Problem") === 1 ? "problem" : "problems"}`);
      add("areas", "areas", "The six areas",
        `Each bar is one area of data quality: Good means it meets the healthy target, Needs work means close, ` +
        `Problem means far from it. Here, ${parts.join(", ")}. The weakest is ${weakest.name}.`);
    }

    // 3. Biggest problems
    const top = (s.problems || [])[0];
    if (top && top.headline) {
      add("problems", "problems", "The biggest problems",
        `Ranked worst first. Number one: “${top.headline}”` +
        ((s.problems || []).length > 1 ? ` The next ${(s.problems || []).length - 1} are right below it.` : ""));
    }

    // 4. What it costs
    if (isNum(s.cost) && s.cost > 0 && s.cost_text) {
      add("cost", "cost", "What it costs",
        `${s.cost_text} a year of rep time${isNum(s.hours) ? ` (about ${num(s.hours)} hours)` : ""} goes on calls ` +
        "and emails that hit dead ends. It is a deliberately conservative estimate, and the assumptions are listed in the report.");
    }

    // 5. Where bad data comes from
    if (s.sources_headline) {
      const h = String(s.sources_headline).trim();
      add("sources", "sources", "Where bad data comes from",
        `${h}${/[.!?]$/.test(h) ? "" : "."} Fixing the source is what keeps it clean.`);
    }

    // 6. The fix
    add("cleanup", s.has_cleanup ? "cleanup" : "app:save-kit", "The fix",
      "The cleanup review: your team approves every change in one workbook. Nothing in the CRM changes without a yes. " +
      "Then the approved changes are loaded, with undo files in case anything needs to be put back.");

    // 7. Progress over time
    if (s.has_progress) {
      add("progress", "progress", "Progress over time",
        (s.progress_is_example
          ? "This is what a monthly re-audit shows: the score, what got better and what slipped. The earlier audit here is an example made up for the demo."
          : "This compares today with the last audit: the score, what got better and what slipped.") +
        (s.progress_headline ? ` ${s.progress_headline}.` : ""));
    } else {
      add("progress", "top", "Progress over time",
        "Run this monthly and this section shows the trend.");
    }

    // 8. Close (no target)
    add("close", null, sample ? "Next step: the same audit on your data" : "Next step: the full audit and cleanup",
      "Here is how it goes from here:", LADDER);

    return steps;
  }

  // ------------------------------------------------------------------ the DOM layer
  /* opts: { document, window, getReportRoot(): ShadowRoot|null, onStart(), onStop(), } */
  function createTour(opts) {
    const doc = opts.document, win = opts.window;
    let state = null; // { steps, i, els, opener, listeners }

    const reduced = () => !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const wide = () => win.innerWidth >= 960 && win.innerWidth > win.innerHeight;
    function el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function resolve(target) {
      if (!target) return null;
      let node = null;
      if (target.startsWith("app:")) node = doc.getElementById(target.slice(4));
      else {
        const root = opts.getReportRoot && opts.getReportRoot();
        node = root ? root.querySelector(`[data-tour="${target}"]`) : null;
      }
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return r.width || r.height ? node : null;
    }

    function stickyInset() {
      // the toolbar sticks to the top while the report scrolls under it
      const tb = doc.querySelector("#view-result .toolbar");
      if (!tb) return 12;
      const top = parseFloat(win.getComputedStyle(tb).top) || 0;
      return top + tb.offsetHeight + 10;
    }

    function layout() {
      const { els } = state;
      const side = wide();
      els.root.classList.toggle("is-side", side);
      doc.body.classList.toggle("tour-side", side);
      return side;
    }

    function place() {
      if (!state) return;
      const { els } = state;
      const step = state.steps[state.i];
      const node = resolve(step.target);
      const sp = els.spot;
      if (!node) {
        sp.hidden = true;
        els.dims.forEach((d) => { d.hidden = true; });
        els.root.classList.add("no-target");
        return;
      }
      els.root.classList.remove("no-target");
      const r = node.getBoundingClientRect();
      const pad = 8, vw = win.innerWidth, vh = win.innerHeight;
      const top = Math.max(r.top - pad, 4), left = Math.max(r.left - pad, 4);
      const bottom = Math.min(r.bottom + pad, vh - 4), right = Math.min(r.right + pad, vw - 4);
      sp.hidden = false;
      sp.style.top = `${top}px`;
      sp.style.left = `${left}px`;
      sp.style.width = `${Math.max(right - left, 0)}px`;
      sp.style.height = `${Math.max(bottom - top, 0)}px`;
      // dim everything else with four panels around the cut-out (no huge shadows: works in every browser)
      const box = [[0, 0, vw, top], [0, bottom, vw, vh - bottom], [0, top, left, bottom - top], [right, top, vw - right, bottom - top]];
      els.dims.forEach((d, k) => {
        const [x, y, w, h] = box[k];
        d.hidden = false;
        Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(w, 0)}px`, height: `${Math.max(h, 0)}px` });
      });
    }

    let queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      // animation frame normally; the timer covers a page whose frames are throttled (e.g. a background tab)
      const run = () => { if (!queued) return; queued = false; place(); };
      win.requestAnimationFrame(run);
      win.setTimeout(run, 60);
    }

    function scrollToTarget(step) {
      const node = resolve(step.target);
      const behavior = reduced() ? "auto" : "smooth";
      if (!node) { return; }
      if (step.target.startsWith("app:")) { win.scrollTo({ top: 0, behavior }); return; }
      const side = wide();
      const cardH = side ? 0 : state.els.card.offsetHeight + 40;
      const inset = stickyInset();
      const free = win.innerHeight - cardH - inset;
      const r = node.getBoundingClientRect();
      // centre it in the visible area when it fits, otherwise show its top
      const want = inset + (r.height < free ? (free - r.height) / 2 : 6);
      win.scrollTo({ top: Math.max(win.scrollY + r.top - want, 0), behavior });
    }

    function render() {
      const { els, steps, i } = state;
      const step = steps[i];
      els.title.textContent = step.title;
      els.text.textContent = step.text;
      els.list.textContent = "";
      els.list.hidden = !step.list;
      if (step.list) for (const t of step.list) els.list.appendChild(el("li", "", t));
      els.count.textContent = `${i + 1} of ${steps.length}`;
      els.dots.textContent = "";
      steps.forEach((_, k) => els.dots.appendChild(el("i", k === i ? "on" : "")));
      els.back.disabled = i === 0;
      els.back.setAttribute("aria-disabled", String(i === 0));
      const last = i === steps.length - 1;
      els.next.textContent = last ? "Done" : "Next";
      els.root.classList.toggle("is-center", !step.target);
      layout();
      place();
      scrollToTarget(step);
      // reposition once layout and any smooth scroll have settled
      win.setTimeout(schedule, 60);
      win.setTimeout(schedule, 450);
      win.setTimeout(schedule, 1000);
    }

    function go(delta) {
      if (!state) return;
      const j = state.i + delta;
      if (j < 0) return;
      if (j >= state.steps.length) return stop(true);
      state.i = j;
      render();
    }

    function onKey(e) {
      if (!state) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(true); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "Tab") {
        // keep focus on the card
        const f = [state.els.card, state.els.close, state.els.back, state.els.next].filter((x) => !x.disabled);
        const at = f.indexOf(doc.activeElement);
        const nx = e.shiftKey ? (at <= 0 ? f.length - 1 : at - 1) : (at === f.length - 1 ? 0 : at + 1);
        e.preventDefault();
        f[nx].focus();
      }
    }

    let touch = null;
    const onTouchStart = (e) => {
      const t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY };
    };
    const onTouchEnd = (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    };

    /* steps: from buildTourSteps. Steps whose target can't be found on the page are dropped, so there is
       never an empty spotlight. */
    function start(summary) {
      if (state) stop(false);
      const steps = buildTourSteps(summary).filter((s) => !s.target || resolve(s.target));
      if (steps.length < 2) return false;
      const opener = doc.activeElement;
      if (opts.onStart) opts.onStart();

      const root = el("div", "tour");
      root.setAttribute("data-tour-ui", "");
      const block = el("div", "tour-block");
      const spot = el("div", "tour-spot");
      spot.setAttribute("aria-hidden", "true");
      const dims = [0, 1, 2, 3].map(() => { const d = el("div", "tour-dim"); d.setAttribute("aria-hidden", "true"); return d; });
      const card = el("section", "tour-card");
      card.tabIndex = -1;
      card.setAttribute("role", "region");
      card.setAttribute("aria-label", "Guided demo");
      const live = el("div", "tour-live");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      const title = el("h2", "tour-title");
      const text = el("p", "tour-text");
      const list = el("ol", "tour-list");
      live.append(title, text, list);
      const foot = el("div", "tour-foot");
      const count = el("span", "tour-count");
      const dots = el("span", "tour-dots");
      dots.setAttribute("aria-hidden", "true");
      const nav = el("span", "tour-nav");
      const back = el("button", "tour-btn", "Back");
      back.type = "button";
      const next = el("button", "tour-btn primary", "Next");
      next.type = "button";
      nav.append(back, next);
      foot.append(count, dots, nav);
      const close = el("button", "tour-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Exit the guided demo");
      card.append(close, live, foot);
      root.append(block, ...dims, spot, card);
      doc.body.append(root);
      doc.body.classList.add("tour-open");

      const els = { root, block, dims, spot, card, live, title, text, list, count, dots, back, next, close };
      state = { steps, i: 0, els, opener };
      back.addEventListener("click", () => go(-1));
      next.addEventListener("click", () => go(1));
      close.addEventListener("click", () => stop(true));
      root.addEventListener("touchstart", onTouchStart, { passive: true });
      root.addEventListener("touchend", onTouchEnd, { passive: true });
      doc.addEventListener("keydown", onKey, true);
      win.addEventListener("resize", onResize);
      win.addEventListener("orientationchange", onResize);
      win.addEventListener("scroll", schedule, { passive: true });
      win.addEventListener("scrollend", schedule);
      render();
      card.focus({ preventScroll: true });
      return true;
    }

    function onResize() {
      if (!state) return;
      layout();
      schedule();
      win.setTimeout(() => { if (state) { scrollToTarget(state.steps[state.i]); schedule(); } }, 250);
    }

    function stop(restoreFocus) {
      if (!state) return;
      const { els, opener } = state;
      doc.removeEventListener("keydown", onKey, true);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("orientationchange", onResize);
      win.removeEventListener("scroll", schedule);
      win.removeEventListener("scrollend", schedule);
      els.root.remove();
      doc.body.classList.remove("tour-open", "tour-side");
      state = null;
      if (opts.onStop) opts.onStop();
      if (restoreFocus) {
        const target = opener && opener.isConnected && opener.offsetParent !== null ? opener : doc.getElementById("walk-through");
        if (target && target.focus) target.focus();
      }
    }

    return { start, stop, isOpen: () => !!state };
  }

  return { buildTourSteps, createTour, LADDER };
})();
if (typeof module !== "undefined" && module.exports) module.exports = UroboricTour;
