// bridge.js — runs in ISOLATED world of airline-club.com pages.
// Listens for window.postMessage events from page-probe.js (MAIN world)
// and forwards them to the extension's service worker / our widget.

(function () {
  "use strict";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === "AIRLINE_CO_PILOT_PROBE") {
      if (event.origin !== data.origin) return;
      try {
        chrome.runtime.sendMessage({
          type: "PROBE",
          airline: data.airline,
          currentCycle: data.currentCycle,
          origin: data.origin,
          timestamp: data.timestamp,
        });
      } catch (e) {
        // Service worker may be inactive briefly; ignore.
      }
    } else if (data.type === "AIRLINE_CO_PILOT_PLAN_LINK") {
      if (event.origin !== data.origin) return;
      // Re-dispatch as a CustomEvent so widget.js can listen without coupling.
      try {
        document.dispatchEvent(new CustomEvent("acpPlanLink", {
          detail: { ...(data.planLink || {}), closed: !!data.closed },
        }));
      } catch (e) {}
    }
  });
})();
