// service-worker.js — entry point for the extension.
//
// Responsibilities:
//   - Maintain the active airline session (via probe messages from content scripts).
//   - Schedule periodic polling jobs via chrome.alarms.
//   - Handle messages from popup / options UI.
//   - Auto-run the route finder on a cooldown.

import { updateFromProbe, getSession, resolveAirlineId } from "./state.js";
import { loadSettings, saveSettings, resetSettings, DEFAULTS } from "./settings.js";
import { getKey, getAll, setKey } from "./storage.js";
import { runOilWatcher } from "./watchers/oil.js";
import { runAlertWatcher } from "./watchers/alerts.js";
import { runLoanWatcher } from "./watchers/loans.js";
import { runUsedAircraftWatcher } from "./watchers/usedAircraft.js";
import { runRivalRadar } from "./watchers/rivals.js";
import { runContractWatcher } from "./watchers/contracts.js";
import { runCycleTracker } from "./cycle.js";
import { runProfitDashboard } from "./profitDashboard.js";
import { runFleetRenewal } from "./fleetRenewal.js";
import { runRouteFinder, getStatus as routeStatus, getResult as routeResult, scoreSingleRoute } from "./routeFinder.js";
import { runInsights } from "./insights.js";

const ALARM_TICK = "co-pilot-tick";
const ALARM_HEAVY = "co-pilot-heavy";

async function setupAlarms() {
  // light tick: cycle + oil + loans every minute (cycle), but heavy work delayed
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  // heavy tick: route finder, used aircraft, profit dashboard, fleet, rivals.
  const settings = await loadSettings();
  chrome.alarms.create(ALARM_HEAVY, { periodInMinutes: Math.max(5, settings.pollIntervalMinutes) });
}

async function lightTick() {
  await safe("cycle", runCycleTracker);
  await safe("oil", runOilWatcher);
  await safe("loans", runLoanWatcher);
}

async function heavyTick() {
  await safe("alerts", runAlertWatcher);
  await safe("contracts", runContractWatcher);
  await safe("profit", runProfitDashboard);
  await safe("fleet", () => runFleetRenewal({ currentCycle: (getCachedCycle()) }));
  await safe("usedAircraft", runUsedAircraftWatcher);
  await safe("rivals", runRivalRadar);
  // auto route finder
  const settings = await loadSettings();
  if (settings.routeFinderAutoRun) {
    const status = await routeStatus();
    const lastRun = (await routeResult())?.generatedAt || 0;
    const cooldownMs = settings.routeFinderCooldownMinutes * 60 * 1000;
    if (!status.running && Date.now() - lastRun >= cooldownMs) {
      await safe("routeFinder", () => runRouteFinder({ source: "auto" }));
    }
  }
  // Insights run after everything else so they see fresh data.
  await safe("insights", runInsights);
}

let cachedCycle = null;
function getCachedCycle() { return cachedCycle; }

async function safe(label, fn) {
  try {
    const out = await fn();
    if (label === "cycle" && out?.cycle) cachedCycle = out.cycle;
    return out;
  } catch (e) {
    console.warn(`[AirlineClub Co-Pilot] ${label} failed:`, e);
    return null;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
});
chrome.runtime.onStartup.addListener(async () => {
  await setupAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) await lightTick();
  else if (alarm.name === ALARM_HEAVY) await heavyTick();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "PROBE": {
          await updateFromProbe(msg);
          sendResponse({ ok: true });
          break;
        }
        case "GET_DASHBOARD": {
          const data = await collectDashboard();
          sendResponse({ ok: true, data });
          break;
        }
        case "GET_SETTINGS": {
          sendResponse({ ok: true, settings: await loadSettings(), defaults: DEFAULTS });
          break;
        }
        case "SAVE_SETTINGS": {
          const s = await saveSettings(msg.partial || {});
          await setupAlarms();
          sendResponse({ ok: true, settings: s });
          break;
        }
        case "RESET_SETTINGS": {
          const s = await resetSettings();
          await setupAlarms();
          sendResponse({ ok: true, settings: s });
          break;
        }
        case "RUN_ROUTE_FINDER": {
          // Don't await fully; run in background.
          runRouteFinder({ source: "manual" }).catch(() => {});
          sendResponse({ ok: true, started: true });
          break;
        }
        case "RUN_ALL_WATCHERS": {
          lightTick().catch(() => {});
          heavyTick().catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "GET_ROUTE_STATUS": {
          sendResponse({ ok: true, status: await routeStatus(), result: await routeResult() });
          break;
        }
        case "SCORE_ROUTE": {
          const result = await scoreSingleRoute({ fromIata: msg.fromIata, toIata: msg.toIata, modelId: msg.modelId });
          sendResponse({ ok: true, result });
          break;
        }
        case "OPEN_POPUP": {
          try { await chrome.action.openPopup(); } catch (e) { /* not always allowed */ }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
});

async function collectDashboard() {
  const [session, settings, all] = await Promise.all([
    getSession(),
    loadSettings(),
    getAll(),
  ]);
  return {
    session,
    settings,
    snapshots: {
      cycle: all.cycleSnapshot,
      oil: all.oilSnapshot,
      loans: all.loanRatesSnapshot,
      alerts: all.alertsSnapshot,
      contracts: all.contractsSnapshot,
      usedAircraft: all.usedAircraftSnapshot,
      rivals: all.rivalsSnapshot,
      profit: all.profitSnapshot,
      fleet: all.fleetSnapshot,
      routeFinder: all.routeFinderResult,
      routeFinderStatus: all.routeFinderStatus,
      insights: all.insightsSnapshot,
    },
  };
}

// Initial bootstrap if the SW just started.
setupAlarms().catch(() => {});
