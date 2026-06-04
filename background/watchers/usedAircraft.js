// usedAircraft.js — scans /airlines/:id/used-airplanes/models/:modelId for
// matching the user's preferred-models filter.

import { getAirlineUsedAirplanes, getAirlinePreferredSuppliers, getAirplaneModels } from "../api.js";
import { resolveAirlineId } from "../state.js";
import { loadSettings } from "../settings.js";
import { getKey, setKey } from "../storage.js";
import { notify } from "../notifier.js";
import { pool } from "../util.js";

const KEY = "usedAircraftSnapshot";

export async function runUsedAircraftWatcher() {
  const id = await resolveAirlineId();
  if (!id) return null;
  const settings = await loadSettings();
  let modelIds = settings.preferredModels || [];
  if (modelIds.length === 0) {
    // fall back to preferred suppliers list
    try {
      const sup = await getAirlinePreferredSuppliers(id);
      if (Array.isArray(sup)) {
        modelIds = sup.flatMap((s) => (Array.isArray(s.models) ? s.models.map((m) => m.id) : []));
      }
    } catch (e) {
      // ignore
    }
  }
  if (modelIds.length === 0) return { skipped: "no preferred models" };

  const allModels = await getAirplaneModels().catch(() => []);
  const newPriceByModel = new Map();
  for (const m of allModels || []) newPriceByModel.set(m.id, m.price);

  const results = await pool(modelIds, 3, async (modelId) => {
    try {
      const list = await getAirlineUsedAirplanes(id, modelId);
      return { modelId, list: Array.isArray(list) ? list : [] };
    } catch (e) {
      return { modelId, list: [], error: String(e.message || e) };
    }
  });

  const prev = (await getKey(KEY, { seenIds: [] })) || { seenIds: [] };
  const prevSet = new Set(prev.seenIds);
  const allDeals = [];
  for (const { modelId, list } of results) {
    const newPrice = newPriceByModel.get(modelId) || null;
    for (const a of list) {
      const condition = a.condition ?? 100;
      const price = a.dealerValue ?? a.value ?? a.price ?? 0;
      const newP = newPrice || a.modelPrice || null;
      const discountPct = newP ? Math.max(0, ((newP - price) / newP) * 100) : 0;
      const deal = {
        id: a.id,
        modelId,
        modelName: a.modelName || a.model?.name || `Model ${modelId}`,
        condition,
        price,
        newPrice: newP,
        discountPct,
        homeAirportId: a.homeAirportId ?? null,
        dealerId: a.dealerAirlineId ?? null,
      };
      allDeals.push(deal);
    }
  }
  allDeals.sort((a, b) => b.discountPct - a.discountPct);
  const matches = allDeals.filter(
    (d) => d.condition >= settings.usedAircraftMinCondition && d.discountPct >= settings.usedAircraftMaxPriceDiscount,
  );

  const matchKey = (d) => `${d.modelId}:${d.id}`;
  const fresh = matches.filter((d) => !prevSet.has(matchKey(d)));
  const seenIds = matches.map(matchKey);
  await setKey(KEY, { seenIds, deals: matches.slice(0, 50), allDeals: allDeals.slice(0, 200), updatedAt: Date.now() });

  for (const d of fresh.slice(0, 3)) {
    await notify(
      `Used ${d.modelName}`,
      `Condition ${d.condition}%, $${(d.price / 1e6).toFixed(1)}M (${d.discountPct.toFixed(0)}% off new).`,
      "Used aircraft sniper",
    );
  }
  return { total: allDeals.length, matches: matches.length, fresh: fresh.length };
}
