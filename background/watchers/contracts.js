// contracts.js — reminds when oil contracts are about to expire.

import { getAirlineOilContracts } from "../api.js";
import { resolveAirlineId } from "../state.js";
import { getKey, setKey } from "../storage.js";
import { notify } from "../notifier.js";

const KEY = "contractsSnapshot";
const WARN_CYCLES = 3;

export async function runContractWatcher() {
  const id = await resolveAirlineId();
  if (!id) return null;
  let list;
  try {
    list = await getAirlineOilContracts(id);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return null;
    throw e;
  }
  if (!Array.isArray(list)) return null;
  const prev = (await getKey(KEY, { warnedIds: [] })) || { warnedIds: [] };
  const warned = new Set(prev.warnedIds);
  const fresh = [];
  for (const c of list) {
    const remaining = c.remainingDuration;
    if (remaining !== undefined && remaining <= WARN_CYCLES && remaining >= 0) {
      if (!warned.has(c.id)) {
        fresh.push(c);
        warned.add(c.id);
      }
    } else if (remaining > WARN_CYCLES) {
      warned.delete(c.id);
    }
  }
  await setKey(KEY, {
    warnedIds: Array.from(warned),
    contracts: list,
    updatedAt: Date.now(),
  });
  for (const c of fresh.slice(0, 3)) {
    await notify(
      "Oil contract expiring soon",
      `Contract #${c.id} expires in ${c.remainingDuration} cycle(s). Volume ${c.volume} barrels @ $${c.price}.`,
      "Oil contracts",
    );
  }
  return { total: list.length, fresh: fresh.length };
}
