// widget.js — floating in-page Co-Pilot widget.
//
// Modes:
//   compact  — small score-checker panel + cycle countdown + what-if mini sim.
//   full     — fully-featured extension popup, embedded in-page via iframe.
//
// Both modes share the same draggable header. The "minimize" button collapses
// to a corner pill, "close" hides for 5 s. The whole thing is the SAME panel
// the user can keep open on the page while playing.
//
// Runs in ISOLATED world so it can use chrome.runtime.sendMessage.

(function () {
  "use strict";

  const STATE_KEY = "acpWidgetState";
  const READY_FLAG = "__acpWidgetMounted__";
  if (window[READY_FLAG]) return;
  window[READY_FLAG] = true;

  function loadState() {
    try { const raw = localStorage.getItem(STATE_KEY); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function patchState(p) { const s = loadState(); Object.assign(s, p); saveState(s); return s; }
  function optClass(score) {
    if (score == null) return "";
    if (score >= 80) return "opt-excellent";
    if (score >= 65) return "opt-good";
    if (score >= 50) return "opt-ok";
    if (score >= 35) return "opt-weak";
    return "opt-bad";
  }
  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function send(message) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(message, (resp) => resolve(resp)); }
      catch (e) { resolve(null); }
    });
  }
  function fmtMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const v = Math.abs(n);
    if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(1)}k`;
    return `${sign}$${v.toFixed(0)}`;
  }

  // ---------- mount ----------
  const initial = loadState();
  const startFull = !!initial.fullMode;
  const startMinimized = !!initial.minimized;

  const root = document.createElement("div");
  root.id = "acp-widget";
  root.dataset.mode = startFull ? "full" : "compact";
  if (startMinimized) root.classList.add("hidden");

  root.innerHTML = `
    <div class="acp-head" data-drag>
      <div class="acp-logo">A</div>
      <div class="acp-title">Co-Pilot</div>
      <div class="acp-cycle" id="acp-cycle" title="Current cycle / time remaining"></div>
      <div class="acp-actions">
        <button class="acp-icon-btn" data-action="toggle-mode" title="Expand / collapse">⤢</button>
        <button class="acp-icon-btn" data-action="minimize" title="Minimize">—</button>
        <button class="acp-icon-btn" data-action="close" title="Hide">×</button>
      </div>
    </div>
    <div class="acp-body acp-body-compact">
      <div class="acp-row">
        <input id="acp-from" placeholder="FROM" maxlength="4" autocomplete="off" style="text-align:center;" />
        <span class="acp-arrow">→</span>
        <input id="acp-to" placeholder="TO" maxlength="4" autocomplete="off" style="text-align:center;" />
      </div>
      <button class="acp-go" id="acp-go">Calculate Route</button>
      <div id="acp-result" class="acp-empty">Ready. Enter route or open one in-game.</div>

      <details id="acp-whatif" class="acp-whatif" open>
        <summary>What-if simulator</summary>
        <div class="acp-whatif-grid">
          <label>Ticket price <span title="If you set this, we estimate price elasticity">$<input id="acp-wi-price" type="number" min="0" /></span></label>
          <label>Frequency <span title="Flights per week (round-trip)"><input id="acp-wi-freq" type="number" min="1" /></span></label>
        </div>
        <button class="acp-go acp-go-secondary" id="acp-wi-run">Recompute</button>
        <div id="acp-wi-out" class="acp-empty">First score a route, then tweak price/frequency here to see projected weekly profit.</div>
      </details>
    </div>
    <div class="acp-body acp-body-full">
      <iframe id="acp-iframe" title="Co-Pilot full panel" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe>
    </div>
  `;
  document.documentElement.appendChild(root);

  const pill = document.createElement("button");
  pill.id = "acp-pill";
  pill.innerHTML = `<span class="dot"></span><span class="pill-text">Co-Pilot</span>`;
  if (!startMinimized) pill.classList.add("hidden");
  document.documentElement.appendChild(pill);

  // ---------- drag ----------
  if (initial.left != null && initial.top != null) {
    root.style.left = `${initial.left}px`;
    root.style.top = `${initial.top}px`;
    root.style.right = "auto";
  }
  if (initial.fullWidth) root.style.width = `${initial.fullWidth}px`;
  if (initial.fullHeight) root.style.height = `${initial.fullHeight}px`;

  const head = root.querySelector(".acp-head");
  let dragging = null;
  head.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-action]")) return;
    const rect = root.getBoundingClientRect();
    dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = root.offsetWidth, h = root.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - dragging.dx));
    const top = Math.max(4, Math.min(window.innerHeight - h - 4, e.clientY - dragging.dy));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = "auto";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = null;
    patchState({
      left: parseFloat(root.style.left) || null,
      top: parseFloat(root.style.top) || null,
    });
  });

  // ---------- mode toggle (compact ↔ full popup) ----------
  let iframeLoaded = false;
  function applyMode() {
    const mode = root.dataset.mode;
    if (mode === "full" && !iframeLoaded) {
      const iframe = root.querySelector("#acp-iframe");
      iframe.src = chrome.runtime.getURL("popup/popup.html");
      iframeLoaded = true;
    }
  }
  function setMode(mode) {
    root.dataset.mode = mode;
    patchState({ fullMode: mode === "full" });
    applyMode();
  }
  applyMode();
  root.querySelector('[data-action="toggle-mode"]').addEventListener("click", () => {
    setMode(root.dataset.mode === "full" ? "compact" : "full");
  });

  // ---------- minimize / close ----------
  function minimize() {
    root.classList.add("hidden");
    pill.classList.remove("hidden");
    patchState({ minimized: true, hidden: false });
  }
  function expand() {
    root.classList.remove("hidden");
    pill.classList.add("hidden");
    patchState({ minimized: false, hidden: false });
  }
  function closeWidget() {
    root.classList.add("hidden");
    pill.classList.add("hidden");
    patchState({ minimized: false, hidden: true });
    setTimeout(() => {
      const ss = loadState();
      if (ss.hidden) {
        pill.classList.remove("hidden");
        patchState({ hidden: false, minimized: true });
      }
    }, 5000);
  }
  root.querySelector('[data-action="minimize"]').addEventListener("click", minimize);
  root.querySelector('[data-action="close"]').addEventListener("click", closeWidget);
  pill.addEventListener("click", expand);

  function priceTriplet(p) {
    if (p == null) return "—";
    if (typeof p === "number") return `${p}`;
    const e = p.economy != null ? `${p.economy}` : "—";
    const b = p.business != null ? `${p.business}` : "—";
    const f = p.first != null ? `${p.first}` : "—";
    return `<span style="font-family: monospace; font-size: 11px;"><span>${e}</span><span style="opacity:0.5;margin:0 2px">/</span><span>${b}</span><span style="opacity:0.5;margin:0 2px">/</span><span>${f}</span></span>`;
  }

  // ---------- compact: score lookup ----------
  const fromInput = root.querySelector("#acp-from");
  const toInput = root.querySelector("#acp-to");
  const goBtn = root.querySelector("#acp-go");
  const resultEl = root.querySelector("#acp-result");
  const wiPriceEl = root.querySelector("#acp-wi-price");
  const wiFreqEl = root.querySelector("#acp-wi-freq");
  const wiOutEl = root.querySelector("#acp-wi-out");
  const wiRunBtn = root.querySelector("#acp-wi-run");
  let lastScore = null;

  [fromInput, toInput].forEach((el) => {
    el.addEventListener("input", () => { el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") runScore(); });
  });

  async function runScore({ fromIata, toIata, autoSrc } = {}) {
    const from = (fromIata || fromInput.value || "").trim().toUpperCase();
    const to = (toIata || toInput.value || "").trim().toUpperCase();
    if (from.length < 3 || to.length < 3) {
      resultEl.innerHTML = `<div class="acp-err">Please enter both airport codes.</div>`;
      return;
    }
    if (from === to) {
      resultEl.innerHTML = `<div class="acp-err">From and To can't be the same.</div>`;
      return;
    }
    fromInput.value = from;
    toInput.value = to;
    goBtn.disabled = true;
    resultEl.innerHTML = `<div class="acp-empty">Scoring ${from} → ${to}${autoSrc ? " (auto-detected from game)" : ""}…</div>`;
    const resp = await send({ type: "SCORE_ROUTE", fromIata: from, toIata: to });
    goBtn.disabled = false;
    const r = resp?.result;
    if (!r?.ok) {
      resultEl.innerHTML = `<div class="acp-err">${escape(r?.error || "Could not score this route.")}</div>`;
      return;
    }
    lastScore = r;
    wiPriceEl.value = r.priceByClass?.economy ?? r.myPrice ?? 0;
    wiFreqEl.value = r.maxFrequency;
    renderResult(r);
    runWhatIf();
  }
  goBtn.addEventListener("click", () => runScore());

  function renderResult(r) {
    const opt = r.optimality ?? 0;
    const cls = optClass(opt);
    const b = r.optimalityBreakdown || {};
    const factor = (name, val = 0) => `
      <div class="acp-factor">
        <div class="name">${escape(name)}</div>
        <div class="bar"><div class="fill" style="width:${val}%"></div></div>
        <div class="val">${val}%</div>
      </div>`;
    const verdict =
      opt >= 80 ? "Excellent opportunity — open it"
      : opt >= 65 ? "Good route — open with confidence"
      : opt >= 50 ? "OK — viable, monitor competition"
      : opt >= 35 ? "Weak — risky, look elsewhere"
      : "Avoid — won't make money";
    resultEl.innerHTML = `
      <div class="acp-score ${cls}">
        <div>
          <div class="label">Optimality</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);">${escape(r.fromIata)} → ${escape(r.toIata)} · ${r.distance} km</div>
          <div style="font-size:10.5px;margin-top:2px;color:rgba(255,255,255,0.55);">${escape(verdict)}</div>
        </div>
        <div class="num">${opt}%</div>
      </div>
      <div class="acp-kv">
        <div class="k">Aircraft</div><div class="v">${escape(r.suggestedModel.name)}${r.suggestedModel.fitNote === "buy" ? " (buy)" : ""}</div>
        <div class="k">Capacity</div><div class="v">${r.suggestedModel.capacity} seats</div>
        <div class="k">Max freq</div><div class="v">${r.maxFrequency}/wk</div>
        <div class="k">Load factor</div><div class="v">${((r.loadFactor || 0) * 100).toFixed(0)}%</div>
        <div class="k">Demand</div><div class="v">${r.demandSeats}/wk</div>
        <div class="k">Free demand</div><div class="v">${r.freeDemand}/wk</div>
        <div class="k">Competitors</div><div class="v">${r.rivalCount}</div>
        <div class="k">Ticket price</div><div class="v">${priceTriplet(r.priceByClass)}</div>
        <div class="k">Quality</div><div class="v">${r.quality ? '⭐'.repeat(r.quality) : '★★★'}</div>
        <div class="k">Profit / wk</div><div class="v" style="color:${(r.profitPerWeek || 0) >= 0 ? "#86efac" : "#fda4af"}">${fmtMoney(r.profitPerWeek)}</div>
      </div>
      <div class="acp-factors">
        ${factor("Profit", b.profit)}
        ${factor("Load", b.loadFactor)}
        ${factor("Headroom", b.headroom)}
        ${factor("Competition", b.competition)}
        ${factor("Fleet fit", b.fleetFit)}
        ${factor("Distance", b.distance)}
        ${factor("Runway", b.runway)}
      </div>
    `;
  }

  function runWhatIf() {
    if (!lastScore) {
      wiOutEl.innerHTML = `<div class="acp-empty">First score a route, then tweak price/frequency here.</div>`;
      return;
    }
    const basePrice = Math.max(1, Number(lastScore.myPrice) || 1);
    const newPrice = Math.max(1, Number(wiPriceEl.value) || basePrice);
    const newFreq = Math.max(1, Number(wiFreqEl.value) || lastScore.maxFrequency);
    // Simple price elasticity model: -1 percent demand per 1% above standard, +1% per 1% below.
    // Clamped to [0.1, 2.5] of base demand.
    const priceRatio = newPrice / basePrice;
    const demandMultiplier = Math.max(0.1, Math.min(2.5, 2 - priceRatio));
    const cap = lastScore.suggestedModel.capacity * newFreq;
    const baseFreeDemand = lastScore.freeDemand || 0;
    const adjFree = baseFreeDemand * demandMultiplier;
    const captured = Math.min(cap, adjFree);
    const lf = cap > 0 ? captured / cap : 0;
    // Cost: roughly proportional to frequency.
    const costPerFreq = lastScore.weeklyOpCost / Math.max(1, lastScore.maxFrequency);
    const newCost = costPerFreq * newFreq;
    const revenue = Math.max(0, captured * newPrice);
    const profit = revenue - newCost;
    const profitDelta = profit - (lastScore.profitPerWeek || 0);
    wiOutEl.innerHTML = `
      <div class="acp-kv">
        <div class="k">New load factor</div><div class="v">${(lf * 100).toFixed(0)}%</div>
        <div class="k">Captured</div><div class="v">${Math.round(captured)}/wk</div>
        <div class="k">Revenue</div><div class="v">${fmtMoney(revenue)}</div>
        <div class="k">Op cost</div><div class="v">${fmtMoney(newCost)}</div>
        <div class="k">Profit / wk</div><div class="v" style="color:${profit >= 0 ? "#86efac" : "#fda4af"}">${fmtMoney(profit)}</div>
        <div class="k">Δ vs current</div><div class="v" style="color:${profitDelta >= 0 ? "#86efac" : "#fda4af"}">${profitDelta >= 0 ? "+" : ""}${fmtMoney(profitDelta)}</div>
      </div>
      <div class="acp-empty" style="font-size:10.5px;margin-top:6px">Simple elasticity model — game uses richer demand simulation. Treat as a directional guide.</div>
    `;
  }
  wiRunBtn.addEventListener("click", runWhatIf);

  // ---------- cycle countdown in header ----------
  const cycleEl = root.querySelector("#acp-cycle");
  async function updateCycle() {
    try {
      const resp = await send({ type: "GET_DASHBOARD" });
      const cyc = resp?.data?.snapshots?.cycle;
      if (!cyc?.cycle) { cycleEl.textContent = ""; return; }
      const min = Math.max(0, Math.floor((cyc.remainingMs || 0) / 60000));
      cycleEl.innerHTML = `<span class="cyc-num">c${cyc.cycle}</span><span class="cyc-sep">·</span><span class="cyc-rem">${min}m</span>`;
    } catch (e) { /* ignore */ }
  }
  updateCycle();
  setInterval(updateCycle, 30_000);

  // ---------- auto-detect plan-link (from game DOM via page-probe) ----------
  let lastAutoScored = "";
  document.addEventListener("acpPlanLink", (ev) => {
    const detail = ev.detail || {};
    if (detail.closed || !detail.fromIata || !detail.toIata) {
      // Plan-link panel closed → tear down badge.
      document.querySelectorAll(".acp-link-badge").forEach((el) => el.remove());
      lastAutoScored = "";
      return;
    }
    const sig = `${detail.fromIata}|${detail.toIata}|${detail.model}`;
    if (sig === lastAutoScored) {
      // Re-inject in case the panel re-rendered without changing the pair.
      injectInlineBadge(detail.fromIata, detail.toIata, detail.model);
      return;
    }
    lastAutoScored = sig;
    runScore({ fromIata: detail.fromIata, toIata: detail.toIata, model: detail.model, autoSrc: true })
      .then(() => injectInlineBadge(detail.fromIata, detail.toIata, detail.model));
  });

  // ---------- in-game inline badge ----------
  // The game's plan-link details panel is identified by `#planLinkDetails`.
  // We insert a single badge right at the top — visible whenever the user
  // opens the "Plan flight" UI. Multiple concurrent calls and the observer's
  // self-triggering writes were duplicating the badge, so this function is
  // serialized through a mutex and gated by a stable signature.
  let badgeMutex = Promise.resolve();
  let lastBadgeSig = "";
  let suppressObserver = false;
  function injectInlineBadge(fromIata, toIata, model) {
    const sig = `${fromIata}|${toIata}|${model}`;
    badgeMutex = badgeMutex.then(() => _injectInlineBadge(fromIata, toIata, model, sig)).catch(() => {});
    return badgeMutex;
  }
  async function _injectInlineBadge(fromIata, toIata, model, sig) {
    const container = findPlanLinkAnchor();
    if (!container) {
      // No panel visible — drop any stale badges and exit quietly.
      removeAllBadges();
      lastBadgeSig = "";
      return;
    }
    // If a fresh badge for the same pair is already present, do nothing.
    const existing = container.querySelector(".acp-link-badge");
    if (existing && existing.dataset.sig === sig) return;

    // Inject skeleton immediately
    suppressObserver = true;
    try {
      removeAllBadges();
      const skel = document.createElement("div");
      skel.className = "acp-link-badge acp-skeleton";
      skel.dataset.sig = sig;
      skel.innerHTML = '<span class="acp-bdg-pct">...</span><span class="acp-bdg-label">Analyzing route & competitors...</span>';
      container.insertBefore(skel, container.firstChild);
      lastBadgeSig = sig;
    } finally {
      setTimeout(() => { suppressObserver = false; }, 50);
    }

    const resp = await send({ type: "SCORE_ROUTE", fromIata, toIata, modelId: model });
    const r = resp?.result;
    if (!r?.ok) return;

    // Re-resolve container in case the panel re-rendered during the await.
    const c2 = findPlanLinkAnchor();
    if (!c2) return;

    suppressObserver = true;
    try {
      removeAllBadges();
      const badge = document.createElement("div");
      badge.className = `acp-link-badge ${optClass(r.optimality)}`;
      badge.dataset.sig = sig;
      badge.title = "Click for the full Co-Pilot breakdown";
      badge.innerHTML = `
        <span class="acp-bdg-pct">${r.optimality}%</span>
        <span class="acp-bdg-label">Optimality — Co-Pilot recommendation</span>
        <span class="acp-bdg-mini">${escape(r.suggestedModel.name)} · ${r.maxFrequency}/wk · ${fmtMoney(r.profitPerWeek)}/wk</span>
        <span class="acp-bdg-cta">Details ›</span>
      `;
      badge.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        expand();
        runScore({ fromIata, toIata });
      });
      c2.insertBefore(badge, c2.firstChild);
      lastBadgeSig = sig;
    } finally {
      // Let the observer ignore the mutation we just produced.
      setTimeout(() => { suppressObserver = false; }, 50);
    }
  }

  function removeAllBadges() {
    document.querySelectorAll(".acp-link-badge").forEach((el) => el.remove());
  }

  function findPlanLinkAnchor() {
    const c =
      document.querySelector("#planLinkDetails") ||
      document.querySelector("#linkDetails") ||
      document.querySelector("#planLinkAirportInformation") ||
      document.querySelector(".planLink");
    if (!c) return null;
    // Only return the container if it's actually visible.
    if (c.offsetParent === null) return null;
    return c;
  }

  // Re-inject when the plan-link panel re-renders. Debounced via rAF so a
  // burst of mutations only produces one check, and skipped while we are
  // performing our own writes (to break the observer→inject→observer loop).
  let observerScheduled = false;
  const observer = new MutationObserver(() => {
    if (suppressObserver) return;
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(() => {
      observerScheduled = false;
      if (!lastAutoScored) return;
      const [from, to] = lastAutoScored.split("|");
      if (!from || !to) return;
      const container = findPlanLinkAnchor();
      if (!container) {
        removeAllBadges();
        lastBadgeSig = "";
        return;
      }
      const existing = container.querySelector(".acp-link-badge");
      if (existing && existing.dataset.sig === `${from}|${to}`) return;
      injectInlineBadge(from, to);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
