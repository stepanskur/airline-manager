// alerts.js — watches /airlines/:id/alerts and notifies on new entries.

import { getAirlineAlerts } from "../api.js";
import { resolveAirlineId } from "../state.js";
import { getKey, setKey } from "../storage.js";
import { notify } from "../notifier.js";

const KEY = "alertsSnapshot";

function fingerprint(alert) {
  // category + message + cycleDelta identify uniqueness
  return `${alert.category}|${alert.cycleDelta ?? 0}|${(alert.message || "").slice(0, 80)}`;
}

export async function runAlertWatcher() {
  const id = await resolveAirlineId();
  if (!id) return null;
  let alerts;
  try {
    alerts = await getAirlineAlerts(id);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return null;
    throw e;
  }
  if (!Array.isArray(alerts)) return null;
  const prev = (await getKey(KEY, { fingerprints: [] })) || { fingerprints: [] };
  const prevSet = new Set(prev.fingerprints || []);
  const fresh = [];
  const fingerprints = [];
  for (const a of alerts) {
    const fp = fingerprint(a);
    fingerprints.push(fp);
    if (!prevSet.has(fp)) fresh.push(a);
  }
  await setKey(KEY, {
    fingerprints,
    alerts: alerts.slice(0, 60),
    updatedAt: Date.now(),
  });
  // Notify up to 3 new alerts to avoid spam.
  for (const a of fresh.slice(0, 3)) {
    await notify(
      a.categoryText || "New alert",
      a.message || "",
      "Alert watcher",
    );
  }
  return { total: alerts.length, fresh: fresh.length };
}
