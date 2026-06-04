// popup.js — orchestrates the popup UI.

import { setIcons, icon } from "./icons.js";
import { drawSparkline } from "./sparkline.js";

setIcons();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = { data: null, settings: null, defaults: null };
let activeTab = "overview";

// Persistent UI state per tab. Survives auto-refresh re-renders.
const ui = {
  routes: {
    onlyProfit: false,
    onlyUnder: false,
    onlyOwnedFleet: false,
    minOptimality: 0,
    minScore: 0,
    query: "",
    expanded: new Set(), // route signatures the user has expanded
    rendered: false,     // whether the panel chrome is already mounted
    lastResultId: null,  // detect when we need to re-render the chrome
  },
  rivals: { lastSig: null },
  insights: { lastSig: null, filter: "all" },
  // Pause auto re-renders while the user is hovering an interactive panel.
  hoverPauseUntil: 0,
};

async function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => resolve(resp));
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(1)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

function fmtNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtPercent(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtCountdown(ms) {
  if (!ms || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m`;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function totalSeats(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  return (v.economy || 0) + (v.business || 0) + (v.first || 0);
}

function optimalityClass(score) {
  if (score == null) return "opt-na";
  if (score >= 80) return "opt-excellent";
  if (score >= 65) return "opt-good";
  if (score >= 50) return "opt-ok";
  if (score >= 35) return "opt-weak";
  return "opt-bad";
}

function setActiveTab(name) {
  activeTab = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  renderActive(true);
}

function renderTopBar() {
  const session = state.data?.session;
  const cycle = state.data?.snapshots?.cycle;
  if (session) {
    $("#sessionName").textContent = session.airlineName || `Airline #${session.airlineId}`;
    const balanceStr = typeof session.balance === "number" ? `Balance ${fmtMoney(session.balance)}` : "Logged in";
    const repStr = typeof session.reputation === "number" ? ` · Rep ${Math.round(session.reputation)}` : "";
    $("#sessionMeta").textContent = `${balanceStr}${repStr} · ${session.origin || ""}`;
  } else {
    $("#sessionName").textContent = "No airline detected";
    $("#sessionMeta").textContent = "Open https://www.airline-club.com (or v2) after login.";
  }
  if (cycle?.cycle != null) {
    $("#cycleNumber").textContent = cycle.cycle;
    $("#cycleRemaining").textContent = fmtCountdown(cycle.remainingMs);
    const fraction = Math.min(1, Math.max(0, cycle.fraction || 0));
    $("#cycleProgress").style.width = `${fraction * 100}%`;
  } else {
    $("#cycleNumber").textContent = "—";
    $("#cycleRemaining").textContent = "—";
    $("#cycleProgress").style.width = "0%";
  }
}

function setBadges() {
  const alertsBadge = $('[data-badge="alerts"]');
  const alertsCount = state.data?.snapshots?.alerts?.alerts?.length || 0;
  alertsBadge.textContent = alertsCount > 0 ? alertsCount : "";
  alertsBadge.classList.toggle("hidden", alertsCount === 0);

  const routesBadge = $('[data-badge="routes"]');
  const routesNew = state.data?.snapshots?.routeFinder?.top?.length || 0;
  routesBadge.textContent = routesNew > 0 ? routesNew : "";
  routesBadge.classList.toggle("hidden", routesNew === 0);

  const rivalsBadge = $('[data-badge="rivals"]');
  const rivalsCount = state.data?.snapshots?.rivals?.events?.length || 0;
  rivalsBadge.textContent = rivalsCount > 0 ? rivalsCount : "";
  rivalsBadge.classList.toggle("hidden", rivalsCount === 0);

  const insightsBadge = $('[data-badge="insights"]');
  const insightsCount = (state.data?.snapshots?.insights?.suggestions?.length) || 0;
  insightsBadge.textContent = insightsCount > 0 ? insightsCount : "";
  insightsBadge.classList.toggle("hidden", insightsCount === 0);
}

// ---------------- Tabs ----------------

function renderOverview() {
  const panel = $('[data-panel="overview"]');
  const s = state.data?.snapshots || {};
  const oil = s.oil;
  const cycle = s.cycle;
  const profit = s.profit;
  const loans = s.loans;
  const alerts = s.alerts;
  const route = s.routeFinder;

  const oilHistory = (oil?.history || []).map((p) => p.price);
  const oilLatest = oil?.latestPrice ?? "—";
  const oilDelta = oil?.deviationPct;
  const oilClass = !oil ? "stat-muted" : oilDelta <= -4 ? "stat-good" : oilDelta >= 4 ? "stat-bad" : "stat-muted";

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Overview</h2>
        <div class="desc">A full pulse of your airline — on one screen.</div>
      </div>
      <div class="row">
        <button class="ghost" id="ovOpenGame">${icon("external")} Open game</button>
        <button class="primary" id="ovRunRoutes">${icon("search")} Run route finder</button>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card">
        <div class="card-title">Cycle <span class="meta">${cycle?.cycle != null ? `#${cycle.cycle}` : ""}</span></div>
        <div class="card-value">${fmtCountdown(cycle?.remainingMs)}</div>
        <div class="card-sub">${cycle?.durationMs ? `~${Math.round((cycle.durationMs || 0) / 60000)} min/cycle` : "Open the game to sync."}</div>
      </div>
      <div class="card">
        <div class="card-title">Oil</div>
        <div class="card-value">${typeof oilLatest === "number" ? "$" + oilLatest.toFixed(2) : "—"}</div>
        <div class="card-sub ${oilClass}">${oil ? `${oilDelta >= 0 ? "+" : ""}${oilDelta.toFixed(1)}% vs ${state.settings.oilWindow}-cycle avg` : "Waiting for poll…"}</div>
        ${oilHistory.length ? `<canvas class="spark" id="oilSpark"></canvas>` : ""}
      </div>
      <div class="card">
        <div class="card-title">Routes profit / week</div>
        <div class="card-value ${profit && profit.totals?.profit < 0 ? "stat-bad" : ""}">${fmtMoney(profit?.totals?.profit)}</div>
        <div class="card-sub">${profit ? `${fmtNumber(profit.totals.soldSeats)} seats sold · LF ${fmtPercent((profit.totals.soldSeats || 0) / (profit.totals.capacity || 1))}` : "Awaiting data."}</div>
      </div>
      <div class="card">
        <div class="card-title">Loan rate</div>
        <div class="card-value">${loans?.benchmarkRate != null ? (loans.benchmarkRate * 100).toFixed(2) + "%" : "—"}</div>
        <div class="card-sub">${loans?.benchmarkTerm ? `${loans.benchmarkTerm}w benchmark` : "Waiting for poll…"}</div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:12px">
      <div class="card">
        <div class="card-title">Top route opportunities</div>
        ${
          route?.top?.length
            ? `
              <div class="flex-col" style="gap:8px;margin-top:4px">
                ${route.top.slice(0, 5).map((r) => `
                  <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
                    <div style="min-width:0">
                      <div style="font-weight:600;letter-spacing:-0.01em">${escape(r.fromAirport.iata || "?")} → ${escape(r.toAirport.iata || "?")}</div>
                      <div class="card-sub" style="margin-top:1px">${escape(r.fromAirport.city || "")} → ${escape(r.toAirport.city || "")} · ${r.distance} km · ${r.rivalCount} rivals</div>
                    </div>
                    <div style="text-align:right;font-family:var(--mono)">
                      <div class="opt-badge ${optimalityClass(r.optimality)}">${r.optimality}%</div>
                      <div class="${r.profitPerWeek > 0 ? "stat-good" : "stat-bad"}" style="margin-top:2px">${fmtMoney(r.profitPerWeek)}/wk</div>
                      <div class="card-sub" style="font-size:10.5px">${escape(r.suggestedModel.name)} · ${r.maxFrequency}×</div>
                    </div>
                  </div>
                `).join("")}
              </div>
            `
            : `<div class="empty-state">No route scan yet. Click <b>Run route finder</b>.</div>`
        }
      </div>
      <div class="card">
        <div class="card-title">Latest alerts</div>
        ${
          alerts?.alerts?.length
            ? `<div class="flex-col" style="gap:6px;margin-top:4px">
                ${alerts.alerts.slice(0, 5).map((a) => `
                  <div class="row" style="justify-content:space-between;gap:8px">
                    <div style="min-width:0">
                      <div style="white-space:normal">${escape(a.message)}</div>
                      <div class="card-sub" style="font-size:10.5px">${escape(a.categoryText || "")}</div>
                    </div>
                    <div class="chip ${a.cycleDelta <= 1 ? "chip-warn" : ""}">Δ${a.cycleDelta ?? 0}c</div>
                  </div>`).join("")}
              </div>`
            : `<div class="empty-state">No alerts yet.</div>`
        }
      </div>
    </div>
  `;

  if (oilHistory.length) drawSparkline($("#oilSpark"), oilHistory);

  $("#ovOpenGame").addEventListener("click", () => {
    chrome.tabs.create({ url: state.data?.session?.origin || "https://www.airline-club.com" });
  });
  $("#ovRunRoutes").addEventListener("click", async () => {
    await send({ type: "RUN_ROUTE_FINDER" });
    setActiveTab("routes");
  });
}

function routeSig(r) {
  return `${r.fromAirport.id}-${r.toAirport.id}`;
}

function renderRoutes(forceMount = false) {
  const panel = $('[data-panel="routes"]');
  const r = state.data?.snapshots?.routeFinder;
  const status = state.data?.snapshots?.routeFinderStatus;
  const session = state.data?.session;
  const resultId = r?.generatedAt ?? null;

  const needsMount = forceMount || !ui.routes.rendered || ui.routes.lastResultId !== resultId;
  if (needsMount) {
    panel.innerHTML = `
      <div class="section-head">
        <div>
          <h2>Route finder</h2>
          <div class="desc">Auto-discovers profitable routes: your bases × fleet × <code>/research-link</code> + profitability calc with current oil price. Each row gets a composite Optimality score (0–100%).</div>
        </div>
        <div class="row">
          <button class="ghost" id="rfExport">${icon("download")} CSV</button>
          <button class="primary" id="rfRun">${icon("search")} Scan now</button>
        </div>
      </div>

      <div class="grid grid-3" style="margin-bottom:12px">
        <div class="card"><div class="card-title">Last scan</div>
          <div class="card-value" style="font-size:14px;font-weight:500" id="rfLastScan">—</div>
          <div class="card-sub" id="rfLastScanSub"></div>
        </div>
        <div class="card"><div class="card-title">Bases &amp; fleet</div>
          <div class="card-value" style="font-size:14px;font-weight:500" id="rfBases">—</div>
          <div class="card-sub" id="rfFleet"></div>
        </div>
        <div class="card"><div class="card-title">Status</div>
          <div class="card-value" style="font-size:14px;font-weight:500" id="rfStatus">Idle</div>
          <div class="card-sub" id="rfStatusSub"></div>
          <div class="progress hidden" id="rfProgressWrap" style="margin-top:6px"><div class="progress-fill" id="rfProgress"></div></div>
        </div>
      </div>

      <div class="row-wrap" style="margin-bottom:8px;gap:10px">
        <label class="toggle"><input type="checkbox" id="filterProfit" /> Only profitable</label>
        <label class="toggle"><input type="checkbox" id="filterUnderserved" /> Only underserved</label>
        <label class="toggle"><input type="checkbox" id="filterOwned" /> Only owned fleet</label>
        <input id="filterMinOpt" type="number" placeholder="Min Optimality %" min="0" max="100" />
        <input id="filterMinScore" type="number" placeholder="Min score $/wk" />
        <input id="filterIata" type="text" placeholder="IATA / city filter" />
        <span id="rfMatchCount" class="card-sub" style="margin-left:auto"></span>
      </div>

      <div class="table-wrap">
        <table class="data" id="routesTable">
          <thead>
            <tr>
              <th>Opt</th>
              <th>From → To</th>
              <th class="num">Dist</th>
              <th class="num">Demand</th>
              <th class="num">Free</th>
              <th>Aircraft</th>
              <th class="num">Freq</th>
              <th class="num">Planes</th>
              <th class="num">LF</th>
              <th class="num">Profit/wk</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="routesBody"></tbody>
        </table>
      </div>
    `;
    ui.routes.rendered = true;
    ui.routes.lastResultId = resultId;

    // Restore filter values into inputs.
    $("#filterProfit").checked = ui.routes.onlyProfit;
    $("#filterUnderserved").checked = ui.routes.onlyUnder;
    $("#filterOwned").checked = ui.routes.onlyOwnedFleet;
    if (ui.routes.minOptimality > 0) $("#filterMinOpt").value = ui.routes.minOptimality;
    if (ui.routes.minScore > 0) $("#filterMinScore").value = ui.routes.minScore;
    if (ui.routes.query) $("#filterIata").value = ui.routes.query;

    $("#rfRun").addEventListener("click", async () => {
      $("#rfRun").disabled = true;
      await send({ type: "RUN_ROUTE_FINDER" });
      setTimeout(refreshData, 500);
    });
    $("#rfExport").addEventListener("click", () => exportRoutesCSV(r));

    const bindFilter = (id, key, valFn) => {
      $("#" + id).addEventListener("input", () => {
        ui.routes[key] = valFn();
        applyRouteFilters();
      });
    };
    bindFilter("filterProfit", "onlyProfit", () => $("#filterProfit").checked);
    bindFilter("filterUnderserved", "onlyUnder", () => $("#filterUnderserved").checked);
    bindFilter("filterOwned", "onlyOwnedFleet", () => $("#filterOwned").checked);
    bindFilter("filterMinOpt", "minOptimality", () => Number($("#filterMinOpt").value) || 0);
    bindFilter("filterMinScore", "minScore", () => Number($("#filterMinScore").value) || 0);
    bindFilter("filterIata", "query", () => ($("#filterIata").value || "").trim().toLowerCase());
  }

  // Update top-bar cards (no DOM rebuild — keeps focus/state on inputs).
  $("#rfLastScan").textContent = r?.generatedAt ? new Date(r.generatedAt).toLocaleString() : "—";
  $("#rfLastScanSub").textContent = r ? `${r.scored} of ${r.researched} candidates` : "Click Scan now.";
  $("#rfBases").innerHTML = r?.bases?.length ? r.bases.map((b) => escape(b.iata || b.id)).join(" · ") : "—";
  $("#rfFleet").textContent = r?.fleet?.length
    ? `${r.fleet.length} models · range ≤ ${Math.max(0, ...r.fleet.map((f) => f.range))} km`
    : "";

  const statusEl = $("#rfStatus");
  const statusSub = $("#rfStatusSub");
  const progressWrap = $("#rfProgressWrap");
  const progressBar = $("#rfProgress");
  if (status?.running) {
    statusEl.innerHTML = `${escape(status.phase || "running")}…`;
    statusSub.textContent = `${status.progress || 0} / ${status.total || 0}`;
    progressWrap.classList.remove("hidden");
    const pct = status.total ? (status.progress / status.total) * 100 : 5;
    progressBar.style.width = `${pct}%`;
  } else if (status?.error) {
    statusEl.innerHTML = `<span class="stat-bad">${escape(status.error)}</span>`;
    statusSub.textContent = "Open the game and try Scan again.";
    progressWrap.classList.add("hidden");
  } else {
    statusEl.textContent = "Idle";
    statusSub.textContent = "Scans run automatically.";
    progressWrap.classList.add("hidden");
  }

  applyRouteFilters();
}

function applyRouteFilters() {
  const r = state.data?.snapshots?.routeFinder;
  const session = state.data?.session;
  const list = r?.top || [];
  const q = ui.routes.query;
  const filtered = list.filter((row) => {
    if (ui.routes.onlyProfit && row.profitPerWeek <= 0) return false;
    if (ui.routes.onlyUnder && row.freeDemand <= 0) return false;
    if (ui.routes.onlyOwnedFleet && row.suggestedModel.fitNote !== "owned") return false;
    if ((row.optimality ?? 0) < ui.routes.minOptimality) return false;
    if ((row.score ?? 0) < ui.routes.minScore) return false;
    if (q) {
      const blob = `${row.fromAirport.iata} ${row.fromAirport.city} ${row.toAirport.iata} ${row.toAirport.city} ${row.fromAirport.country} ${row.toAirport.country}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  $("#rfMatchCount").textContent = list.length ? `${filtered.length} / ${list.length} match` : "";
  const body = $("#routesBody");
  if (!body) return;
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="11"><div class="empty-state">${list.length ? "No routes match the filter." : "No route scan yet. Click Scan now."}</div></td></tr>`;
    return;
  }
  body.innerHTML = filtered.map((row) => {
    const sig = routeSig(row);
    const expanded = ui.routes.expanded.has(sig);
    const fit = row.suggestedModel.fitNote === "owned" ? "" : `<span class="chip chip-warn" title="Not in your fleet">buy</span>`;
    const owned = row.suggestedModel.ownedCount > 0 ? `${row.suggestedModel.ownedCount}× owned` : "0× owned";
    return `
      <tr class="route-row" data-sig="${escape(sig)}">
        <td>
          <div class="opt-badge ${optimalityClass(row.optimality)}" title="Composite Optimality score">${row.optimality}%</div>
        </td>
        <td>
          <div><b>${escape(row.fromAirport.iata || "?")} → ${escape(row.toAirport.iata || "?")}</b></div>
          <div class="small">${escape(row.fromAirport.city || "")} → ${escape(row.toAirport.city || "")}</div>
        </td>
        <td class="num">${row.distance}</td>
        <td class="num">${fmtNumber(row.demandSeats)}</td>
        <td class="num ${row.freeDemand > 0 ? "stat-good" : "stat-muted"}">${fmtNumber(row.freeDemand)}</td>
        <td>
          <div>${escape(row.suggestedModel.name)} ${fit}</div>
          <div class="small">${owned} · ${row.suggestedModel.capacity} seats</div>
        </td>
        <td class="num">${row.maxFrequency}</td>
        <td class="num">${row.planesNeeded}</td>
        <td class="num">${fmtPercent(row.loadFactor)}</td>
        <td class="num ${row.profitPerWeek > 0 ? "stat-good" : "stat-bad"}">${fmtMoney(row.profitPerWeek)}</td>
        <td><button class="link-btn" data-sig="${escape(sig)}">${expanded ? "Hide" : "Details"}</button></td>
      </tr>
      ${expanded ? routeDetailHTML(row, session) : ""}
    `;
  }).join("");

  $$("#routesBody .link-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sig = btn.dataset.sig;
      if (ui.routes.expanded.has(sig)) ui.routes.expanded.delete(sig);
      else ui.routes.expanded.add(sig);
      applyRouteFilters();
    });
  });
}

function routeDetailHTML(row, session) {
  const b = row.optimalityBreakdown || {};
  const factor = (label, value) => `
    <div class="factor">
      <div class="factor-bar"><div class="factor-bar-fill" style="width:${value}%"></div></div>
      <div class="factor-label">${label}<span class="factor-val">${value}%</span></div>
    </div>
  `;
  const origin = (session?.origin || "https://www.airline-club.com");
  return `
    <tr class="route-detail">
      <td colspan="11">
        <div class="route-detail-inner">
          <div class="grid grid-2" style="gap:14px">
            <div>
              <div class="card-title">Optimality breakdown — ${row.optimality}%</div>
              ${factor("Profit",       b.profit       ?? 0)}
              ${factor("Load factor",  b.loadFactor   ?? 0)}
              ${factor("Headroom",     b.headroom     ?? 0)}
              ${factor("Competition",  b.competition  ?? 0)}
              ${factor("Fleet fit",    b.fleetFit     ?? 0)}
              ${factor("Distance",     b.distance     ?? 0)}
              ${factor("Runway",       b.runway       ?? 0)}
            </div>
            <div>
              <div class="card-title">Numbers</div>
              <div class="kv">
                <span>Distance</span><b>${row.distance} km</b>
                <span>Flight time</span><b>${Math.round((row.flightMinutes || 0) / 2)} min one-way</b>
                <span>Demand / week</span><b>${fmtNumber(row.demandSeats)} seats</b>
                <span>Competitors</span><b>${row.rivalCount} · ${fmtNumber(row.competitionCap)} cap</b>
                <span>Free demand</span><b>${fmtNumber(row.freeDemand)} seats</b>
                <span>Aircraft</span><b>${escape(row.suggestedModel.name)} (${row.suggestedModel.range} km)</b>
                <span>Max freq / plane</span><b>${row.maxFrequency}×/wk</b>
                <span>Planes needed</span><b>${row.planesNeeded}</b>
                <span>Ticket price</span><b>${fmtMoney(row.myPrice)} (economy)</b>
                <span>Revenue / wk</span><b class="stat-good">${fmtMoney(row.revenue)}</b>
                <span>Op cost / wk</span><b class="stat-bad">${fmtMoney(row.weeklyOpCost)}</b>
                <span>Profit / wk</span><b class="${row.profitPerWeek > 0 ? "stat-good" : "stat-bad"}">${fmtMoney(row.profitPerWeek)}</b>
              </div>
              <div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
                <a class="chip chip-accent" target="_blank" rel="noopener" href="${escape(origin)}/">Open game ${icon("external")}</a>
                <button class="ghost" data-copy="${escape(row.fromAirport.iata)} → ${escape(row.toAirport.iata)}">Copy IATA pair</button>
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderInsights() {
  const panel = $('[data-panel="insights"]');
  const insights = state.data?.snapshots?.insights;
  const suggestions = insights?.suggestions || [];
  const checklist = insights?.dailyChecklist || [];
  const profit = state.data?.snapshots?.profit;

  // Group suggestions by kind family for filtering.
  const filters = [
    { id: "all", label: "All", match: () => true },
    { id: "operate", label: "Run existing", match: (k) => ["raise_frequency", "lower_frequency", "re_equip_smaller", "re_equip_larger", "close_link"].includes(k) },
    { id: "pricing", label: "Pricing", match: (k) => k.startsWith("pricing_") || k.startsWith("class_mix_") },
    { id: "quality", label: "Quality", match: (k) => k === "quality_low" || k === "short_haul_underflown" || k === "long_haul_overflown" },
    { id: "rivals", label: "Rivals", match: (k) => k.startsWith("rival_") },
    { id: "growth", label: "Growth", match: (k) => k === "open_route" || k === "buy_to_open_route" || k === "buy_used_deal" },
    { id: "fleet", label: "Fleet", match: (k) => k === "aging_fleet" || k === "low_condition_plane" || k === "re_equip_smaller" || k === "re_equip_larger" },
    { id: "finance", label: "Finance", match: (k) => k === "contract_oil" || k === "oil_warn_high" || k === "loan_take" || k === "cash_idle" || k === "cash_low" || k === "rep_low" },
    { id: "urgent", label: "Urgent", match: (k) => k === "cycle_end_soon" || k === "cash_low" },
  ];
  if (!ui.insights.filter) ui.insights.filter = "all";
  const active = filters.find((f) => f.id === ui.insights.filter) || filters[0];
  const filtered = suggestions.filter((s) => active.match(s.kind));

  const sig = `${insights?.generatedAt || 0}|${suggestions.length}|${ui.insights.filter}`;
  if (ui.insights.lastSig === sig && panel.dataset.mounted === "1") return;
  ui.insights.lastSig = sig;
  panel.dataset.mounted = "1";

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Insights</h2>
        <div class="desc">Game-mechanics-aware suggestions across operations, pricing, fleet, rivals & finance.</div>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Suggestions</div>
        <div class="card-value">${suggestions.length}</div>
        <div class="card-sub">${insights?.generatedAt ? new Date(insights.generatedAt).toLocaleString() : "—"}</div>
      </div>
      <div class="card"><div class="card-title">Profit / week</div>
        <div class="card-value ${profit && profit.totals?.profit < 0 ? "stat-bad" : "stat-good"}">${fmtMoney(profit?.totals?.profit)}</div>
        <div class="card-sub">${profit ? `LF ${fmtPercent((profit.totals.soldSeats || 0) / (profit.totals.capacity || 1))}` : ""}</div>
      </div>
      <div class="card"><div class="card-title">Best link</div>
        <div class="card-value" style="font-size:14px;font-weight:500">${insights?.bestLink ? `${escape(insights.bestLink.from)} → ${escape(insights.bestLink.to)}` : "—"}</div>
        <div class="card-sub">${insights?.bestLink ? `LF ${fmtPercent(insights.bestLink.loadFactor)} · ${fmtMoney(insights.bestLink.profit)}/wk` : ""}</div>
      </div>
      <div class="card"><div class="card-title">Weakest link</div>
        <div class="card-value" style="font-size:14px;font-weight:500">${insights?.worstLink ? `${escape(insights.worstLink.from)} → ${escape(insights.worstLink.to)}` : "—"}</div>
        <div class="card-sub">${insights?.worstLink ? `LF ${fmtPercent(insights.worstLink.loadFactor)} · ${fmtMoney(insights.worstLink.profit)}/wk` : ""}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Daily checklist</div>
      ${
        checklist.length
          ? `<ol class="checklist">${checklist.map((c) => `<li><span class="chip ${insightChipClass(c.kind)}">${escape(insightLabel(c.kind))}</span> ${escape(c.title)}</li>`).join("")}</ol>`
          : `<div class="empty-state">Nothing urgent — keep cruising.</div>`
      }
    </div>

    <div class="filter-row" id="insightFilters">
      ${filters.map((f) => `<button class="filter-chip ${f.id === ui.insights.filter ? "active" : ""}" data-filter="${f.id}">${escape(f.label)}<span class="filter-count">${suggestions.filter((s) => f.match(s.kind)).length}</span></button>`).join("")}
    </div>

    ${
      filtered.length
        ? `<div class="flex-col" style="gap:10px">
            ${filtered.map((s) => `
              <div class="card insight-card">
                <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
                  <div style="min-width:0">
                    <div class="row" style="gap:6px;flex-wrap:wrap">
                      <span class="chip ${insightChipClass(s.kind)}">${escape(insightLabel(s.kind))}</span>
                      <span class="chip chip-info">P${s.priority || 1}</span>
                    </div>
                    <div style="font-weight:600;margin-top:4px">${escape(s.title)}</div>
                    <div class="card-sub" style="margin-top:2px">${escape(s.detail)}</div>
                  </div>
                  ${typeof s.impact === "number" ? `<div class="${s.impact >= 0 ? "stat-good" : "stat-bad"}" style="font-family:var(--mono);white-space:nowrap">${s.impact >= 0 ? "+" : ""}${fmtMoney(s.impact)}/wk</div>` : ""}
                </div>
              </div>
            `).join("")}
          </div>`
        : `<div class="empty-state">No suggestions in this category yet.</div>`
    }
  `;

  $$(".filter-chip", panel).forEach((btn) => btn.addEventListener("click", () => {
    ui.insights.filter = btn.dataset.filter;
    ui.insights.lastSig = null;
    panel.dataset.mounted = "0";
    renderInsights();
  }));

  panel.addEventListener("mouseenter", () => { ui.hoverPauseUntil = Date.now() + 60_000; }, { passive: true });
  panel.addEventListener("mouseleave", () => { ui.hoverPauseUntil = 0; }, { passive: true });
}

function insightLabel(kind) {
  return {
    raise_frequency: "Raise frequency",
    lower_frequency: "Lower frequency",
    close_link: "Close link",
    re_equip_smaller: "Smaller plane",
    re_equip_larger: "Larger plane",
    short_haul_underflown: "Add short-haul freq",
    long_haul_overflown: "Cut long-haul freq",
    quality_low: "Boost quality",
    class_mix_drop_first: "Drop first class",
    class_mix_drop_business: "Drop business",
    class_mix_add_premium: "Add premium cabin",
    pricing_test_premium: "Test +5% price",
    pricing_overpriced: "Overpriced",
    pricing_undercut: "Raise price",
    rival_exit: "Rival exited",
    rival_new_entry: "New competitor",
    rival_move: "Competitor move",
    open_route: "Open new route",
    buy_to_open_route: "Buy + open",
    buy_used_deal: "Used deal",
    aging_fleet: "Aging plane",
    low_condition_plane: "Low condition",
    contract_oil: "Lock oil contract",
    oil_warn_high: "Oil high",
    loan_take: "Cheap loans",
    cash_idle: "Idle cash",
    cash_low: "Low cash",
    rep_low: "Low reputation",
    cycle_end_soon: "Cycle ending",
    contract_renew: "Renew contract",
  }[kind] || kind;
}
function insightChipClass(kind) {
  if (["close_link", "cash_low", "low_condition_plane", "pricing_overpriced", "oil_warn_high", "rival_new_entry"].includes(kind)) return "chip-bad";
  if (["open_route", "buy_to_open_route", "raise_frequency", "contract_oil", "rival_exit", "short_haul_underflown", "pricing_undercut", "buy_used_deal"].includes(kind)) return "chip-good";
  if (["cycle_end_soon", "cash_idle"].includes(kind)) return "chip-info";
  return "chip-warn";
}

function renderOil() {
  const panel = $('[data-panel="oil"]');
  const oil = state.data?.snapshots?.oil;
  const contracts = state.data?.snapshots?.contracts?.contracts || [];
  const history = oil?.history || [];
  const prices = history.map((p) => p.price);

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Oil &amp; contracts</h2>
        <div class="desc">Rolling average + alert when |deviation| ≥ ${state.settings.oilDeviationPercent}%.</div>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card">
        <div class="card-title">Latest price</div>
        <div class="card-value">${oil?.latestPrice != null ? "$" + oil.latestPrice.toFixed(2) : "—"}</div>
        <div class="card-sub">cycle ${oil?.latestCycle ?? "—"}</div>
      </div>
      <div class="card">
        <div class="card-title">${state.settings.oilWindow}-cycle avg</div>
        <div class="card-value">${oil?.windowAvg != null ? "$" + oil.windowAvg.toFixed(2) : "—"}</div>
        <div class="card-sub">σ = ${oil?.windowStd != null ? "$" + oil.windowStd.toFixed(2) : "—"}</div>
      </div>
      <div class="card">
        <div class="card-title">Deviation</div>
        <div class="card-value ${oil ? (oil.deviationPct <= -4 ? "stat-good" : oil.deviationPct >= 4 ? "stat-bad" : "") : ""}">${oil?.deviationPct != null ? (oil.deviationPct >= 0 ? "+" : "") + oil.deviationPct.toFixed(1) + "%" : "—"}</div>
        <div class="card-sub">vs window avg</div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-title">Price history (last ${history.length} cycles)</div>
      <canvas class="spark" id="oilChart" style="height:120px"></canvas>
    </div>

    <div class="section-head" style="margin-top:16px"><h2 style="font-size:14px">Active oil contracts</h2></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>ID</th><th class="num">Price</th><th class="num">Volume</th><th class="num">Remaining</th><th class="num">Penalty</th><th></th></tr></thead>
        <tbody>
          ${
            contracts.length
              ? contracts.map((c) => `<tr>
                  <td>#${c.id}</td>
                  <td class="num">$${(c.price || 0).toFixed(2)}</td>
                  <td class="num">${fmtNumber(c.volume)}</td>
                  <td class="num ${c.remainingDuration <= 3 ? "stat-warn" : ""}">${c.remainingDuration}c</td>
                  <td class="num">${fmtMoney(c.terminationPenalty)}</td>
                  <td>${c.rejection ? `<span class="chip chip-bad">${escape(c.rejection)}</span>` : ""}</td>
                </tr>`).join("")
              : `<tr><td colspan="6"><div class="empty-state">No active contracts.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
  if (prices.length) drawSparkline($("#oilChart"), prices, { color: "#fbbf24", fill: "rgba(251, 191, 36, 0.15)" });
}

function priceTriplet(p) {
  if (p == null) return "—";
  if (typeof p === "number") return `$${p}`;
  const e = p.economy != null ? `$${p.economy}` : "—";
  const b = p.business != null ? `$${p.business}` : "—";
  const f = p.first != null ? `$${p.first}` : "—";
  return `<span class="price-triplet"><span title="Economy">${e}</span><span class="sep">/</span><span title="Business">${b}</span><span class="sep">/</span><span title="First">${f}</span></span>`;
}

function renderRivals() {
  const panel = $('[data-panel="rivals"]');
  const rivals = state.data?.snapshots?.rivals;
  const perLink = Object.values(rivals?.perLink || {});
  const events = rivals?.events || [];
  const sig = `${rivals?.updatedAt || 0}|${perLink.length}|${events.length}`;
  if (ui.rivals.lastSig === sig && panel.dataset.mounted === "1") return; // nothing changed
  ui.rivals.lastSig = sig;
  panel.dataset.mounted = "1";

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Rival radar</h2>
        <div class="desc">Per-link competitor snapshots. Prices shown as Economy/Business/First. Auto-refresh pauses while you hover this panel.</div>
      </div>
      <div class="row"><button class="ghost" id="refreshRivals">${icon("refresh")} Refresh</button></div>
    </div>

    <div class="card">
      <div class="card-title">Recent moves</div>
      ${
        events.length
          ? `<div class="flex-col" style="margin-top:6px">
              ${events.map((e) => `<div class="row" style="gap:8px"><span class="chip ${e.kind.includes("drop") ? "chip-bad" : e.kind.includes("exit") ? "chip-good" : "chip-warn"}">${e.kind.replace(/_/g, " ")}</span><div>${escape(e.text)}</div></div>`).join("")}
            </div>`
          : `<div class="empty-state">No competitive moves since last scan.</div>`
      }
    </div>

    <div class="section-head" style="margin-top:14px"><h2 style="font-size:14px">Per-link competitive snapshot</h2></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Link</th><th class="num">My price (Y/J/F)</th><th class="num">My cap</th><th class="num">My freq</th><th>Rivals</th><th class="num">Their cap</th></tr></thead>
        <tbody>
          ${
            perLink.length
              ? perLink.map((row) => `<tr>
                  <td><b>${escape(row.fromAirportName)} → ${escape(row.toAirportName)}</b></td>
                  <td class="num">${priceTriplet(row.myPrice)}</td>
                  <td class="num">${fmtNumber(totalSeats(row.myCapacity))}</td>
                  <td class="num">${fmtNumber(row.myFrequency)}</td>
                  <td>${
                    row.rivals.length
                      ? row.rivals.map((r) => `<span class="chip rival-chip" title="Y/J/F prices">${escape(r.airlineName)} <span class="rival-price">${priceTriplet(r.price)}</span></span>`).join(" ")
                      : `<span class="chip chip-good">none</span>`
                  }</td>
                  <td class="num">${fmtNumber(row.rivals.reduce((s, r) => s + totalSeats(r.capacity), 0))}</td>
                </tr>`).join("")
              : `<tr><td colspan="6"><div class="empty-state">Open the game with at least one active link, then click Refresh.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  // Pause auto-refresh while reading the table.
  panel.addEventListener("mouseenter", () => { ui.hoverPauseUntil = Date.now() + 60_000; }, { passive: true });
  panel.addEventListener("mouseleave", () => { ui.hoverPauseUntil = 0; }, { passive: true });

  $("#refreshRivals").addEventListener("click", async () => {
    await send({ type: "RUN_ALL_WATCHERS" });
    setTimeout(refreshData, 700);
  });
}

function renderFleet() {
  const panel = $('[data-panel="fleet"]');
  const fleet = state.data?.snapshots?.fleet;
  const usedSnap = state.data?.snapshots?.usedAircraft;
  const list = fleet?.list || [];
  const low = fleet?.lowCondition || [];
  const deals = usedSnap?.deals || [];

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Fleet</h2>
        <div class="desc">Fleet condition + sniper for used aircraft matching your preferred models.</div>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card"><div class="card-title">Aircraft owned</div><div class="card-value">${list.length}</div></div>
      <div class="card"><div class="card-title">Low-condition</div><div class="card-value ${low.length ? "stat-bad" : ""}">${low.length}</div><div class="card-sub">condition &lt; 35%</div></div>
      <div class="card"><div class="card-title">Used deals</div><div class="card-value ${deals.length ? "stat-good" : ""}">${deals.length}</div><div class="card-sub">Match preferred filter</div></div>
    </div>

    <div class="section-head" style="margin-top:14px"><h2 style="font-size:14px">Worst-condition airplanes</h2></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Model</th><th>Home</th><th class="num">Condition</th><th class="num">Age (wks)</th><th class="num">Value</th></tr></thead>
        <tbody>
          ${
            list.length
              ? list.slice(0, 25).map((p) => `<tr>
                  <td>${escape(p.modelName || "?")}<div class="small">#${p.id}</div></td>
                  <td>${escape(p.homeAirportName || "—")}</td>
                  <td class="num ${p.condition < 35 ? "stat-bad" : p.condition < 60 ? "stat-warn" : "stat-good"}">${p.condition ?? "—"}%</td>
                  <td class="num">${p.ageWeeks ?? "—"}</td>
                  <td class="num">${fmtMoney(p.value)}</td>
                </tr>`).join("")
              : `<tr><td colspan="5"><div class="empty-state">Open the game to sync your fleet.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>

    <div class="section-head" style="margin-top:14px"><h2 style="font-size:14px">Used aircraft sniper</h2></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Model</th><th class="num">Condition</th><th class="num">Price</th><th class="num">Discount</th></tr></thead>
        <tbody>
          ${
            deals.length
              ? deals.slice(0, 25).map((d) => `<tr>
                  <td>${escape(d.modelName)}</td>
                  <td class="num ${d.condition >= 90 ? "stat-good" : ""}">${d.condition}%</td>
                  <td class="num">${fmtMoney(d.price)}</td>
                  <td class="num ${d.discountPct >= 30 ? "stat-good" : ""}">${d.discountPct.toFixed(0)}%</td>
                </tr>`).join("")
              : `<tr><td colspan="4"><div class="empty-state">Add preferred model IDs in Settings so the sniper has something to watch.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderLoans() {
  const panel = $('[data-panel="loans"]');
  const loans = state.data?.snapshots?.loans;
  const rates = loans?.rates || [];

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Loans &amp; rates</h2>
        <div class="desc">Current bank rates. Alert when the benchmark drops by ≥ ${state.settings.loanRateDropAlertBps} bps.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Benchmark</div>
      <div class="card-value">${loans?.benchmarkRate != null ? (loans.benchmarkRate * 100).toFixed(2) + "%" : "—"}</div>
      <div class="card-sub">${loans?.benchmarkTerm ? `${loans.benchmarkTerm}w term` : ""}</div>
    </div>

    <div class="section-head" style="margin-top:14px"><h2 style="font-size:14px">All terms</h2></div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Term (weeks)</th><th class="num">Rate</th></tr></thead>
        <tbody>
          ${
            rates.length
              ? rates.map((r) => `<tr><td>${r.term ?? "—"}</td><td class="num">${((r.interestRate ?? r.rate ?? 0) * 100).toFixed(2)}%</td></tr>`).join("")
              : `<tr><td colspan="2"><div class="empty-state">Waiting for poll.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderAlerts() {
  const panel = $('[data-panel="alerts"]');
  const alerts = state.data?.snapshots?.alerts?.alerts || [];

  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Alerts</h2>
        <div class="desc">Feed from <code>/airlines/:id/alerts</code> with notifications on new entries.</div>
      </div>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Category</th><th>Message</th><th class="num">Cycle Δ</th></tr></thead>
        <tbody>
          ${
            alerts.length
              ? alerts.map((a) => `<tr>
                  <td>${escape(a.categoryText || "—")}</td>
                  <td style="white-space:normal">${escape(a.message || "")}</td>
                  <td class="num ${a.cycleDelta <= 1 ? "stat-warn" : ""}">${a.cycleDelta ?? 0}</td>
                </tr>`).join("")
              : `<tr><td colspan="3"><div class="empty-state">No alerts. That's a good thing.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderSettings() {
  const panel = $('[data-panel="settings"]');
  const s = state.settings;
  panel.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Settings</h2>
        <div class="desc">Notification thresholds, host selection, preferred models for the sniper.</div>
      </div>
      <div class="row">
        <button class="ghost" id="settingsReset">Reset</button>
        <button class="primary" id="settingsSave">Save</button>
      </div>
    </div>

    <div class="card">
      <div class="settings-row">
        <div>
          <label for="setHost">Host</label>
          <div class="desc">Which server to talk to.</div>
        </div>
        <select id="setHost">
          <option value="auto" ${s.host === "auto" ? "selected" : ""}>Auto (last seen)</option>
          <option value="https://www.airline-club.com" ${s.host === "https://www.airline-club.com" ? "selected" : ""}>v1 — www.airline-club.com</option>
          <option value="https://v2.airline-club.com" ${s.host === "https://v2.airline-club.com" ? "selected" : ""}>v2 — v2.airline-club.com</option>
        </select>
      </div>
      <div class="settings-row">
        <div><label for="setAid">Manual airline ID</label><div class="desc">-1 means use the active session.</div></div>
        <input type="number" id="setAid" value="${s.manualAirlineId}" />
      </div>
      <div class="settings-row">
        <div><label for="setPoll">Heavy poll interval (min)</label><div class="desc">≥ 5 recommended.</div></div>
        <input type="number" id="setPoll" value="${s.pollIntervalMinutes}" min="5" max="60" />
      </div>
      <div class="settings-row">
        <div><label for="setAutoRoutes"><input type="checkbox" id="setAutoRoutes" ${s.routeFinderAutoRun ? "checked" : ""}/> Auto-run route finder</label><div class="desc">Cooldown (min):</div></div>
        <input type="number" id="setRouteCD" value="${s.routeFinderCooldownMinutes}" min="15" max="600" />
      </div>
      <div class="settings-row">
        <div><label for="setOilWin">Oil window (cycles)</label></div>
        <input type="number" id="setOilWin" value="${s.oilWindow}" min="3" max="30" />
      </div>
      <div class="settings-row">
        <div><label for="setOilPct">Oil deviation %</label></div>
        <input type="number" id="setOilPct" value="${s.oilDeviationPercent}" min="2" max="40" />
      </div>
      <div class="settings-row">
        <div><label for="setLoanBps">Loan rate drop bps</label></div>
        <input type="number" id="setLoanBps" value="${s.loanRateDropAlertBps}" min="5" max="200" />
      </div>
      <div class="settings-row">
        <div><label for="setUsedCond">Used aircraft min condition %</label></div>
        <input type="number" id="setUsedCond" value="${s.usedAircraftMinCondition}" min="0" max="100" />
      </div>
      <div class="settings-row">
        <div><label for="setUsedDisc">Used aircraft min discount %</label></div>
        <input type="number" id="setUsedDisc" value="${s.usedAircraftMaxPriceDiscount}" min="0" max="80" />
      </div>
      <div class="settings-row">
        <div><label for="setPref">Preferred model IDs</label><div class="desc">CSV (e.g. <code>5,12,42</code>). Empty = use preferred-suppliers from the game.</div></div>
        <input type="text" id="setPref" value="${(s.preferredModels || []).join(",")}" style="width:160px;font-family:var(--mono)" />
      </div>
      <div class="settings-row">
        <div><label for="setRPS">Route finder max req/sec</label></div>
        <input type="number" id="setRPS" value="${s.routeMaxRequestsPerSecond}" min="1" max="10" />
      </div>
      <div class="settings-row">
        <div><label for="setRouteDest">Route finder destinations per base</label><div class="desc">Up to 500 — bigger = more thorough but slower.</div></div>
        <input type="number" id="setRouteDest" value="${s.routeMaxDestinations}" min="20" max="500" />
      </div>
      <div class="settings-row">
        <div><label for="setMinDemand">Min weekly demand (seats)</label></div>
        <input type="number" id="setMinDemand" value="${s.routeMinDemand}" min="0" max="5000" />
      </div>
      <div class="settings-row">
        <div><label><input type="checkbox" id="setDom" ${s.routeIncludeDomestic ? "checked" : ""}/> Domestic</label></div>
        <label><input type="checkbox" id="setIntl" ${s.routeIncludeInternational ? "checked" : ""}/> International</label>
      </div>
      <div class="settings-row">
        <div><label><input type="checkbox" id="setInterc" ${s.routeIncludeIntercontinental ? "checked" : ""}/> Intercontinental</label></div>
        <label><input type="checkbox" id="setNotif" ${s.notificationsEnabled ? "checked" : ""}/> Notifications enabled</label>
      </div>
      <div class="settings-row">
        <div><label><input type="checkbox" id="setWidget" ${s.widgetEnabled ? "checked" : ""}/> Floating widget on airline-club.com</label></div>
        <label><input type="checkbox" id="setBadge" ${s.linkBadgeEnabled ? "checked" : ""}/> Optimality badge on plan-link page</label>
      </div>
    </div>
  `;

  $("#settingsSave").addEventListener("click", async () => {
    const partial = {
      host: $("#setHost").value,
      manualAirlineId: Number($("#setAid").value),
      pollIntervalMinutes: Number($("#setPoll").value),
      routeFinderAutoRun: $("#setAutoRoutes").checked,
      routeFinderCooldownMinutes: Number($("#setRouteCD").value),
      oilWindow: Number($("#setOilWin").value),
      oilDeviationPercent: Number($("#setOilPct").value),
      loanRateDropAlertBps: Number($("#setLoanBps").value),
      usedAircraftMinCondition: Number($("#setUsedCond").value),
      usedAircraftMaxPriceDiscount: Number($("#setUsedDisc").value),
      preferredModels: ($("#setPref").value || "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0),
      routeMaxRequestsPerSecond: Number($("#setRPS").value),
      routeMaxDestinations: Number($("#setRouteDest").value),
      routeMinDemand: Number($("#setMinDemand").value),
      routeIncludeDomestic: $("#setDom").checked,
      routeIncludeInternational: $("#setIntl").checked,
      routeIncludeIntercontinental: $("#setInterc").checked,
      notificationsEnabled: $("#setNotif").checked,
      widgetEnabled: $("#setWidget").checked,
      linkBadgeEnabled: $("#setBadge").checked,
    };
    await send({ type: "SAVE_SETTINGS", partial });
    await refreshData();
  });
  $("#settingsReset").addEventListener("click", async () => {
    await send({ type: "RESET_SETTINGS" });
    await refreshData();
  });
}

// ---------------- CSV export ----------------
function exportRoutesCSV(r) {
  if (!r || !r.top) return;
  const headers = ["optimality", "from_iata", "from_city", "to_iata", "to_city", "distance_km", "demand", "free_demand", "rivals", "model", "owned", "freq", "planes", "load_factor", "profit_per_week", "score"];
  const rows = r.top.map((row) => [
    row.optimality,
    row.fromAirport.iata,
    row.fromAirport.city,
    row.toAirport.iata,
    row.toAirport.city,
    row.distance,
    row.demandSeats,
    row.freeDemand,
    row.rivalCount,
    row.suggestedModel.name,
    row.suggestedModel.ownedCount,
    row.maxFrequency,
    row.planesNeeded,
    row.loadFactor.toFixed(3),
    row.profitPerWeek,
    row.score,
  ]);
  const csv = [headers, ...rows].map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `airline-routes-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ---------------- Wire up ----------------
function renderActive(forceMount = false) {
  if (activeTab === "overview") renderOverview();
  if (activeTab === "routes") renderRoutes(forceMount);
  if (activeTab === "insights") renderInsights();
  if (activeTab === "oil") renderOil();
  if (activeTab === "rivals") renderRivals();
  if (activeTab === "fleet") renderFleet();
  if (activeTab === "loans") renderLoans();
  if (activeTab === "alerts") renderAlerts();
  if (activeTab === "settings") renderSettings();
}

async function refreshData() {
  // If the user is hovering a panel where auto-refresh is disruptive, skip
  // this tick — they can still trigger an explicit refresh via the button.
  if (Date.now() < ui.hoverPauseUntil) return;
  const [dash, settings] = await Promise.all([
    send({ type: "GET_DASHBOARD" }),
    send({ type: "GET_SETTINGS" }),
  ]);
  state.data = dash?.data || null;
  state.settings = settings?.settings || null;
  state.defaults = settings?.defaults || null;
  renderTopBar();
  setBadges();
  renderActive();
}

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
});

$("#refreshAll").addEventListener("click", async () => {
  await send({ type: "RUN_ALL_WATCHERS" });
  setTimeout(refreshData, 800);
});

setActiveTab("overview");
refreshData();
// Light auto-refresh while popup is open. 20s cadence so you can actually
// read tables without them jumping under your cursor.

setInterval(refreshData, 20000);
