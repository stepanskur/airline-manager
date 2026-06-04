// routeFinder.js — auto-discovers profitable routes from the user's bases.
//
// For every base × every reachable airport (within max fleet range and
// runway-compatible), it:
//   1. Pulls /research-link to get real demand + competitor links.
//   2. Picks the best aircraft from the owned fleet that legally flies the
//      route (strict range + runway + min-runway-margin).
//   3. Estimates revenue (Pricing.computeStandardPrice × captured seats)
//      and weekly operating cost (fuel + crew + airport fees + maintenance +
//      depreciation).
//   4. Computes a composite Optimality score (0..100%) blending profit /
//      load factor / market headroom / competition heat / fleet fit /
//      distance comfort / runway margin — so the user can scan rows at a
//      glance.
//
// Numbers are approximations; the game's simulation is non-deterministic.
// All factor breakdowns are surfaced so the user can sanity-check them.

import {
  getAirlineBases,
  getAirlineFleet,
  getAirlineFleetUngrouped,
  getAirplaneModels,
  getAirports,
  getResearchLink,
  getOilPrices,
} from "./api.js";
import { resolveAirlineId } from "./state.js";
import { loadSettings } from "./settings.js";
import { getKey, setKey } from "./storage.js";
import { haversine, pool } from "./util.js";
import {
  LinkClass,
  getFlightType,
  computeStandardPrice,
  calculateFlightMinutesRequired,
  calculateMaxFrequency,
} from "./pricing.js";

const KEY = "routeFinderResult";
const STATUS_KEY = "routeFinderStatus";

async function setStatus(state) {
  await setKey(STATUS_KEY, {
    ...(await getKey(STATUS_KEY, {})),
    ...state,
    updatedAt: Date.now(),
  });
}

export async function getStatus() {
  return (await getKey(STATUS_KEY, { running: false })) || { running: false };
}

export async function getResult() {
  return (await getKey(KEY, null));
}

// Robust parser for /airlines/:id/airplanes results.
// Possible shapes encountered in the wild:
//   A) Grouped + simple: { "<modelId>": { assignedAirplanes:[...], availableAirplanes:[...], constructingAirplanes:[...] } }
//   B) Ungrouped:        [{ id, model:{ id, name, ... }, home:{...}, ... }, ...]
//   C) Grouped + numeric (older API):  { "<modelId>": <count> }
function buildFleetSummary(rawFleet, models) {
  const byModel = new Map(); // modelId -> { model, count }
  const modelById = new Map(models.map((m) => [m.id, m]));

  const addCount = (modelId, count, fallbackModel) => {
    const model = modelById.get(modelId) || fallbackModel;
    if (!model) return;
    const entry = byModel.get(modelId) || { model, count: 0 };
    entry.count += count;
    byModel.set(modelId, entry);
  };

  if (Array.isArray(rawFleet)) {
    for (const a of rawFleet) {
      const mid = a.model?.id ?? a.modelId;
      if (!mid) continue;
      addCount(mid, 1, a.model);
    }
  } else if (rawFleet && typeof rawFleet === "object") {
    for (const [mid, value] of Object.entries(rawFleet)) {
      const id = Number(mid);
      if (!Number.isFinite(id)) continue;
      if (typeof value === "number") {
        addCount(id, value);
      } else if (value && typeof value === "object") {
        const assigned = Array.isArray(value.assignedAirplanes) ? value.assignedAirplanes.length : 0;
        const available = Array.isArray(value.availableAirplanes) ? value.availableAirplanes.length : 0;
        const constructing = Array.isArray(value.constructingAirplanes) ? value.constructingAirplanes.length : 0;
        const total = assigned + available + constructing;
        if (total > 0) addCount(id, total);
        // Some servers embed the model under `model` inside the entry.
        if (!modelById.has(id) && value.model) addCount(id, 0, value.model);
      }
    }
  }
  return Array.from(byModel.values())
    .filter((e) => e.model)
    .sort((a, b) => (b.model.range || 0) - (a.model.range || 0));
}

// Pick the best-fit aircraft from the owned fleet for a given (distance, runway).
// Strict legality: range must cover distance (with a 5% safety margin),
// destination runway must accept the model. Among legal models, prefer the one
// with the highest capacity (more seats per flight = better economics) — and
// if capacities tie, prefer the lower runway requirement (more flexibility).
function chooseBestModelForDistance(fleet, distance, runway) {
  let best = null;
  for (const entry of fleet) {
    const m = entry.model;
    if (!m) continue;
    const range = Number(m.range) || 0;
    if (range <= 0) continue;
    // Use 1.05× safety margin: never pick a model whose max range is barely the segment.
    if (range < distance * 1.05) continue;
    const rr = Number(m.runwayRequirement) || 0;
    if (runway && rr > runway) continue;
    if (!best) { best = entry; continue; }
    const bestCap = Number(best.model.capacity) || 0;
    const curCap = Number(m.capacity) || 0;
    if (curCap > bestCap) best = entry;
    else if (curCap === bestCap && (Number(m.runwayRequirement) || 0) < (Number(best.model.runwayRequirement) || 0)) {
      best = entry;
    }
  }
  return best;
}

// Same as above but searches the entire catalog (not just owned models) — used
// to suggest what to BUY when nothing in the fleet fits.
function chooseBestCatalogModelForDistance(catalog, distance, runway) {
  let best = null;
  for (const m of catalog) {
    if (!m) continue;
    const range = Number(m.range) || 0;
    if (range < distance * 1.05) continue;
    const rr = Number(m.runwayRequirement) || 0;
    if (runway && rr > runway) continue;
    if (!best) { best = m; continue; }
    if ((Number(m.capacity) || 0) > (Number(best.capacity) || 0)) best = m;
  }
  return best;
}

function flightTypeAllowed(ft, settings) {
  if (!ft) return true;
  if (ft.includes("INTERCONTINENTAL")) return settings.routeIncludeIntercontinental;
  if (ft.includes("INTERNATIONAL")) return settings.routeIncludeInternational;
  return settings.routeIncludeDomestic;
}

// Approximate operating cost per round-trip flight.
function estimateOperatingCost(model, distance, oilPricePerBarrel) {
  const speed = Number(model.speed) || 600;
  const durationHr = (distance / Math.max(speed, 200)) || 0;
  // round-trip
  const fuelKg = (Number(model.fuelBurn) || 6000) * durationHr * 2;
  const barrels = fuelKg / 159;
  const fuelCost = barrels * (Number(oilPricePerBarrel) || 60);

  const seats = Number(model.capacity) || 150;
  const crew = seats * 18;
  const airportFees = seats * 25 + distance * 0.4;
  const inflight = seats * 6;
  const price = Number(model.price) || 50_000_000;
  const lifespan = Math.max(1, Number(model.lifespan) || 30 * 52);
  const maintenance = price * 0.0001;
  const depreciation = price / lifespan;
  return Math.round(fuelCost + crew + airportFees + inflight + maintenance + depreciation);
}

function totalSeatsFromCapacity(cap) {
  if (cap == null) return 0;
  if (typeof cap === "number") return cap;
  return (cap.economy || 0) + (cap.business || 0) + (cap.first || 0);
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Composite optimality score (0..100). Returns { score, breakdown }.
//
// Each factor is a 0..1 utility computed with piecewise-linear curves
// (no sigmoid smoothing) so the values spread out instead of clustering
// near 50%. The weights add up to 1.0. The final score is bonus-/penalty-
// adjusted for fleet ownership and market saturation.
function computeOptimality({
  profitPerWeek,
  loadFactor,
  freeDemand,
  demandSeats,
  rivalCount,
  competitionCap,
  capacityPerWeek,
  distance,
  runway,
  model,
  fitNote, // "owned" or "buy"
}) {
  // Profit: linear 0..1 between $0 and $2M/wk. Negative profits map to 0,
  // anything above $2M to 1. Below break-even we slope down below 0 to be
  // clamped — making losses far more visible than the old sigmoid.
  let profitFactor;
  if (profitPerWeek <= 0) {
    // Map -$500k..0 → 0..0.15 so red routes are clearly weak, not "50/50".
    profitFactor = clamp01((profitPerWeek + 500_000) / 500_000) * 0.15;
  } else {
    profitFactor = clamp01(profitPerWeek / 2_000_000);
    // Bonus tier above $2M/wk so the very best routes can hit 1.0 cleanly.
    profitFactor = Math.min(1, profitFactor);
  }

  // Load factor: linear with a soft sweet spot around 85%.
  let loadFactorFactor;
  if (loadFactor <= 0.85) loadFactorFactor = clamp01(loadFactor / 0.85);
  else if (loadFactor <= 0.98) loadFactorFactor = 1;
  else loadFactorFactor = clamp01(1 - (loadFactor - 0.98) * 5); // over-99% means we're capacity-starved

  // Headroom: how much of the market is unserved.
  const headroomRatio = freeDemand / Math.max(1, demandSeats);
  const headroomFactor = clamp01(headroomRatio);

  // Competition: 0 rivals → 1, decays steeper than before.
  const saturation = competitionCap != null && demandSeats > 0
    ? clamp01(competitionCap / demandSeats)
    : Math.min(1, rivalCount * 0.25);
  const competitionFactor = clamp01(1 - saturation * 0.75 - rivalCount * 0.04);

  // Fleet fit: how well our chosen plane matches the demand per week.
  // A perfect match is ~1, but very over-capacity → smaller plane preferred.
  const matchRatio = capacityPerWeek / Math.max(1, demandSeats);
  let fleetFitFactor;
  if (matchRatio <= 1) fleetFitFactor = matchRatio;
  else if (matchRatio <= 2) fleetFitFactor = 1 - (matchRatio - 1) * 0.25;
  else fleetFitFactor = clamp01(0.5 - (matchRatio - 2) * 0.15);

  // Distance comfort: short hops are economically lousy, very long hops
  // strain crew + airplane lifecycle.
  let distanceFactor;
  if (distance < 250) distanceFactor = 0.2 + (distance / 250) * 0.4;     // 250km → 0.6
  else if (distance < 1000) distanceFactor = 0.6 + ((distance - 250) / 750) * 0.4; // 1000km → 1.0
  else if (distance < 6000) distanceFactor = 1.0;
  else if (distance < 11000) distanceFactor = 1.0 - ((distance - 6000) / 5000) * 0.25;
  else distanceFactor = clamp01(0.75 - (distance - 11000) / 3000 * 0.4);

  // Runway: more margin = safer pick.
  const rrMargin = (runway || 0) - (model?.runwayRequirement || 0);
  const runwayFactor = rrMargin >= 800 ? 1 : rrMargin >= 400 ? 0.9 : rrMargin >= 100 ? 0.75 : rrMargin >= 0 ? 0.55 : 0;

  const weights = {
    profit: 0.34,
    loadFactor: 0.16,
    headroom: 0.13,
    competition: 0.14,
    fleetFit: 0.10,
    distance: 0.07,
    runway: 0.06,
  };
  const sum =
    profitFactor * weights.profit +
    loadFactorFactor * weights.loadFactor +
    headroomFactor * weights.headroom +
    competitionFactor * weights.competition +
    fleetFitFactor * weights.fleetFit +
    distanceFactor * weights.distance +
    runwayFactor * weights.runway;

  let score = Math.round(sum * 100);

  // Ownership penalty/bonus: needing to buy a new plane is a big real-world
  // cost the rest of the model doesn't capture.
  if (fitNote === "buy") score -= 8;
  // Strongly profitable + low competition deserves an extra nudge so the
  // very best routes really stand out instead of clustering at 70-80.
  if (profitPerWeek > 1_000_000 && saturation < 0.4) score += 4;
  // Severely overstocked routes get a small extra penalty.
  if (saturation >= 1.1) score -= 6;

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    breakdown: {
      profit: Math.round(profitFactor * 100),
      loadFactor: Math.round(loadFactorFactor * 100),
      headroom: Math.round(headroomFactor * 100),
      competition: Math.round(competitionFactor * 100),
      fleetFit: Math.round(fleetFitFactor * 100),
      distance: Math.round(distanceFactor * 100),
      runway: Math.round(runwayFactor * 100),
    },
  };
}

export async function runRouteFinder({ source = "manual" } = {}) {
  const id = await resolveAirlineId();
  if (!id) {
    await setStatus({ running: false, error: "Not logged in / airline unknown" });
    return null;
  }
  const settings = await loadSettings();
  await setStatus({ running: true, source, phase: "init", error: null, progress: 0, total: 0 });

  try {
    const [bases, fleetGrouped, allModels, oilPrices, fleetUngrouped] = await Promise.all([
      getAirlineBases(id).catch(() => []),
      getAirlineFleet(id).catch(() => null),
      getAirplaneModels().catch(() => []),
      getOilPrices().catch(() => []),
      getAirlineFleetUngrouped(id).catch(() => []),
    ]);

    // Combine grouped + ungrouped fleet for the most accurate per-model count.
    let fleetEntries = buildFleetSummary(fleetGrouped, allModels);
    if (fleetEntries.length === 0 || fleetEntries.every((e) => e.count === 0)) {
      const ungroupedEntries = buildFleetSummary(fleetUngrouped, allModels);
      // Prefer ungrouped if it has real counts.
      if (ungroupedEntries.some((e) => e.count > 0)) fleetEntries = ungroupedEntries;
    }

    if (fleetEntries.length === 0) {
      await setStatus({ running: false, error: "No aircraft in fleet — nothing to fly the routes with." });
      return null;
    }

    const maxRange = Math.max(...fleetEntries.map((f) => Number(f.model.range) || 0));
    if (maxRange <= 0) {
      await setStatus({ running: false, error: "Fleet has no range information — try opening the game once to sync." });
      return null;
    }
    const oilLatest = (oilPrices || []).slice(-1)[0]?.price || 60;

    await setStatus({ phase: "airports", progress: 0, total: 0 });
    const airports = await getAirports(4000).catch(() => []);
    if (!Array.isArray(airports) || airports.length === 0) {
      await setStatus({ running: false, error: "Could not load the airport list." });
      return null;
    }

    await setStatus({ phase: "candidates", progress: 0, total: 0 });
    const baseAirports = [];
    for (const base of bases || []) {
      const baseAirportId = base.airportId ?? base.airport?.id ?? base.id;
      const baseAirport = airports.find((a) => a.id === baseAirportId);
      if (baseAirport) baseAirports.push(baseAirport);
    }
    if (baseAirports.length === 0) {
      const homeIds = new Set();
      for (const a of fleetUngrouped || []) {
        if (a.home?.id) homeIds.add(a.home.id);
        else if (a.homeAirportId) homeIds.add(a.homeAirportId);
      }
      for (const aid of homeIds) {
        const ap = airports.find((a) => a.id === aid);
        if (ap) baseAirports.push(ap);
      }
    }
    if (baseAirports.length === 0) {
      await setStatus({ running: false, error: "No bases or hubs detected — open at least one base in the game first." });
      return null;
    }

    // Build candidate pairs: every base × every reachable airport.
    const candidates = [];
    // Keep a per-base set of model runway requirements so we can pre-filter destinations.
    const fleetMinRunway = Math.min(...fleetEntries.map((f) => Number(f.model.runwayRequirement) || 0));
    const perBaseCap = Math.max(50, Number(settings.routeMaxDestinations) || 500);
    for (const base of baseAirports) {
      const reachable = airports
        .filter((a) => a.id !== base.id)
        .map((a) => {
          const distance = Math.round(haversine(base.latitude, base.longitude, a.latitude, a.longitude));
          return { ap: a, distance };
        })
        .filter(({ distance }) => distance > 80 && distance <= maxRange)
        .filter(({ ap }) => {
          // Pre-filter by flight-type before /research-link.
          const ft = getFlightType(base, ap, 1);
          return flightTypeAllowed(ft, settings);
        })
        .filter(({ ap }) => {
          // Pre-filter by runway: at least one fleet model must be able to land.
          const rr = Number(ap.runwayLength) || 0;
          if (rr <= 0) return true; // unknown — let server decide
          return rr >= fleetMinRunway;
        })
        // Rank by appeal so when we DO cap, we pick the best.
        .sort((a, b) => {
          const sa = (Number(a.ap.population) || 0) * (Number(a.ap.incomeLevel) || 1) - a.distance * 50;
          const sb = (Number(b.ap.population) || 0) * (Number(b.ap.incomeLevel) || 1) - b.distance * 50;
          return sb - sa;
        })
        .slice(0, perBaseCap);
      for (const { ap, distance } of reachable) {
        candidates.push({ from: base, to: ap, distance });
      }
    }

    await setStatus({ phase: "research", progress: 0, total: candidates.length });

    const concurrency = Math.max(1, Math.min(10, Number(settings.routeMaxRequestsPerSecond) || 5));
    let done = 0;
    const researched = await pool(candidates, concurrency, async (cand) => {
      try {
        const r = await getResearchLink(cand.from.id, cand.to.id);
        done += 1;
        if (done % 25 === 0) await setStatus({ progress: done });
        return { cand, research: r };
      } catch (e) {
        done += 1;
        return { cand, error: String(e?.message || e) };
      }
    });

    await setStatus({ phase: "scoring", progress: candidates.length });

    const scored = [];
    for (const item of researched) {
      if (!item || item.error || !item.research) continue;
      const r = item.research;
      const cand = item.cand;
      const distance = r.distance ?? cand.distance;
      const fromAp = r.fromAirport || cand.from;
      const toAp = r.toAirport || cand.to;
      const ft = getFlightType(fromAp, toAp, distance);
      if (!flightTypeAllowed(ft, settings)) continue;

      const demandLC = r.directDemand || {};
      const demandSeats = totalSeatsFromCapacity(demandLC);
      if (demandSeats < (Number(settings.routeMinDemand) || 0)) continue;

      // Strip own-airline links from the rival list (research-link includes them).
      const rivalLinks = (r.links || []).filter((l) => l.airlineId !== id);
      const competitionCap = rivalLinks.reduce((s, l) => s + totalSeatsFromCapacity(l.capacity), 0);
      const freeDemand = Math.max(0, demandSeats - competitionCap);

      // Pick best owned model.
      const best = chooseBestModelForDistance(fleetEntries, distance, toAp.runwayLength);
      let model, ownedCount, fitNote;
      if (best) {
        model = best.model;
        ownedCount = best.count;
        fitNote = "owned";
      } else {
        // Owned fleet can't fly this route. Suggest a catalog model so the
        // user can see whether buying makes sense.
        const catModel = chooseBestCatalogModelForDistance(allModels, distance, toAp.runwayLength);
        if (!catModel) continue;
        model = catModel;
        ownedCount = 0;
        fitNote = "buy";
      }

      const seatsPerFlight = Number(model.capacity) || 150;
      const maxFreqPerPlane = calculateMaxFrequency(model, distance);
      if (maxFreqPerPlane <= 0) continue;
      const flightMinutes = calculateFlightMinutesRequired(model, distance);

      const myPrice = computeStandardPrice(distance, ft, LinkClass.ECONOMY);
      const capacityPerWeekOnePlane = seatsPerFlight * maxFreqPerPlane;

      // Capture share: take all "free demand", plus a small share of rivals' demand.
      const captured = Math.min(capacityPerWeekOnePlane, freeDemand + competitionCap * 0.2);
      const loadFactor = capacityPerWeekOnePlane > 0 ? captured / capacityPerWeekOnePlane : 0;

      const opCostPerFlight = estimateOperatingCost(model, distance, oilLatest);
      const weeklyOpCost = opCostPerFlight * maxFreqPerPlane;
      const revenue = captured * myPrice;
      const profitPerWeek = revenue - weeklyOpCost;
      // Number of planes that would max-out free demand.
      const planesNeeded = Math.max(
        1,
        Math.ceil(Math.max(captured, freeDemand) / Math.max(1, capacityPerWeekOnePlane))
      );

      // Composite optimality score (0..100).
      const optimality = computeOptimality({
        profitPerWeek,
        loadFactor,
        freeDemand,
        demandSeats,
        rivalCount: rivalLinks.length,
        competitionCap,
        capacityPerWeek: capacityPerWeekOnePlane,
        distance,
        runway: toAp.runwayLength,
        model,
        fitNote,
      });

      const score = Math.round(profitPerWeek * Math.max(0.1, loadFactor) - distance * 5);

      scored.push({
        fromAirport: {
          id: fromAp.id, name: fromAp.name, iata: fromAp.iata, city: fromAp.city,
          country: fromAp.countryCode, runway: fromAp.runwayLength,
        },
        toAirport: {
          id: toAp.id, name: toAp.name, iata: toAp.iata, city: toAp.city,
          country: toAp.countryCode, runway: toAp.runwayLength,
        },
        distance,
        flightType: ft,
        demand: demandLC,
        demandSeats,
        competitionCap,
        freeDemand,
        rivalCount: rivalLinks.length,
        myPrice,
        suggestedModel: {
          id: model.id,
          name: model.name,
          range: Number(model.range) || 0,
          capacity: seatsPerFlight,
          speed: Number(model.speed) || 0,
          runwayRequirement: Number(model.runwayRequirement) || 0,
          ownedCount,
          fitNote, // "owned" or "buy"
          price: Number(model.price) || 0,
        },
        flightMinutes,
        maxFrequency: maxFreqPerPlane,
        loadFactor,
        captured: Math.round(captured),
        revenue: Math.round(revenue),
        weeklyOpCost: Math.round(weeklyOpCost),
        profitPerWeek: Math.round(profitPerWeek),
        planesNeeded,
        optimality: optimality.score,
        optimalityBreakdown: optimality.breakdown,
        score,
      });
    }

    // Sort: optimality first, then profit/wk as tiebreaker.
    scored.sort((a, b) => b.optimality - a.optimality || b.profitPerWeek - a.profitPerWeek);

    const result = {
      bases: baseAirports.map((b) => ({ id: b.id, name: b.name, iata: b.iata, city: b.city })),
      fleet: fleetEntries.map((f) => ({
        modelId: f.model.id,
        modelName: f.model.name,
        count: f.count,
        range: Number(f.model.range) || 0,
        capacity: Number(f.model.capacity) || 0,
        runwayRequirement: Number(f.model.runwayRequirement) || 0,
      })),
      oilPrice: oilLatest,
      candidates: candidates.length,
      researched: researched.length,
      scored: scored.length,
      // Keep all results — the popup will paginate/filter.
      top: scored.slice(0, 500),
      generatedAt: Date.now(),
    };
    await setKey(KEY, result);
    await setStatus({ running: false, phase: "done", progress: candidates.length });
    return result;
  } catch (e) {
    console.error("route finder failed", e);
    await setStatus({ running: false, error: String(e?.message || e) });
    throw e;
  }
}

// Compute optimality for a single (from, to) on demand. Used by the in-page
// widget when the user is planning a specific link.
export async function scoreSingleRoute({ fromIata, toIata }) {
  const id = await resolveAirlineId();
  if (!id) return { ok: false, error: "Not logged in" };
  const settings = await loadSettings();
  const [allModels, oilPrices, fleetGrouped, fleetUngrouped, airports] = await Promise.all([
    getAirplaneModels().catch(() => []),
    getOilPrices().catch(() => []),
    getAirlineFleet(id).catch(() => null),
    getAirlineFleetUngrouped(id).catch(() => []),
    getAirports(4000).catch(() => []),
  ]);
  let fleetEntries = buildFleetSummary(fleetGrouped, allModels);
  if (fleetEntries.length === 0 || fleetEntries.every((e) => e.count === 0)) {
    fleetEntries = buildFleetSummary(fleetUngrouped, allModels);
  }
  const oilLatest = (oilPrices || []).slice(-1)[0]?.price || 60;
  const from = airports.find((a) => a.iata?.toUpperCase() === String(fromIata).toUpperCase());
  const to = airports.find((a) => a.iata?.toUpperCase() === String(toIata).toUpperCase());
  if (!from || !to) return { ok: false, error: "Airport not found by IATA" };
  const distance = Math.round(haversine(from.latitude, from.longitude, to.latitude, to.longitude));
  let research = null;
  try { research = await getResearchLink(from.id, to.id); } catch (e) {}
  const ft = getFlightType(from, to, distance);
  const demandLC = research?.directDemand || {};
  const demandSeats = totalSeatsFromCapacity(demandLC);
  const rivalLinks = (research?.links || []).filter((l) => l.airlineId !== id);
  const competitionCap = rivalLinks.reduce((s, l) => s + totalSeatsFromCapacity(l.capacity), 0);
  const freeDemand = Math.max(0, demandSeats - competitionCap);
  let best = chooseBestModelForDistance(fleetEntries, distance, to.runwayLength);
  let model, ownedCount, fitNote;
  if (best) { model = best.model; ownedCount = best.count; fitNote = "owned"; }
  else {
    const cat = chooseBestCatalogModelForDistance(allModels, distance, to.runwayLength);
    if (!cat) return { ok: false, error: "No aircraft (owned or catalog) can fly this route." };
    model = cat; ownedCount = 0; fitNote = "buy";
  }
  const seatsPerFlight = Number(model.capacity) || 150;
  const maxFreqPerPlane = calculateMaxFrequency(model, distance) || 1;
  const capacityPerWeekOnePlane = seatsPerFlight * maxFreqPerPlane;
  const captured = Math.min(capacityPerWeekOnePlane, freeDemand + competitionCap * 0.2);
  const loadFactor = capacityPerWeekOnePlane > 0 ? captured / capacityPerWeekOnePlane : 0;
  const myPrice = computeStandardPrice(distance, ft, LinkClass.ECONOMY);
  const opCostPerFlight = estimateOperatingCost(model, distance, oilLatest);
  const weeklyOpCost = opCostPerFlight * maxFreqPerPlane;
  const profitPerWeek = captured * myPrice - weeklyOpCost;
  const optimality = computeOptimality({
    profitPerWeek, loadFactor, freeDemand, demandSeats,
    rivalCount: rivalLinks.length, competitionCap, capacityPerWeek: capacityPerWeekOnePlane,
    distance, runway: to.runwayLength, model, fitNote,
  });
  return {
    ok: true,
    fromIata: from.iata, toIata: to.iata,
    fromCity: from.city, toCity: to.city,
    distance, flightType: ft, demandSeats, freeDemand, rivalCount: rivalLinks.length,
    suggestedModel: {
      id: model.id, name: model.name, capacity: seatsPerFlight,
      range: Number(model.range) || 0, runwayRequirement: Number(model.runwayRequirement) || 0,
      ownedCount, fitNote, price: Number(model.price) || 0,
    },
    maxFrequency: maxFreqPerPlane,
    loadFactor,
    myPrice,
    weeklyOpCost: Math.round(weeklyOpCost),
    profitPerWeek: Math.round(profitPerWeek),
    optimality: optimality.score,
    optimalityBreakdown: optimality.breakdown,
  };
}
