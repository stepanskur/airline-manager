// state.js — tracks the active airline session (id + host).

import { getKey, setKey } from "./storage.js";
import { loadSettings } from "./settings.js";

const KEY = "session";

export async function updateFromProbe(probe) {
  if (!probe || !probe.airline || typeof probe.airline.id !== "number") return null;
  const session = {
    airlineId: probe.airline.id,
    airlineName: probe.airline.name,
    balance: probe.airline.balance,
    reputation: probe.airline.reputation,
    airlineGrade: probe.airline.airlineGrade,
    origin: probe.origin,
    currentCycle: probe.currentCycle,
    seenAt: Date.now(),
  };
  await setKey(KEY, session);
  return session;
}

export async function getSession() {
  return (await getKey(KEY, null));
}

export async function resolveHost() {
  const settings = await loadSettings();
  if (settings.host && settings.host !== "auto") return settings.host;
  const session = await getSession();
  return session?.origin || "https://www.airline-club.com";
}

export async function resolveAirlineId() {
  const settings = await loadSettings();
  if (settings.manualAirlineId && settings.manualAirlineId > 0) return settings.manualAirlineId;
  const session = await getSession();
  return session?.airlineId ?? null;
}
