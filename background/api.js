// api.js — typed fetch wrappers for airline-club.com endpoints.
// Uses the browser's cookie jar via credentials: "include".

import { resolveHost } from "./state.js";

async function call(path, { method = "GET", body, host } = {}) {
  const base = host || (await resolveHost());
  const url = `${base}${path}`;
  const opts = {
    method,
    credentials: "include",
    headers: { "Accept": "application/json" },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${res.statusText} on ${path}${text ? `: ${text.slice(0, 160)}` : ""}`);
    err.status = res.status;
    err.path = path;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ---- Public game data ----
export const getCurrentCycle = () => call("/current-cycle");
export const getOilPrices = () => call("/oil-prices");
export const getLoanInterestRates = () => call("/loan-interest-rates");
export const getAirplaneModels = () => call("/airplane-models");
export const getAirports = (count = 4000) => call(`/airports?count=${count}`);
export const getAirport = (airportId) => call(`/airports/${airportId}`);
export const getResearchLink = (fromId, toId) => call(`/research-link/${fromId}/${toId}`);
export const getRankings = () => call("/rankings");

// ---- Airline-scoped data ----
export const getAirline = (id, extendedInfo = true) => call(`/airlines/${id}?extendedInfo=${extendedInfo}`);
export const getAirlineLinks = (id) => call(`/airlines/${id}/links`);
export const getAirlineLinksDetails = (id) => call(`/airlines/${id}/links-details`);
export const getAirlineLinkConsumption = (id, linkId, cycleCount = 5) =>
  call(`/airlines/${id}/link-consumptions/${linkId}?cycleCount=${cycleCount}`);
export const getAirlineLinkRivalDetails = (id, linkId, cycleCount = 1) =>
  call(`/airlines/${id}/link-rival-details/${linkId}?cycleCount=${cycleCount}`);
export const getAirlineFleet = (id) => call(`/airlines/${id}/airplanes?simpleResult=true&groupedResult=true`);
export const getAirlineFleetUngrouped = (id) => call(`/airlines/${id}/airplanes?simpleResult=true`);
export const getAirlineBases = (id) => call(`/airlines/${id}/bases`);
export const getAirlineFinances = (id) => call(`/airlines/${id}/finances`);
export const getAirlineOilContracts = (id) => call(`/airlines/${id}/oil-contracts`);
export const getAirlineOilDetails = (id) => call(`/airlines/${id}/oil-details`);
export const getAirlineAlerts = (id) => call(`/airlines/${id}/alerts`);
export const getAirlineLogs = (id) => call(`/airlines/${id}/logs`);
export const getAirlineUsedAirplanes = (id, modelId) => call(`/airlines/${id}/used-airplanes/models/${modelId}`);
export const getAirlineLoans = (id) => call(`/airlines/${id}/loans`);
export const getAirlineMaxLoan = (id) => call(`/airlines/${id}/max-loan`);
export const getAirlinePreferredSuppliers = (id) => call(`/airlines/${id}/preferred-suppliers`);
export const getAirlineAllianceDetails = (id) => call(`/airlines/${id}/alliance-details`);
export const getAirlineFleetSummary = (id) => call(`/airlines/${id}/fleet`);
