// cycle.js — keeps an up-to-date view of the current game cycle, sets the
// extension badge with the remaining minutes until the next cycle, and emits a
// notification on each cycle rollover.

import { getCurrentCycle } from "./api.js";
import { getKey, setKey } from "./storage.js";
import { setBadgeText } from "./notifier.js";
import { notify } from "./notifier.js";

const KEY = "cycleSnapshot";

export async function runCycleTracker() {
  const data = await getCurrentCycle();
  // data shape: { cycle, fraction, cycleDurationEstimation }
  if (!data || typeof data.cycle !== "number") return null;
  const previous = await getKey(KEY, null);
  const remainingMs = Math.max(
    0,
    Math.round((1 - (data.fraction || 0)) * (data.cycleDurationEstimation || 0)),
  );
  const remainingMin = Math.round(remainingMs / 60000);
  setBadgeText(
    remainingMin > 0 && remainingMin < 100 ? String(remainingMin) : "",
    "#27272a",
  );

  if (previous && previous.cycle !== data.cycle) {
    await notify(
      "New game cycle",
      `Cycle ${data.cycle}. Check alerts and finances.`,
      "Cycle tracker",
    );
  }
  const snapshot = {
    cycle: data.cycle,
    fraction: data.fraction,
    durationMs: data.cycleDurationEstimation,
    remainingMs,
    updatedAt: Date.now(),
  };
  await setKey(KEY, snapshot);
  return snapshot;
}
