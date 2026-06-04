// oil.js — watches /oil-prices and emits notifications on significant moves.

import { getOilPrices } from "../api.js";
import { getKey, setKey } from "../storage.js";
import { loadSettings } from "../settings.js";
import { avg, stdev } from "../util.js";
import { notify } from "../notifier.js";

const KEY = "oilSnapshot";

export async function runOilWatcher() {
  const prices = await getOilPrices();
  if (!Array.isArray(prices) || prices.length === 0) return null;
  // sort by cycle ascending
  const sorted = prices.slice().sort((a, b) => a.cycle - b.cycle);
  const latest = sorted[sorted.length - 1];

  const settings = await loadSettings();
  const window = sorted.slice(-Math.max(2, settings.oilWindow));
  const windowAvg = avg(window.map((p) => p.price));
  const windowStd = stdev(window.map((p) => p.price));
  const deviation = windowAvg ? (latest.price - windowAvg) / windowAvg : 0;

  const result = {
    latestCycle: latest.cycle,
    latestPrice: latest.price,
    windowAvg,
    windowStd,
    deviationPct: deviation * 100,
    history: sorted,
    updatedAt: Date.now(),
  };

  const prev = await getKey(KEY, null);
  await setKey(KEY, result);

  // Notify on first crossing of threshold, only when latest cycle changed.
  const threshold = settings.oilDeviationPercent / 100;
  const crossed =
    !prev ||
    prev.latestCycle !== latest.cycle ||
    Math.sign(prev.deviationPct || 0) !== Math.sign(result.deviationPct);
  if (crossed) {
    if (deviation <= -threshold) {
      await notify(
        "Oil price dropped",
        `$${latest.price.toFixed(2)}/bbl — ${Math.abs(result.deviationPct).toFixed(1)}% below the ${window.length}-cycle average. Good moment to lock a long contract.`,
        "Oil watcher",
      );
    } else if (deviation >= threshold) {
      await notify(
        "Oil price spiked",
        `$${latest.price.toFixed(2)}/bbl — ${result.deviationPct.toFixed(1)}% above the ${window.length}-cycle average. Any cheap existing contracts are worth keeping.`,
        "Oil watcher",
      );
    }
  }
  return result;
}
