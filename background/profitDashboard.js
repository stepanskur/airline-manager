// profitDashboard.js — aggregates /airlines/:id/links-details into a digestible
// per-route profitability table for the popup.

import { getAirlineLinksDetails } from "./api.js";
import { resolveAirlineId } from "./state.js";
import { setKey } from "./storage.js";

const KEY = "profitSnapshot";

function safeSum(a) {
  return (a?.economy || 0) + (a?.business || 0) + (a?.first || 0);
}

function profitOf(item) {
  // Different fields depending on whether link is profitable; fall back to revenue-expense.
  if (typeof item.profit === "number") return item.profit;
  const rev = item.revenue ?? 0;
  const exp = item.expense ?? 0;
  return rev - exp;
}

export async function runProfitDashboard() {
  const id = await resolveAirlineId();
  if (!id) return null;
  let details;
  try {
    details = await getAirlineLinksDetails(id);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return null;
    throw e;
  }
  if (!Array.isArray(details)) return null;
  const rows = details.map((d) => {
    const link = d.link || d;
    const consumption = d.linkConsumption || d.consumption || link;
    const capacity = safeSum(consumption.capacity);
    const soldSeats = safeSum(consumption.soldSeats);
    const loadFactor = capacity ? soldSeats / capacity : 0;
    const profit = profitOf(consumption);
    const revenue = consumption.revenue ?? 0;
    const fuelCost = consumption.fuelCost ? Math.abs(consumption.fuelCost) : 0;
    const capByClass = consumption.capacity || link.capacity || {};
    const soldByClass = consumption.soldSeats || {};
    const priceByClass = link.price || {};
    return {
      linkId: link.id ?? consumption.linkId,
      from: link.fromAirportName || link.from?.name,
      fromIata: link.fromAirportIata || link.from?.iata,
      to: link.toAirportName || link.to?.name,
      toIata: link.toAirportIata || link.to?.iata,
      distance: link.distance,
      flightType: link.flightType,
      capacity,
      soldSeats,
      loadFactor,
      profit,
      revenue,
      fuelCost,
      quality: link.computedQuality ?? link.quality,
      rawQuality: link.rawQuality,
      frequency: link.frequency,
      modelId: link.modelId ?? link.assignedAirplanes?.[0]?.modelId,
      modelName: link.modelName ?? link.assignedAirplanes?.[0]?.modelName,
      capByClass,
      soldByClass,
      priceByClass,
    };
  });
  rows.sort((a, b) => (a.profit || 0) - (b.profit || 0));
  const totals = rows.reduce(
    (acc, r) => {
      acc.profit += r.profit || 0;
      acc.revenue += r.revenue || 0;
      acc.capacity += r.capacity;
      acc.soldSeats += r.soldSeats;
      return acc;
    },
    { profit: 0, revenue: 0, capacity: 0, soldSeats: 0 },
  );
  const snapshot = { rows, totals, updatedAt: Date.now() };
  await setKey(KEY, snapshot);
  return snapshot;
}
