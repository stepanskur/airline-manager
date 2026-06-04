// fleetRenewal.js — flags airplanes that are approaching end-of-life or low
// condition, so the user can plan replacements before maintenance bills spike.

import { getAirlineFleetUngrouped, getAirplaneModels } from "./api.js";
import { resolveAirlineId } from "./state.js";
import { setKey } from "./storage.js";

const KEY = "fleetSnapshot";

function ageWeeks(plane, currentCycle) {
  if (!plane.constructedCycle && !plane.purchasedCycle) return null;
  if (currentCycle == null) return null;
  const base = plane.constructedCycle ?? plane.purchasedCycle ?? 0;
  return currentCycle - base;
}

export async function runFleetRenewal({ currentCycle } = {}) {
  const id = await resolveAirlineId();
  if (!id) return null;
  const [fleet, models] = await Promise.all([
    getAirlineFleetUngrouped(id).catch(() => []),
    getAirplaneModels().catch(() => []),
  ]);
  const modelById = new Map(models.map((m) => [m.id, m]));
  const list = (Array.isArray(fleet) ? fleet : []).map((p) => {
    const mid = p.model?.id ?? p.modelId;
    const model = modelById.get(mid) || p.model || {};
    const lifespan = model.lifespan || 30 * 52;
    const age = ageWeeks(p, currentCycle);
    const condition = p.condition ?? null;
    return {
      id: p.id,
      modelId: mid,
      modelName: p.model?.name || model.name,
      condition,
      ageWeeks: age,
      lifespan,
      homeAirportId: p.home?.id ?? p.homeAirportId,
      homeAirportName: p.home?.name ?? p.homeAirportName,
      value: p.dealerValue ?? p.value,
    };
  });
  list.sort((a, b) => (a.condition ?? 100) - (b.condition ?? 100));
  const lowCondition = list.filter((p) => (p.condition ?? 100) < 35);
  const snapshot = { list, lowCondition, updatedAt: Date.now() };
  await setKey(KEY, snapshot);
  return snapshot;
}
