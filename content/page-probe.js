// page-probe.js — runs in MAIN world of airline-club.com pages.
//
// Reads game-internal globals (window.activeAirline, window.planLinkInfo)
// and forwards them to the extension's isolated content script via
// window.postMessage.

(function () {
  "use strict";

  const TAG = "[AirlineClub Co-Pilot]";

  function snapshotAirline() {
    try {
      const aa = window.activeAirline;
      if (!aa || typeof aa.id !== "number") return null;
      return {
        id: aa.id,
        name: aa.name || null,
        balance: typeof aa.balance === "number" ? aa.balance : null,
        reputation: typeof aa.reputation === "number" ? aa.reputation : null,
        airlineGrade: aa.airlineGrade
          ? { description: aa.airlineGrade.description ?? null, level: aa.airlineGrade.level ?? null }
          : null,
      };
    } catch (e) { return null; }
  }

  function snapshotCycle() {
    try {
      if (typeof window.currentCycle === "number") return window.currentCycle;
    } catch (e) {}
    return null;
  }

  function post() {
    const payload = {
      type: "AIRLINE_CO_PILOT_PROBE",
      airline: snapshotAirline(),
      currentCycle: snapshotCycle(),
      origin: window.location.origin,
      timestamp: Date.now(),
    };
    if (payload.airline) window.postMessage(payload, window.location.origin);
  }

  // Initial poll for activeAirline (page boot can take several seconds).
  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    if (snapshotAirline()) {
      post();
      clearInterval(interval);
      setInterval(post, 30 * 1000);
      startPlanLinkProbe();
    } else if (attempts > 120) {
      clearInterval(interval);
      console.debug(TAG, "no active airline detected (not logged in?)");
    }
  }, 1000);

  // ---------- Plan-link probe ----------
  // airline-web's airline.js stores the current plan-link state on the
  // global `planLinkInfo` once the user opens the Plan-Link UI for any
  // pair (window/airport.js → planLink() → updatePlanLinkInfo()).
  // The hidden inputs `#planLinkFromAirportId` / `#planLinkToAirportId`
  // also hold the airport ids while the panel is being assembled.
  //
  // We post a PLAN_LINK message whenever the visible (from, to) pair
  // changes — but only when `#planLinkDetails` is actually displayed,
  // otherwise we'd ping for stale data.
  function readPlanLink() {
    try {
      const details = document.getElementById("planLinkDetails");
      if (!details || details.offsetParent === null) return null; // hidden

      const info = window.planLinkInfo;
      let fromIata = null, toIata = null;
      let fromId = null, toId = null;
      let fromCity = null, toCity = null;
      let distance = null, ft = null;
      if (info && typeof info === "object") {
        fromIata = info.fromAirportCode || null;
        toIata = info.toAirportCode || null;
        fromCity = info.fromAirportCity || null;
        toCity = info.toAirportCity || null;
        fromId = info.fromAirportId || null;
        toId = info.toAirportId || null;
        distance = info.distance || null;
        ft = info.flightType || null;
      }
      // Fallback to hidden inputs (they hold airport ids while planLinkInfo
      // is still being constructed).
      if (!fromId) {
        const v = document.getElementById("planLinkFromAirportId")?.value;
        if (v) fromId = Number(v);
      }
      if (!toId) {
        const v = document.getElementById("planLinkToAirportId")?.value;
        if (v) toId = Number(v);
      }
      if (!fromIata || !toIata) return null;
      return { fromIata, toIata, fromCity, toCity, fromId, toId, distance, flightType: ft };
    } catch (e) { return null; }
  }

  function startPlanLinkProbe() {
    let lastSig = null;
    const tick = () => {
      const snap = readPlanLink();
      const sig = snap ? `${snap.fromIata}|${snap.toIata}` : "(closed)";
      if (sig !== lastSig) {
        lastSig = sig;
        window.postMessage({
          type: "AIRLINE_CO_PILOT_PLAN_LINK",
          planLink: snap,
          closed: !snap,
          origin: window.location.origin,
          timestamp: Date.now(),
        }, window.location.origin);
      }
    };
    setInterval(tick, 1200);

    // Also poke on click/keypress within the plan-link area to react faster.
    document.addEventListener("click", () => setTimeout(tick, 300), true);
    document.addEventListener("change", () => setTimeout(tick, 300), true);
  }
})();
