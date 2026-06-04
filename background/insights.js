// insights.js — generates a long list of actionable, game-mechanics aware
// suggestions from the snapshots produced by other watchers.
//
// Rule types (kind):
//   raise_frequency / lower_frequency / re_equip_smaller / re_equip_larger
//   close_link / quality_low / class_mix_economy_only / class_mix_drop_first
//   short_haul_underflown / long_haul_overflown / pricing_undercut
//   pricing_match_rival / pricing_overpriced / rival_exit / rival_new_entry
//   open_route / contract_oil / oil_warn_high / loan_refi_down / loan_payoff
//   buy_used_deal / aging_fleet / low_condition_plane / base_expand
//   rep_low / cash_idle / cash_low / cycle_end_soon / preferred_supplier
//
// All rules are tagged with a priority (1..5, 5 = open obvious opportunity)
// and an estimated $/wk impact when possible, so the UI can sort/filter.

import { getKey, setKey } from "./storage.js";

const KEY = "insightsSnapshot";

function safeSum(obj) {
  if (!obj) return 0;
  if (typeof obj === "number") return obj;
  return (obj.economy || 0) + (obj.business || 0) + (obj.first || 0);
}

function pair(row) {
  return `${row.fromIata || row.from || "?"} → ${row.toIata || row.to || "?"}`;
}

function pushIf(arr, item) {
  if (item) arr.push(item);
}

// ---------- Existing-link rules ----------
function classifyExistingLink(row, ctx) {
  const out = [];
  const lf = row.loadFactor || 0;
  const profit = row.profit || 0;
  const freq = row.frequency || 0;
  const dist = row.distance || 0;
  const pairLabel = pair(row);
  const lfPct = (lf * 100).toFixed(0);
  const profitK = Math.round(profit / 1000);

  // R1. Bleeding loss → close.
  if (profit < -200_000 && lf < 0.5) {
    out.push({
      kind: "close_link",
      priority: 4,
      title: `${pairLabel} — losing $${Math.abs(profitK)}k/wk at ${lfPct}% LF`,
      detail: `This link is bleeding cash. Either close it, switch to a far smaller aircraft, or cut frequency to 1/wk and watch one cycle.`,
      impact: -profit,
      linkId: row.linkId,
    });
  }

  // R2. Capacity-starved profitable link → add frequency.
  if (lf > 0.92 && profit > 100_000) {
    out.push({
      kind: "raise_frequency",
      priority: 5,
      title: `${pairLabel} — ${lfPct}% LF, +$${profitK}k/wk — add a flight`,
      detail: `You're leaving demand on the table. Add 1 flight/wk or assign a larger aircraft. Watch maxFrequency on the current model.`,
      impact: Math.round(profit * 0.3),
      linkId: row.linkId,
    });
  }

  // R3. Over-capacity, losing money → cut frequency or downsize.
  if (lf < 0.5 && profit < -50_000) {
    out.push({
      kind: "lower_frequency",
      priority: 3,
      title: `${pairLabel} — ${lfPct}% LF, -$${Math.abs(profitK)}k/wk — cut frequency`,
      detail: `Cut frequency by 30–50% or rotate a smaller plane in. Lower op cost will outweigh the lost revenue.`,
      impact: Math.round(Math.abs(profit) * 0.5),
      linkId: row.linkId,
    });
  }

  // R4. Over-capacity, still profitable → re-equip smaller.
  if (lf < 0.55 && profit > 0 && freq <= 2) {
    out.push({
      kind: "re_equip_smaller",
      priority: 2,
      title: `${pairLabel} — ${lfPct}% LF — try a smaller plane`,
      detail: `Profit OK but seats unsold. Smaller plane → cheaper crew + fuel, better quality-per-seat. Look at regional turboprops for short haul.`,
      impact: Math.round((row.fuelCost || 0) * 0.25),
      linkId: row.linkId,
    });
  }

  // R5. Almost maxed out frequency → re-equip larger.
  if (lf > 0.96 && freq >= 14) {
    out.push({
      kind: "re_equip_larger",
      priority: 4,
      title: `${pairLabel} — frequency near cap (${freq}/wk @ ${lfPct}% LF)`,
      detail: `You're flying nearly every slot. Move to a larger aircraft to capture remaining demand without juggling more departures.`,
      impact: Math.round((profit || 0) * 0.4),
      linkId: row.linkId,
    });
  }

  // R6. Low quality.
  if (row.quality != null && row.quality < 50 && lf > 0.4) {
    out.push({
      kind: "quality_low",
      priority: 2,
      title: `${pairLabel} — quality only ${Math.round(row.quality)}`,
      detail: `Boost service level, in-flight catering, or assign a newer plane. Higher quality = higher loyalty → softer demand response to price drops.`,
      impact: Math.round((row.revenue || 0) * 0.08),
      linkId: row.linkId,
    });
  }

  // R7. Class-mix imbalance.
  const capE = row.capByClass?.economy || 0;
  const capB = row.capByClass?.business || 0;
  const capF = row.capByClass?.first || 0;
  const soldE = row.soldByClass?.economy || 0;
  const soldB = row.soldByClass?.business || 0;
  const soldF = row.soldByClass?.first || 0;
  if (capF > 0 && capF > 4 && soldF / capF < 0.25 && dist < 3000) {
    out.push({
      kind: "class_mix_drop_first",
      priority: 2,
      title: `${pairLabel} — first-class barely selling (${soldF}/${capF})`,
      detail: `Short-haul rarely fills first class. Reconfigure the cabin: convert first → business or economy. You'll move more total seats.`,
      impact: Math.round((row.fuelCost || 0) * 0.05),
      linkId: row.linkId,
    });
  }
  if (capB > 0 && capB > 4 && soldB / capB < 0.25 && dist < 1200) {
    out.push({
      kind: "class_mix_drop_business",
      priority: 2,
      title: `${pairLabel} — business empty on a short route`,
      detail: `Business class on <1200 km routes underperforms. Reconfigure to mostly economy.`,
      impact: Math.round((row.fuelCost || 0) * 0.04),
      linkId: row.linkId,
    });
  }

  // R8. Long-haul, no premium seats.
  if (dist > 5000 && capB === 0 && capF === 0 && lf > 0.7) {
    out.push({
      kind: "class_mix_add_premium",
      priority: 3,
      title: `${pairLabel} — long-haul without premium cabin`,
      detail: `Routes > 5000 km generate strong premium demand. Reconfigure to add some business/first; per-seat revenue jumps a lot.`,
      impact: Math.round((row.revenue || 0) * 0.18),
      linkId: row.linkId,
    });
  }

  // R9. Short-haul, low frequency (under daily).
  if (dist < 800 && freq < 7 && lf > 0.7) {
    out.push({
      kind: "short_haul_underflown",
      priority: 3,
      title: `${pairLabel} — under-flown short-haul (${freq}/wk @ ${lfPct}% LF)`,
      detail: `<800 km routes want daily+ service. Add frequency before a rival fills the gap.`,
      impact: Math.round((profit || 0) * 0.25),
      linkId: row.linkId,
    });
  }

  // R10. Long-haul overflown — frequency-load mismatch.
  if (dist > 6000 && freq > 7 && lf < 0.55) {
    out.push({
      kind: "long_haul_overflown",
      priority: 3,
      title: `${pairLabel} — too many long-haul departures (${freq}/wk @ ${lfPct}% LF)`,
      detail: `Long-haul has thinner demand. Drop frequency to 4–6/wk; you'll free up planes for routes that actually need them.`,
      impact: Math.round((row.fuelCost || 0) * 0.15),
      linkId: row.linkId,
    });
  }

  // R11. Suspiciously thin profit → may be over/underpriced.
  if (Math.abs(profit) < 50_000 && lf > 0.85 && row.priceByClass?.economy) {
    out.push({
      kind: "pricing_test_premium",
      priority: 2,
      title: `${pairLabel} — high LF but flat profit — try +5% price`,
      detail: `LF ${lfPct}% with razor-thin profit suggests you can lift price ~5% before losing significant demand. Test it cycle by cycle.`,
      impact: Math.round((row.revenue || 0) * 0.05),
      linkId: row.linkId,
    });
  }

  return out;
}

// ---------- Cross-snapshot rules ----------
function rivalsRules(rivals, profitRows, settings) {
  const out = [];
  const perLink = rivals?.perLink || {};
  const byKey = new Map(profitRows.map((r) => [`${r.fromIata}->${r.toIata}`, r]));
  for (const [, row] of Object.entries(perLink)) {
    const myPriceE = row.myPrice?.economy ?? row.myPrice;
    if (typeof myPriceE !== "number" || myPriceE === 0) continue;
    const minRival = row.rivals?.reduce((min, r) => {
      const p = r.price?.economy ?? r.price;
      if (typeof p !== "number") return min;
      return min == null ? p : Math.min(min, p);
    }, null);
    if (minRival == null) continue;
    if (myPriceE > minRival * 1.15) {
      out.push({
        kind: "pricing_overpriced",
        priority: 3,
        title: `${row.fromAirportName} → ${row.toAirportName} — overpriced vs rivals`,
        detail: `You: $${myPriceE} / Cheapest rival: $${minRival}. You're ${(((myPriceE - minRival) / minRival) * 100).toFixed(0)}% above market. Demand will leak unless your quality compensates.`,
        impact: null,
        linkId: row.linkId,
      });
    } else if (myPriceE < minRival * 0.85) {
      out.push({
        kind: "pricing_undercut",
        priority: 2,
        title: `${row.fromAirportName} → ${row.toAirportName} — undercutting market`,
        detail: `You: $${myPriceE} / Cheapest rival: $${minRival}. Room to raise price ${(((minRival - myPriceE) / minRival) * 100).toFixed(0)}% without losing your demand share.`,
        impact: null,
        linkId: row.linkId,
      });
    }
  }

  // Recent rival events.
  for (const ev of (rivals?.events || []).slice(0, 5)) {
    out.push({
      kind: ev.kind === "rival_exit" ? "rival_exit" : ev.kind === "rival_entry" ? "rival_new_entry" : "rival_move",
      priority: ev.kind === "rival_exit" ? 4 : 3,
      title: ev.text,
      detail: ev.kind === "rival_exit"
        ? "A competitor pulled out — increase frequency or capacity to absorb their share."
        : ev.kind === "rival_entry"
          ? "A new competitor entered — review your price and quality before they erode demand."
          : "A competitor changed pricing/capacity — re-evaluate price + LF.",
      impact: null,
    });
  }

  return out;
}

function oilRules(oil) {
  const out = [];
  if (!oil) return out;
  if (oil.deviationPct != null && oil.deviationPct <= -5) {
    out.push({
      kind: "contract_oil",
      priority: 4,
      title: `Lock an oil contract — current price ${oil.deviationPct.toFixed(1)}% below avg`,
      detail: `Oil at $${oil.latestPrice?.toFixed(2)} (${oil.windowAvg?.toFixed(2) || "?"} avg). Sign a 26+ cycle contract to insulate fuel costs.`,
      impact: null,
    });
  }
  if (oil.deviationPct != null && oil.deviationPct >= 6) {
    out.push({
      kind: "oil_warn_high",
      priority: 3,
      title: `Oil is +${oil.deviationPct.toFixed(1)}% above window — expect higher fuel bills`,
      detail: `Re-check your worst-margin links — if profit is mostly fuel, drop frequency or downsize a class until oil drops back.`,
      impact: null,
    });
  }
  return out;
}

function loanRules(loans) {
  const out = [];
  const rates = loans?.rates;
  if (!rates) return out;
  // Find the lowest current rate.
  const best = Object.values(rates).flat?.() || [];
  const minRate = best.length ? best.reduce((m, l) => Math.min(m, l.rate || Infinity), Infinity) : null;
  if (minRate != null && minRate < 0.045) {
    out.push({
      kind: "loan_take",
      priority: 2,
      title: `Cheap loans available (${(minRate * 100).toFixed(2)}%)`,
      detail: `If you have profitable routes you can't fund cash, this is a good window to borrow. Cap leverage at ~30% of equity to stay safe.`,
      impact: null,
    });
  }
  return out;
}

function fleetRules(fleet, currentCycle) {
  const out = [];
  const list = fleet?.list || [];
  for (const plane of list.slice(0, 8)) {
    if ((plane.condition ?? 100) < 30) {
      out.push({
        kind: "low_condition_plane",
        priority: 3,
        title: `${plane.modelName} #${plane.id} at ${plane.condition}% condition`,
        detail: `Below 30% condition → maintenance bills climb fast. Sell it (dealer value $${plane.value || "?"}) or reassign it to a feeder route.`,
        impact: null,
      });
    } else if (plane.ageWeeks != null && plane.lifespan && plane.ageWeeks / plane.lifespan > 0.85) {
      out.push({
        kind: "aging_fleet",
        priority: 2,
        title: `${plane.modelName} #${plane.id} near end-of-life`,
        detail: `${plane.ageWeeks}/${plane.lifespan} weeks. Start replacement planning — used aircraft auctions are cheaper than new orders.`,
        impact: null,
      });
    }
  }
  return out;
}

function usedRules(used) {
  const out = [];
  for (const deal of (used?.deals || []).slice(0, 4)) {
    out.push({
      kind: "buy_used_deal",
      priority: 3,
      title: `Used ${deal.modelName} — ${deal.condition}% cond @ $${(deal.dealerPrice / 1e6).toFixed(2)}M`,
      detail: `Discount ~${Math.round(deal.discountPct)}% vs new. ${deal.daysRemaining ? `Listing ends in ${deal.daysRemaining}d.` : ""} Use to expand without large up-front capex.`,
      impact: null,
    });
  }
  return out;
}

function airlineHealthRules(session, profit, routeRes) {
  const out = [];
  const bal = session?.balance;
  const totalProfit = profit?.totals?.profit || 0;
  if (typeof bal === "number") {
    if (bal > 200_000_000 && (routeRes?.top || []).filter((r) => r.optimality >= 70 && r.suggestedModel.fitNote === "owned").length === 0) {
      out.push({
        kind: "cash_idle",
        priority: 2,
        title: `$${(bal / 1e6).toFixed(0)}M idle cash — put it to work`,
        detail: `Run the route finder, look for 70%+ optimality routes that need new planes (fitNote: buy), or upgrade a base / lounge.`,
        impact: null,
      });
    }
    if (bal < 5_000_000 && totalProfit < 0) {
      out.push({
        kind: "cash_low",
        priority: 5,
        title: `Cash below $5M and profit negative — danger zone`,
        detail: `Close at least one losing route, sell idle planes, or take a small loan before you trigger bankruptcy alerts.`,
        impact: totalProfit,
      });
    }
  }
  const rep = session?.reputation;
  if (typeof rep === "number" && rep < 50) {
    out.push({
      kind: "rep_low",
      priority: 2,
      title: `Reputation ${Math.round(rep)} — lift quality + frequency to grow`,
      detail: `Reputation gates passenger preference. Raise service level on long-haul, run reliable schedules, and avoid late/cancelled flights.`,
      impact: null,
    });
  }
  return out;
}

function cycleRules(cycle) {
  const out = [];
  if (!cycle?.remainingMs) return out;
  const min = Math.round((cycle.remainingMs || 0) / 60000);
  if (min > 0 && min <= 8) {
    out.push({
      kind: "cycle_end_soon",
      priority: 5,
      title: `Cycle ends in ${min} min — finish your moves`,
      detail: `Apply pending price/frequency tweaks before the cycle rolls over so they take effect this period.`,
      impact: null,
    });
  }
  return out;
}

// ---------- Daily checklist ----------
// Compact 5-item list — the "to-do for this session".
function dailyChecklist(suggestions, oil, contracts) {
  const list = [];
  const has = new Set();
  for (const s of suggestions) {
    if (list.length >= 5) break;
    if (has.has(s.kind)) continue;
    has.add(s.kind);
    list.push({ kind: s.kind, title: s.title });
  }
  if (oil?.deviationPct != null && oil.deviationPct <= -3 && list.length < 5 && !has.has("contract_oil")) {
    list.push({ kind: "contract_oil", title: `Lock a fuel contract (oil ${oil.deviationPct.toFixed(1)}% below avg)` });
  }
  const expiring = (contracts?.contracts || []).filter((c) => (c.expiringInDays || c.cyclesLeft || 0) <= 5);
  if (expiring.length && list.length < 5) {
    list.push({ kind: "contract_renew", title: `Renew ${expiring.length} oil contract(s) expiring soon` });
  }
  return list;
}

export async function runInsights() {
  const [profit, routeRes, oil, contracts, rivals, fleet, used, session, loans, settings, cycle] =
    await Promise.all([
      getKey("profitSnapshot", null),
      getKey("routeFinderResult", null),
      getKey("oilSnapshot", null),
      getKey("contractsSnapshot", null),
      getKey("rivalsSnapshot", null),
      getKey("fleetSnapshot", null),
      getKey("usedAircraftSnapshot", null),
      getKey("session", null),
      getKey("loanRatesSnapshot", null),
      getKey("settingsCache", {}),
      getKey("cycleSnapshot", null),
    ]);

  const suggestions = [];
  const linkRows = profit?.rows || [];

  for (const row of linkRows) {
    for (const s of classifyExistingLink(row, { profit, settings })) {
      suggestions.push(s);
    }
  }

  for (const s of rivalsRules(rivals, linkRows, settings)) suggestions.push(s);
  for (const s of oilRules(oil)) suggestions.push(s);
  for (const s of loanRules(loans)) suggestions.push(s);
  for (const s of fleetRules(fleet, cycle?.cycle)) suggestions.push(s);
  for (const s of usedRules(used)) suggestions.push(s);
  for (const s of airlineHealthRules(session, profit, routeRes)) suggestions.push(s);
  for (const s of cycleRules(cycle)) suggestions.push(s);

  // Top new-route opportunities from route finder.
  if (routeRes?.top?.length) {
    const owned = routeRes.top.filter(
      (r) => r.suggestedModel.fitNote === "owned" && r.profitPerWeek > 0
    );
    for (const r of owned.slice(0, 5)) {
      suggestions.push({
        kind: "open_route",
        priority: 5,
        title: `Open ${r.fromAirport.iata} → ${r.toAirport.iata} (Optimality ${r.optimality}%)`,
        detail: `${r.fromAirport.city || ""} → ${r.toAirport.city || ""}. ${r.suggestedModel.name} × ${r.maxFrequency}/wk, projected ${Math.round((r.profitPerWeek || 0) / 1000)}k/wk profit.`,
        impact: r.profitPerWeek || 0,
      });
    }
    // Best 'buy this plane' opportunity too.
    const buy = routeRes.top.find((r) => r.suggestedModel.fitNote === "buy" && r.optimality >= 70 && r.profitPerWeek > 500_000);
    if (buy) {
      suggestions.push({
        kind: "buy_to_open_route",
        priority: 3,
        title: `Buy ${buy.suggestedModel.name} to open ${buy.fromAirport.iata} → ${buy.toAirport.iata}`,
        detail: `Optimality ${buy.optimality}% but you don't own a matching plane. New ${buy.suggestedModel.name} ~$${(buy.suggestedModel.price / 1e6).toFixed(1)}M. Projected ${Math.round((buy.profitPerWeek || 0) / 1000)}k/wk profit.`,
        impact: buy.profitPerWeek || 0,
      });
    }
  }

  // Sort and cap.
  suggestions.sort((a, b) => (b.priority - a.priority) || ((Math.abs(b.impact || 0)) - (Math.abs(a.impact || 0))));

  // Find the worst-performing link for the dashboard card.
  let worstLink = null;
  for (const row of linkRows) {
    if (!worstLink || (row.profit || 0) < (worstLink.profit || 0)) {
      worstLink = {
        from: row.fromIata || row.from,
        to: row.toIata || row.to,
        loadFactor: row.loadFactor || 0,
        profit: row.profit || 0,
        linkId: row.linkId,
      };
    }
  }
  // Best performer too.
  let bestLink = null;
  for (const row of linkRows) {
    if (!bestLink || (row.profit || 0) > (bestLink.profit || 0)) {
      bestLink = {
        from: row.fromIata || row.from,
        to: row.toIata || row.to,
        loadFactor: row.loadFactor || 0,
        profit: row.profit || 0,
        linkId: row.linkId,
      };
    }
  }

  const snapshot = {
    suggestions: suggestions.slice(0, 60),
    worstLink,
    bestLink,
    dailyChecklist: dailyChecklist(suggestions, oil, contracts),
    countByKind: suggestions.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
    generatedAt: Date.now(),
  };
  await setKey(KEY, snapshot);
  return snapshot;
}
