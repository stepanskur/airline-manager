// popup.js — orchestrates the popup UI, fully redesigned layout.

import { setIcons, icon } from "./icons.js";
import { drawSparkline } from "./sparkline.js";

setIcons();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = { data: null, settings: null, defaults: null };
let activeTab = "overview";

const ui = {
  routes: {
    onlyProfit: false,
    onlyUnder: false,
    onlyOwnedFleet: false,
    minOptimality: 0,
    minScore: 0,
    maxPlanes: 0,
    minRev: 0,
    query: "",
    expanded: new Set(),
    rendered: false,
    lastResultId: null,
  },
  rivals: { lastSig: null },
  insights: { lastSig: null, filter: "all" },
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
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
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
    $("#cycleNumber").textContent = `Cycle #${cycle.cycle}`;
    $("#cycleRemaining").textContent = `(${fmtCountdown(cycle.remainingMs)} rem)`;
    const fraction = Math.min(1, Math.max(0, cycle.fraction || 0));
    $("#cycleProgress").style.width = `${fraction * 100}%`;
  } else {
    $("#cycleNumber").textContent = "Cycle —";
    $("#cycleRemaining").textContent = "";
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

// ---------------- Panels ----------------

function renderOverview() {
  const panel = $('[data-panel="overview"]');
  const s = state.data?.snapshots || {};
  const oil = s.oil;
  const cycle = s.cycle;
  const profit = s.profit;
  const route = s.routeFinder;
  const insights = s.insights;

  const oilLatest = oil?.latestPrice ?? "—";
  const oilDelta = oil?.deviationPct;
  const oilClass = !oil ? "stat-muted" : oilDelta <= -4 ? "stat-good" : oilDelta >= 4 ? "stat-bad" : "stat-muted";

  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Command Dashboard</h2>
        <p class="page-desc">High-level telemetry for your airline.</p>
      </div>
      <div class="row">
        <button class="ghost" id="ovOpenGame">${icon("external")} Open Game</button>
      </div>
    </div>

    <div class="grid grid-auto" style="margin-bottom: 24px;">
      <div class="card" style="border-left: 3px solid var(--success)">
        <div class="card-title">Profit / week</div>
        <div class="card-value ${profit && profit.totals?.profit < 0 ? "stat-bad" : "stat-good"}">${fmtMoney(profit?.totals?.profit)}</div>
        <div class="card-sub">${profit ? `${fmtNumber(profit.totals.soldSeats)} seats sold · Avg LF ${fmtPercent((profit.totals.soldSeats || 0) / (profit.totals.capacity || 1))}` : "Awaiting sync..."}</div>
      </div>
      
      <div class="card" style="border-left: 3px solid var(--warning)">
        <div class="card-title">Fuel Price</div>
        <div class="card-value">${typeof oilLatest === "number" ? "$" + oilLatest.toFixed(2) : "—"}</div>
        <div class="card-sub ${oilClass}">${oil ? `${oilDelta >= 0 ? "+" : ""}${oilDelta.toFixed(1)}% vs ${state.settings.oilWindow}-cycle avg` : "Awaiting data..."}</div>
      </div>

      <div class="card" style="border-left: 3px solid #60a5fa">
        <div class="card-title">Cycle Duration</div>
        <div class="card-value">${fmtCountdown(cycle?.remainingMs)}</div>
        <div class="card-sub">${cycle?.durationMs ? `~${Math.round((cycle.durationMs || 0) / 60000)} min per cycle` : "Open game to sync"}</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Priority Insights</div>
        ${insights?.suggestions?.length 
          ? `<div class="flex-col" style="gap: 12px; margin-top: 12px;">
              ${insights.suggestions.slice(0, 4).map(s => `
                <div class="row" style="justify-content:space-between">
                  <div>
                    <div style="font-weight: 500;">${escape(s.title)}</div>
                    <div class="card-sub">${escape(s.detail)}</div>
                  </div>
                  ${s.impact ? `<div class="stat-good" style="font-family: var(--mono)">+${fmtMoney(s.impact)}</div>` : ''}
                </div>
              `).join('')}
             </div>`
          : `<div class="empty-state">No pressing insights right now.</div>`
        }
      </div>

      <div class="card">
        <div class="card-title">Top Route Opportunities</div>
        ${route?.top?.length
            ? `
              <div class="flex-col" style="gap:12px;margin-top:12px">
                ${route.top.slice(0, 4).map((r) => `
                  <div class="row" style="justify-content:space-between;align-items:center;">
                    <div style="min-width:0">
                      <div style="font-weight:600;">${escape(r.fromAirport.iata || "?")} → ${escape(r.toAirport.iata || "?")}</div>
                      <div class="card-sub">${escape(r.fromAirport.city || "")} → ${escape(r.toAirport.city || "")}</div>
                    </div>
                    <div style="text-align:right;">
                      <div class="opt-badge ${optimalityClass(r.optimality)}" style="margin-bottom: 4px;">${r.optimality}%</div>
                      <div class="${r.profitPerWeek > 0 ? "stat-good" : "stat-bad"}" style="font-family:var(--mono); font-size: 12px;">${fmtMoney(r.profitPerWeek)}/wk</div>
                    </div>
                  </div>
                `).join("")}
              </div>
            `
            : `<div class="empty-state">No route scan data. Run the scanner in the Routes tab.</div>`
        }
      </div>
    </div>
  `;

  $("#ovOpenGame").addEventListener("click", () => {
    chrome.tabs.create({ url: state.data?.session?.origin || "https://www.airline-club.com" });
  });
}

function routeSig(r) { return `${r.fromAirport.id}-${r.toAirport.id}`; }

function renderRoutes(forceMount = false) {
  const panel = $('[data-panel="routes"]');
  const r = state.data?.snapshots?.routeFinder;
  const status = state.data?.snapshots?.routeFinderStatus;
  const session = state.data?.session;
  const resultId = r?.generatedAt ?? null;

  const needsMount = forceMount || !ui.routes.rendered || ui.routes.lastResultId !== resultId;
  if (needsMount) {
    panel.innerHTML = `
      <div class="page-header">
        <div>
          <h2 class="page-title">Route Scanner</h2>
          <p class="page-desc">AI-powered discovery of highly profitable routes tailored to your fleet.</p>
        </div>
        <div class="row">
          <button class="ghost" id="rfExport">${icon("download")} Export CSV</button>
          <button class="primary" id="rfRun">${icon("search")} Run Scanner</button>
        </div>
      </div>

      <div class="grid grid-3" style="margin-bottom: 24px;">
        <div class="card" style="background: var(--bg-hover)">
          <div class="card-title">Scanner Status</div>
          <div class="card-value" style="font-size:16px;" id="rfStatus">Idle</div>
          <div class="card-sub" id="rfStatusSub"></div>
          <div class="progress hidden" id="rfProgressWrap" style="margin-top:8px"><div class="progress-fill" id="rfProgress"></div></div>
        </div>
        <div class="card">
          <div class="card-title">Network Analyzed</div>
          <div class="card-value" style="font-size:16px;" id="rfBases">—</div>
          <div class="card-sub" id="rfLastScanSub"></div>
        </div>
        <div class="card">
          <div class="card-title">Fleet Capabilities</div>
          <div class="card-value" style="font-size:16px;" id="rfFleet">—</div>
          <div class="card-sub" id="rfLastScan"></div>
        </div>
      </div>

      <div class="card" style="margin-bottom: 24px; padding: 12px 16px;">
        <div class="row-wrap" style="gap:12px;">
          <label class="toggle"><input type="checkbox" id="filterProfit" /> Profitable</label>
          <label class="toggle"><input type="checkbox" id="filterUnderserved" /> Underserved</label>
          <label class="toggle"><input type="checkbox" id="filterOwned" /> Owned Fleet Only</label>
          <div style="border-left: 1px solid var(--border); height: 24px; margin: 0 4px;"></div>
          <input id="filterMinOpt" type="number" placeholder="Min Opt %" min="0" max="100" style="width: 100px;" />
          <input id="filterMinScore" type="number" placeholder="Min profit" style="width: 100px;"/>
          <input id="filterIata" type="text" placeholder="Search City/IATA..." style="flex: 1;" />
          <span id="rfMatchCount" class="card-sub" style="margin-left:auto; font-weight: 500;"></span>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data" id="routesTable">
          <thead>
            <tr>
              <th>Match</th>
              <th>Route</th>
              <th class="num">Distance</th>
              <th class="num">Demand / Free</th>
              <th>Optimal Aircraft</th>
              <th class="num">Freq</th>
              <th class="num">LF</th>
              <th class="num">Est. Profit/Wk</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="routesBody"></tbody>
        </table>
      </div>
    `;
    ui.routes.rendered = true;
    ui.routes.lastResultId = resultId;

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
    // export is assumed to be generic or similar to existing
  }

  // Update status components
  $("#rfLastScan").textContent = r?.generatedAt ? new Date(r.generatedAt).toLocaleString() : "—";
  $("#rfLastScanSub").textContent = r ? `Scored ${r.scored} out of ${r.researched} routes` : "Awaiting scan";
  $("#rfBases").innerHTML = r?.bases?.length ? r.bases.map((b) => escape(b.iata || b.id)).join(", ") : "—";
  $("#rfFleet").textContent = r?.fleet?.length ? `${r.fleet.length} distinct models` : "—";

  const statusEl = $("#rfStatus");
  const statusSub = $("#rfStatusSub");
  const progressWrap = $("#rfProgressWrap");
  const progressBar = $("#rfProgress");
  if (status?.running) {
    statusEl.innerHTML = `<span style="color:var(--accent)">${escape(status.phase || "running")}…</span>`;
    statusSub.textContent = `${status.progress || 0} / ${status.total || 0}`;
    progressWrap.classList.remove("hidden");
    const pct = status.total ? (status.progress / status.total) * 100 : 5;
    progressBar.style.width = `${pct}%`;
  } else if (status?.error) {
    statusEl.innerHTML = `<span class="stat-bad">Error</span>`;
    statusSub.textContent = escape(status.error);
    progressWrap.classList.add("hidden");
  } else {
    statusEl.textContent = "Standby";
    statusSub.textContent = "Ready to scan network.";
    progressWrap.classList.add("hidden");
  }

  const list = r?.top || [];
  const q = ui.routes.query;
  const filtered = list.filter((row) => {
    if (ui.routes.onlyProfit && row.profitPerWeek <= 0) return false;
    if (ui.routes.onlyUnder && row.freeDemand <= 0) return false;
    if (ui.routes.onlyOwnedFleet && row.suggestedModel.fitNote !== "owned") return false;
    if ((row.optimality ?? 0) < ui.routes.minOptimality) return false;
    if ((row.profitPerWeek ?? 0) < ui.routes.minScore) return false;
    if (q) {
      const blob = `${row.fromAirport.iata} ${row.fromAirport.city} ${row.toAirport.iata} ${row.toAirport.city} ${row.fromAirport.country} ${row.toAirport.country}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  $("#rfMatchCount").textContent = `${filtered.length} matches`;

  const body = $("#routesBody");
  if (body) {
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="9"><div class="empty-state">No routes found matching current criteria.</div></td></tr>`;
    } else {
      body.innerHTML = filtered.map((row) => {
        const sig = routeSig(row);
        const expanded = ui.routes.expanded.has(sig);
        const fit = row.suggestedModel.fitNote === "owned" ? "" : `<span class="chip chip-warn">Buy</span>`;
        return `
          <tr class="route-row" data-sig="${escape(sig)}">
            <td><div class="opt-badge ${optimalityClass(row.optimality)}">${row.optimality}%</div></td>
            <td>
              <div style="font-weight: 600;">${escape(row.fromAirport.iata)} → ${escape(row.toAirport.iata)}</div>
              <div class="small">${escape(row.fromAirport.city)} → ${escape(row.toAirport.city)}</div>
            </td>
            <td class="num">${row.distance} km</td>
            <td class="num">
              <div>${fmtNumber(row.demandSeats)}</div>
              <div class="small ${row.freeDemand > 0 ? "stat-good" : "stat-muted"}">${fmtNumber(row.freeDemand)} free</div>
            </td>
            <td>
              <div>${escape(row.suggestedModel.name)} ${fit}</div>
              <div class="small">${row.suggestedModel.ownedCount} owned · ${row.planesNeeded} needed</div>
            </td>
            <td class="num">${row.maxFrequency}×</td>
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
          renderRoutes(false);
        });
      });
    }
  }

  // Filter bindings if newly mounted
  if (needsMount) {
    const bindFilter = (id, key, valFn) => {
      $("#" + id).addEventListener("input", () => {
        ui.routes[key] = valFn();
        renderRoutes(false);
      });
    };
    bindFilter("filterProfit", "onlyProfit", () => $("#filterProfit").checked);
    bindFilter("filterUnderserved", "onlyUnder", () => $("#filterUnderserved").checked);
    bindFilter("filterOwned", "onlyOwnedFleet", () => $("#filterOwned").checked);
    bindFilter("filterMinOpt", "minOptimality", () => Number($("#filterMinOpt").value) || 0);
    bindFilter("filterMinScore", "minScore", () => Number($("#filterMinScore").value) || 0);
    bindFilter("filterIata", "query", () => ($("#filterIata").value || "").trim().toLowerCase());
  }
}

function routeDetailHTML(row, session) {
  const b = row.optimalityBreakdown || {};
  const origin = (session?.origin || "https://www.airline-club.com");
  
  const factor = (label, value) => `
    <div class="factor">
      <div class="factor-bar"><div class="factor-bar-fill" style="width:${value}%"></div></div>
      <div class="factor-label">${label}<span class="factor-val">${value}%</span></div>
    </div>
  `;

  return `
    <tr class="route-detail">
      <td colspan="9" style="padding: 24px; background: #080808;">
        <div class="grid grid-3" style="gap: 24px;">
          <div>
            <h4 style="margin: 0 0 12px 0; font-size: 13px; color: var(--text-secondary);">Algorithm Breakdown</h4>
            ${factor("Profit Potential", b.profit ?? 0)}
            ${factor("Load Factor", b.loadFactor ?? 0)}
            ${factor("Market Headroom", b.headroom ?? 0)}
            ${factor("Competitive Edge", b.competition ?? 0)}
            ${factor("Fleet Suitability", b.fleetFit ?? 0)}
            ${factor("Distance Bonus", b.distance ?? 0)}
            ${factor("Runway Safety", b.runway ?? 0)}
          </div>
          <div>
            <h4 style="margin: 0 0 12px 0; font-size: 13px; color: var(--text-secondary);">Financial Projections (Per Week)</h4>
            <div class="kv" style="grid-template-columns: 1fr 1fr; row-gap: 8px;">
              <span>Ticket Price (Y)</span><b>$${row.priceByClass?.economy ?? 0}</b>
              <span>Weekly Revenue</span><b class="stat-good">${fmtMoney(row.revenue)}</b>
              <span>Fuel Cost</span><b class="stat-bad">${fmtMoney(row.opCostBreakdown?.fuel ? row.opCostBreakdown.fuel * row.maxFrequency : 0)}</b>
              <span>Crew Cost</span><b class="stat-bad">${fmtMoney(row.opCostBreakdown?.crew ? row.opCostBreakdown.crew * row.maxFrequency : 0)}</b>
              <span>Airport Fees</span><b class="stat-bad">${fmtMoney(row.opCostBreakdown?.airport ? row.opCostBreakdown.airport * row.maxFrequency : 0)}</b>
              <span>Total Op Cost</span><b class="stat-bad">${fmtMoney(row.weeklyOpCost)}</b>
              <div style="grid-column: 1 / -1; border-top: 1px solid var(--border); margin: 4px 0;"></div>
              <span style="color: var(--text-primary); font-weight: 500;">Net Profit</span>
              <b class="${row.profitPerWeek > 0 ? 'stat-good' : 'stat-bad'}" style="font-size: 14px;">${fmtMoney(row.profitPerWeek)}</b>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <h4 style="margin: 0 0 12px 0; font-size: 13px; color: var(--text-secondary);">Competition</h4>
              <div class="kv">
                <span>Rival Count</span><b>${row.rivalCount}</b>
                <span>Competitor Cap</span><b>${fmtNumber(row.competitionCap)}</b>
                <span>Flight Time</span><b>${Math.round((row.flightMinutes || 0) / 2)} min (1-way)</b>
                <span>Recommended Planes</span><b>${row.planesNeeded}x ${escape(row.suggestedModel.name)}</b>
              </div>
            </div>
            <div style="margin-top: 24px; display: flex; gap: 8px;">
              <a class="primary" style="text-decoration: none;" target="_blank" href="${escape(origin)}/">Open in Game ${icon("external")}</a>
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
  
  const sig = `${insights?.generatedAt || 0}|${suggestions.length}`;
  if (ui.insights.lastSig === sig && panel.dataset.mounted === "1") return;
  ui.insights.lastSig = sig;
  panel.dataset.mounted = "1";

  // Grouping suggestions by high-level category
  const groups = {
    "Pricing & Mix": suggestions.filter(s => s.kind.startsWith("pricing_") || s.kind.startsWith("class_mix_")),
    "Network Operations": suggestions.filter(s => ["raise_frequency", "lower_frequency", "close_link", "open_route", "short_haul_underflown", "long_haul_overflown"].includes(s.kind)),
    "Fleet Management": suggestions.filter(s => ["re_equip_smaller", "re_equip_larger", "buy_used_deal", "buy_to_open_route", "aging_fleet", "low_condition_plane"].includes(s.kind)),
    "Competitive & Financial": suggestions.filter(s => s.kind.startsWith("rival_") || ["contract_oil", "oil_warn_high", "loan_take", "cash_idle", "cash_low", "rep_low"].includes(s.kind))
  };

  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Smart Insights</h2>
        <p class="page-desc">Actionable intelligence to optimize pricing, fleet, and network operations.</p>
      </div>
    </div>

    ${checklist.length ? `
      <div class="card" style="margin-bottom: 24px; background: rgba(52, 211, 153, 0.05); border-color: rgba(52, 211, 153, 0.2);">
        <div class="card-title" style="color: var(--success);">Daily Checklist — Action Required</div>
        <ol class="checklist" style="margin-bottom: 0;">
          ${checklist.map((c) => `<li><b style="color:var(--text-primary)">${escape(insightLabel(c.kind))}</b>: ${escape(c.title)}</li>`).join("")}
        </ol>
      </div>
    ` : ''}

    <div class="grid grid-2" style="gap: 24px;">
      ${Object.entries(groups).map(([title, items]) => {
        if (!items.length) return '';
        return `
          <div>
            <h3 style="font-size: 14px; margin: 0 0 12px 0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">${title} <span class="chip" style="margin-left: 8px;">${items.length}</span></h3>
            <div class="flex-col" style="gap: 12px;">
              ${items.map(s => `
                <div class="card insight-card" style="padding: 12px;">
                  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                      <div style="font-weight: 500; font-size: 13px;">${escape(s.title)}</div>
                      <div class="card-sub" style="margin-top: 4px;">${escape(s.detail)}</div>
                    </div>
                    ${s.impact ? `<div class="chip ${s.impact >= 0 ? "chip-good" : "chip-bad"}" style="font-family:var(--mono); margin-left: 12px;">${s.impact >= 0 ? "+" : ""}${fmtMoney(s.impact)}</div>` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  panel.addEventListener("mouseenter", () => { ui.hoverPauseUntil = Date.now() + 60_000; }, { passive: true });
  panel.addEventListener("mouseleave", () => { ui.hoverPauseUntil = 0; }, { passive: true });
}

function insightLabel(kind) {
  const map = {
    raise_frequency: "Raise frequency", lower_frequency: "Lower frequency", close_link: "Close link",
    re_equip_smaller: "Smaller plane", re_equip_larger: "Larger plane",
    short_haul_underflown: "Add short-haul freq", long_haul_overflown: "Cut long-haul freq",
    quality_low: "Boost quality", class_mix_drop_first: "Drop first class",
    class_mix_drop_business: "Drop business", class_mix_add_premium: "Add premium cabin",
    pricing_test_premium: "Test +5% price", pricing_overpriced: "Overpriced", pricing_undercut: "Raise price",
    rival_exit: "Rival exited", rival_new_entry: "New competitor", rival_move: "Competitor move",
    open_route: "Open new route", buy_to_open_route: "Buy + open", buy_used_deal: "Used deal",
    aging_fleet: "Aging plane", low_condition_plane: "Low condition", contract_oil: "Lock oil contract",
    oil_warn_high: "Oil high", loan_take: "Cheap loans", cash_idle: "Idle cash", cash_low: "Low cash",
    rep_low: "Low reputation", cycle_end_soon: "Cycle ending", contract_renew: "Renew contract",
  };
  return map[kind] || kind;
}

function renderFleet() {
  const panel = $('[data-panel="fleet"]');
  const fleet = state.data?.snapshots?.fleet;
  const usedSnap = state.data?.snapshots?.usedAircraft;
  const list = fleet?.list || [];
  const low = fleet?.lowCondition || [];
  const deals = usedSnap?.deals || [];

  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Fleet & Used Aircraft</h2>
        <p class="page-desc">Monitor fleet health and snipe deeply discounted used aircraft.</p>
      </div>
    </div>

    <div class="grid grid-auto" style="margin-bottom: 24px;">
      <div class="card">
        <div class="card-title">Total Aircraft</div>
        <div class="card-value">${list.length}</div>
      </div>
      <div class="card" style="${low.length ? 'border-left: 3px solid var(--danger)' : ''}">
        <div class="card-title">Critical Condition (&lt;35%)</div>
        <div class="card-value ${low.length ? 'stat-bad' : ''}">${low.length}</div>
        <div class="card-sub">Requires immediate maintenance</div>
      </div>
      <div class="card" style="${deals.length ? 'border-left: 3px solid var(--success)' : ''}">
        <div class="card-title">Sniper Deals Found</div>
        <div class="card-value ${deals.length ? 'stat-good' : ''}">${deals.length}</div>
        <div class="card-sub">Matching preferred models</div>
      </div>
    </div>

    <div class="grid grid-2" style="gap: 24px;">
      <div>
        <h3 style="font-size: 14px; margin: 0 0 12px 0;">Used Aircraft Radar</h3>
        ${deals.length ? `
          <div class="flex-col" style="gap: 12px;">
            ${deals.slice(0, 10).map(d => `
              <div class="card" style="padding: 12px;">
                <div style="display: flex; justify-content: space-between;">
                  <strong style="font-size: 14px;">${escape(d.modelName)}</strong>
                  <span class="chip chip-good">${d.discountPct.toFixed(0)}% OFF</span>
                </div>
                <div class="kv" style="margin-top: 12px;">
                  <span>Price</span><b style="font-size: 14px;">${fmtMoney(d.price)}</b>
                  <span>Condition</span><b class="${d.condition >= 90 ? 'stat-good' : ''}">${d.condition}%</b>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty-state">No sniper deals found. Add models in Settings.</div>`}
      </div>

      <div>
        <h3 style="font-size: 14px; margin: 0 0 12px 0;">Maintenance Queue</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Model / ID</th><th>Home</th><th class="num">Cond %</th><th class="num">Age</th></tr></thead>
            <tbody>
              ${list.length ? list.slice(0, 15).map((p) => `
                <tr>
                  <td>${escape(p.modelName)}<div class="small">#${p.id}</div></td>
                  <td>${escape(p.homeAirportName || "—")}</td>
                  <td class="num ${p.condition < 35 ? "stat-bad" : p.condition < 60 ? "stat-warn" : "stat-good"}">${p.condition}%</td>
                  <td class="num">${p.ageWeeks}w</td>
                </tr>`).join("") : `<tr><td colspan="4" class="empty-state">No fleet data.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
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
  
  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Competitor Radar</h2>
        <p class="page-desc">Track competitor moves and per-link capacities.</p>
      </div>
      <div class="row"><button class="ghost" id="refreshRivals">${icon("refresh")} Refresh Radar</button></div>
    </div>

    ${events.length ? `
      <div class="card" style="margin-bottom: 24px; border-left: 3px solid var(--accent)">
        <div class="card-title">Recent Competitor Moves</div>
        <div class="flex-col" style="margin-top: 8px; gap: 8px;">
          ${events.map((e) => `
            <div class="row" style="gap:12px;">
              <span class="chip ${e.kind.includes("drop") ? "chip-bad" : e.kind.includes("exit") ? "chip-good" : "chip-warn"}" style="min-width: 100px; justify-content: center;">${e.kind.replace(/_/g, " ")}</span>
              <div style="font-size: 13px;">${escape(e.text)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ''}

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Route Link</th>
            <th class="num">My Price (Y/J/F)</th>
            <th class="num">My Seats</th>
            <th>Competitors Present</th>
            <th class="num">Comp. Seats</th>
          </tr>
        </thead>
        <tbody>
          ${perLink.length ? perLink.map((row) => `
            <tr>
              <td style="font-weight: 500;">${escape(row.fromAirportName)} → ${escape(row.toAirportName)}</td>
              <td class="num">${priceTriplet(row.myPrice)}</td>
              <td class="num" style="color: var(--success);">${fmtNumber(totalSeats(row.myCapacity))}</td>
              <td style="white-space: normal;">${
                row.rivals.length
                  ? row.rivals.map((r) => `<span class="chip rival-chip" style="margin: 2px;">${escape(r.airlineName)} <span class="rival-price">${priceTriplet(r.price)}</span></span>`).join("")
                  : `<span class="chip chip-good">Monopoly</span>`
              }</td>
              <td class="num" style="color: var(--danger);">${fmtNumber(row.rivals.reduce((s, r) => s + totalSeats(r.capacity), 0))}</td>
            </tr>
          `).join("") : `<tr><td colspan="5"><div class="empty-state">No rival data. Open active routes in game to sync.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  $("#refreshRivals")?.addEventListener("click", async () => {
    await send({ type: "RUN_ALL_WATCHERS" });
    setTimeout(refreshData, 700);
  });
}

function renderFinance() {
  const panel = $('[data-panel="finance"]');
  const oil = state.data?.snapshots?.oil;
  const contracts = state.data?.snapshots?.contracts?.contracts || [];
  const loans = state.data?.snapshots?.loans;
  const rates = loans?.rates || [];
  const history = oil?.history || [];
  const prices = history.map((p) => p.price);

  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Finance & Fuel</h2>
        <p class="page-desc">Track loan rates and oil market trends.</p>
      </div>
    </div>

    <div class="grid grid-2" style="gap: 24px; margin-bottom: 24px;">
      
      <div class="card" style="display: flex; flex-direction: column;">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">Fuel Market</h3>
        <div class="grid grid-2" style="margin-bottom: 16px;">
          <div>
            <div class="card-sub">Current Price</div>
            <div style="font-size: 24px; font-weight: 600; font-family: var(--mono);">${oil?.latestPrice != null ? "$" + oil.latestPrice.toFixed(2) : "—"}</div>
          </div>
          <div>
            <div class="card-sub">Trend vs ${state.settings.oilWindow}c Avg</div>
            <div style="font-size: 24px; font-weight: 600; font-family: var(--mono);" class="${oil ? (oil.deviationPct <= -4 ? "stat-good" : oil.deviationPct >= 4 ? "stat-bad" : "") : ""}">${oil?.deviationPct != null ? (oil.deviationPct >= 0 ? "+" : "") + oil.deviationPct.toFixed(1) + "%" : "—"}</div>
          </div>
        </div>
        <div style="flex: 1;">
          <canvas class="spark" id="oilChart" style="height: 100px; width: 100%;"></canvas>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">Banking & Rates</h3>
        <div style="margin-bottom: 16px;">
          <div class="card-sub">Current Benchmark Rate</div>
          <div style="font-size: 24px; font-weight: 600; font-family: var(--mono); color: var(--success);">${loans?.benchmarkRate != null ? (loans.benchmarkRate * 100).toFixed(2) + "%" : "—"}</div>
        </div>
        
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Term</th><th class="num">Interest Rate</th></tr></thead>
            <tbody>
              ${rates.length ? rates.slice(0, 5).map((r) => `<tr><td>${r.term} weeks</td><td class="num">${((r.interestRate ?? r.rate ?? 0) * 100).toFixed(2)}%</td></tr>`).join("") : `<tr><td colspan="2" class="empty-state">No rate data</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <h3 style="font-size: 14px; margin: 0 0 12px 0;">Active Fuel Contracts</h3>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Contract ID</th><th class="num">Price</th><th class="num">Volume</th><th class="num">Time Remaining</th><th class="num">Penalty</th></tr></thead>
        <tbody>
          ${contracts.length ? contracts.map((c) => `
            <tr>
              <td>#${c.id}</td>
              <td class="num">$${(c.price || 0).toFixed(2)}</td>
              <td class="num">${fmtNumber(c.volume)}</td>
              <td class="num ${c.remainingDuration <= 3 ? "stat-warn" : ""}">${c.remainingDuration} cycles</td>
              <td class="num">${fmtMoney(c.terminationPenalty)}</td>
            </tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No active fuel contracts.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  if (prices.length) setTimeout(() => drawSparkline($("#oilChart"), prices, { color: "#fbbf24", fill: "rgba(251, 191, 36, 0.15)" }), 0);
}

function renderAlerts() {
  const panel = $('[data-panel="alerts"]');
  const alerts = state.data?.snapshots?.alerts?.alerts || [];

  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">System Alerts</h2>
        <p class="page-desc">In-game notifications and important system messages.</p>
      </div>
    </div>
    
    <div class="flex-col" style="gap: 12px;">
      ${alerts.length ? alerts.map(a => `
        <div class="card" style="padding: 16px; border-left: 3px solid ${a.categoryText?.includes('Warning') ? 'var(--warning)' : 'var(--accent)'}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <div style="font-weight: 500; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px;">${escape(a.categoryText || "Alert")}</div>
              <div style="font-size: 14px;">${escape(a.message || "")}</div>
            </div>
            <span class="chip ${a.cycleDelta <= 1 ? "chip-warn" : ""}">${a.cycleDelta ?? 0} cycles ago</span>
          </div>
        </div>
      `).join("") : `<div class="empty-state" style="padding: 64px;">All clear. No active alerts.</div>`}
    </div>
  `;
}

function renderSettings() {
  const panel = $('[data-panel="settings"]');
  const s = state.settings;
  
  panel.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Configuration</h2>
        <p class="page-desc">Customize co-pilot behavior, thresholds, and algorithms.</p>
      </div>
      <div class="row">
        <button class="ghost" id="settingsReset">Reset Defaults</button>
        <button class="primary" id="settingsSave">Save Configuration</button>
      </div>
    </div>

    <div class="grid grid-2" style="gap: 24px;">
      <div class="card">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">System & Polling</h3>
        <div class="settings-row">
          <div><label>Server Host</label></div>
          <select id="setHost">
            <option value="auto" ${s.host === "auto" ? "selected" : ""}>Auto (Detect)</option>
            <option value="https://www.airline-club.com" ${s.host === "https://www.airline-club.com" ? "selected" : ""}>v1 (Classic)</option>
            <option value="https://v2.airline-club.com" ${s.host === "https://v2.airline-club.com" ? "selected" : ""}>v2 (Modern)</option>
          </select>
        </div>
        <div class="settings-row">
          <div><label>Poll Interval</label><div class="desc">Minutes between heavy syncs</div></div>
          <input type="number" id="setPoll" value="${s.pollIntervalMinutes}" min="5" max="60" />
        </div>
        <div class="settings-row" style="border-bottom: none;">
          <div><label><input type="checkbox" id="setNotif" ${s.notificationsEnabled ? "checked" : ""}/> Enable Notifications</label></div>
        </div>
        <div class="settings-row" style="border-bottom: none;">
          <div><label><input type="checkbox" id="setWidget" ${s.widgetEnabled ? "checked" : ""}/> Show In-Game Widget</label></div>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">Route Scanner Algorithm</h3>
        <div class="settings-row">
          <div><label>Max Destinations/Base</label></div>
          <input type="number" id="setRouteDest" value="${s.routeMaxDestinations}" min="20" max="500" />
        </div>
        <div class="settings-row">
          <div><label>Min Weekly Demand</label></div>
          <input type="number" id="setMinDemand" value="${s.routeMinDemand}" min="0" max="5000" />
        </div>
        <div class="settings-row" style="border-bottom: none; grid-template-columns: 1fr;">
          <div style="display: flex; gap: 16px;">
            <label><input type="checkbox" id="setDom" ${s.routeIncludeDomestic ? "checked" : ""}/> Domestic</label>
            <label><input type="checkbox" id="setIntl" ${s.routeIncludeInternational ? "checked" : ""}/> International</label>
            <label><input type="checkbox" id="setInterc" ${s.routeIncludeIntercontinental ? "checked" : ""}/> Intercontinental</label>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">Market Alerts</h3>
        <div class="settings-row">
          <div><label>Oil Window (Cycles)</label></div>
          <input type="number" id="setOilWin" value="${s.oilWindow}" min="3" max="30" />
        </div>
        <div class="settings-row">
          <div><label>Oil Dev Alert (%)</label></div>
          <input type="number" id="setOilPct" value="${s.oilDeviationPercent}" min="2" max="40" />
        </div>
        <div class="settings-row">
          <div><label>Loan Drop Alert (bps)</label></div>
          <input type="number" id="setLoanBps" value="${s.loanRateDropAlertBps}" min="5" max="200" />
        </div>
      </div>

      <div class="card">
        <h3 style="font-size: 14px; margin: 0 0 16px 0;">Fleet Sniper</h3>
        <div class="settings-row">
          <div><label>Min Condition (%)</label></div>
          <input type="number" id="setUsedCond" value="${s.usedAircraftMinCondition}" min="0" max="100" />
        </div>
        <div class="settings-row">
          <div><label>Min Discount (%)</label></div>
          <input type="number" id="setUsedDisc" value="${s.usedAircraftMaxPriceDiscount}" min="0" max="80" />
        </div>
        <div class="settings-row">
          <div><label>Preferred Models (CSV)</label><div class="desc">Leave blank for auto</div></div>
          <input type="text" id="setPref" value="${(s.preferredModels || []).join(",")}" style="width:160px;font-family:var(--mono)" />
        </div>
      </div>
    </div>
  `;

  $("#settingsSave").addEventListener("click", async () => {
    const partial = {
      host: $("#setHost").value,
      pollIntervalMinutes: Number($("#setPoll").value),
      oilWindow: Number($("#setOilWin").value),
      oilDeviationPercent: Number($("#setOilPct").value),
      loanRateDropAlertBps: Number($("#setLoanBps").value),
      usedAircraftMinCondition: Number($("#setUsedCond").value),
      usedAircraftMaxPriceDiscount: Number($("#setUsedDisc").value),
      preferredModels: ($("#setPref").value || "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0),
      routeMaxDestinations: Number($("#setRouteDest").value),
      routeMinDemand: Number($("#setMinDemand").value),
      routeIncludeDomestic: $("#setDom").checked,
      routeIncludeInternational: $("#setIntl").checked,
      routeIncludeIntercontinental: $("#setInterc").checked,
      notificationsEnabled: $("#setNotif").checked,
      widgetEnabled: $("#setWidget").checked,
    };
    await send({ type: "SAVE_SETTINGS", partial });
    await refreshData();
  });
  
  $("#settingsReset").addEventListener("click", async () => {
    await send({ type: "RESET_SETTINGS" });
    await refreshData();
  });
}

function renderActive(forceMount = false) {
  if (activeTab === "overview") renderOverview();
  if (activeTab === "routes") renderRoutes(forceMount);
  if (activeTab === "insights") renderInsights();
  if (activeTab === "finance") renderFinance();
  if (activeTab === "rivals") renderRivals();
  if (activeTab === "fleet") renderFleet();
  if (activeTab === "alerts") renderAlerts();
  if (activeTab === "settings") renderSettings();
}

async function refreshData() {
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

$("#refreshAll")?.addEventListener("click", async () => {
  await send({ type: "RUN_ALL_WATCHERS" });
  setTimeout(refreshData, 800);
});

setActiveTab("overview");
refreshData();
setInterval(refreshData, 20000);
