// rivals.js — per-link rival radar.
// Snapshots /research-link for each of the user's links and emits notifications
// when a competitor significantly drops price, lowers capacity, or exits.

import { getAirlineLinks, getResearchLink } from "../api.js";
import { resolveAirlineId } from "../state.js";
import { loadSettings } from "../settings.js";
import { getKey, setKey } from "../storage.js";
import { notify } from "../notifier.js";
import { pool } from "../util.js";

const KEY = "rivalsSnapshot";

function digestLink(link) {
  return {
    airlineId: link.airlineId,
    airlineName: link.airlineName,
    price: link.price,
    capacity: link.capacity,
    frequency: link.frequency,
    quality: link.computedQuality ?? link.quality,
  };
}

export async function runRivalRadar() {
  const id = await resolveAirlineId();
  if (!id) return null;
  const settings = await loadSettings();
  let links;
  try {
    links = await getAirlineLinks(id);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return null;
    throw e;
  }
  if (!Array.isArray(links) || links.length === 0) {
    await setKey(KEY, { perLink: {}, updatedAt: Date.now() });
    return null;
  }

  const prev = (await getKey(KEY, { perLink: {} })) || { perLink: {} };
  const perLink = {};
  const events = [];

  const limited = links.slice(0, 80); // safety cap
  await pool(limited, 4, async (link) => {
    try {
      const research = await getResearchLink(link.fromAirportId, link.toAirportId);
      const rivals = (research.links || []).filter((l) => l.airlineId !== id).map(digestLink);
      const key = `${link.fromAirportId}->${link.toAirportId}`;
      perLink[key] = {
        linkId: link.id,
        fromAirportId: link.fromAirportId,
        toAirportId: link.toAirportId,
        fromAirportName: research.fromAirportText || link.fromAirportName,
        toAirportName: research.toAirportText || link.toAirportName,
        myPrice: link.price,
        myCapacity: link.capacity,
        myFrequency: link.frequency,
        directDemand: research.directDemand,
        rivals,
        updatedAt: Date.now(),
      };
      const prevForLink = prev.perLink[key];
      if (prevForLink) {
        const prevRivals = new Map(prevForLink.rivals.map((r) => [r.airlineId, r]));
        for (const cur of rivals) {
          const old = prevRivals.get(cur.airlineId);
          if (!old) {
            events.push({
              kind: "rival_entry",
              link: key,
              text: `${research.fromAirportText} → ${research.toAirportText}: new competitor ${cur.airlineName}.`,
            });
          } else {
            // economy price drop
            const oldP = old.price?.economy ?? old.price;
            const curP = cur.price?.economy ?? cur.price;
            if (oldP && curP && (oldP - curP) / oldP >= settings.rivalPriceDropAlertPercent / 100) {
              events.push({
                kind: "rival_price_drop",
                link: key,
                text: `${cur.airlineName} lowered economy price from $${oldP} to $${curP} on ${research.fromAirportText} → ${research.toAirportText}.`,
              });
            }
            const oldCap = (old.capacity?.economy ?? old.capacity) || 0;
            const curCap = (cur.capacity?.economy ?? cur.capacity) || 0;
            if (oldCap > 0 && curCap < oldCap * (1 - settings.rivalCapacityDropAlertPercent / 100)) {
              events.push({
                kind: "rival_capacity_drop",
                link: key,
                text: `${cur.airlineName} cut capacity on ${research.fromAirportText} → ${research.toAirportText}.`,
              });
            }
          }
          prevRivals.delete(cur.airlineId);
        }
        for (const left of prevRivals.values()) {
          events.push({
            kind: "rival_exit",
            link: key,
            text: `${left.airlineName} pulled out of ${research.fromAirportText} → ${research.toAirportText}.`,
          });
        }
      }
    } catch (e) {
      // skip on error
    }
  });

  await setKey(KEY, { perLink, updatedAt: Date.now(), events: events.slice(0, 30) });
  for (const ev of events.slice(0, 3)) {
    await notify("Competitor move", ev.text, "Rival radar");
  }
  return { links: Object.keys(perLink).length, events: events.length };
}
