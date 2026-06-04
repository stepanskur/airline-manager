// settings.js — user-facing settings with defaults.

import { getKey, setKey } from "./storage.js";

const KEY = "settings";

export const DEFAULTS = {
  // Host the extension talks to. "auto" picks last seen origin from page probe.
  host: "auto", // "auto" | "https://www.airline-club.com" | "https://v2.airline-club.com"

  // Manual override for airline ID. -1 means use last seen probe.
  manualAirlineId: -1,

  // Polling
  pollIntervalMinutes: 5, // chrome.alarms minimum is 1 minute; we use 5 to be polite.
  routeFinderCooldownMinutes: 120, // run automatically at most this often
  routeFinderAutoRun: true,

  // Oil watcher
  oilWindow: 10, // cycles to average
  oilDeviationPercent: 8, // alert when |delta| >= this % vs window average
  oilContractMinDuration: 26,

  // Loan watcher
  loanRateDropAlertBps: 25, // 0.25% drop triggers alert

  // Used aircraft sniper
  preferredModels: [], // list of model IDs
  usedAircraftMinCondition: 80, // 0..100
  usedAircraftMaxPriceDiscount: 30, // alert when price <= NEW * (1 - this/100)

  // Rival radar
  rivalPriceDropAlertPercent: 12,
  rivalCapacityDropAlertPercent: 25,

  // Route finder
  routeMaxDestinations: 500, // per base — scan everything reachable
  routeMinDemand: 50, // weekly seats min
  routeMaxRequestsPerSecond: 5,
  routeIncludeDomestic: true,
  routeIncludeInternational: true,
  routeIncludeIntercontinental: true,

  // Notifications master switch
  notificationsEnabled: true,

  // In-page UI
  widgetEnabled: true,
  linkBadgeEnabled: true,

  // Demo mode (use mock data when no airline detected)
  demoMode: false,
};

export async function loadSettings() {
  const stored = (await getKey(KEY, {})) || {};
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(partial) {
  const current = await loadSettings();
  const merged = { ...current, ...partial };
  await setKey(KEY, merged);
  return merged;
}

export async function resetSettings() {
  await setKey(KEY, {});
  return loadSettings();
}
