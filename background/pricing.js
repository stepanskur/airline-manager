// pricing.js — port of com.patson.model.Pricing + flight-type/duration helpers.

export const LinkClass = {
  ECONOMY:  { code: "Y", priceMultiplier: 1, spaceMultiplier: 1,   resourceMultiplier: 1, level: 1 },
  BUSINESS: { code: "J", priceMultiplier: 3, spaceMultiplier: 2.5, resourceMultiplier: 2, level: 2 },
  FIRST:    { code: "F", priceMultiplier: 9, spaceMultiplier: 6,   resourceMultiplier: 3, level: 3 },
};

export const FlightType = {
  SHORT_HAUL_DOMESTIC: "SHORT_HAUL_DOMESTIC",
  MEDIUM_HAUL_DOMESTIC: "MEDIUM_HAUL_DOMESTIC",
  LONG_HAUL_DOMESTIC: "LONG_HAUL_DOMESTIC",
  SHORT_HAUL_INTERNATIONAL: "SHORT_HAUL_INTERNATIONAL",
  MEDIUM_HAUL_INTERNATIONAL: "MEDIUM_HAUL_INTERNATIONAL",
  LONG_HAUL_INTERNATIONAL: "LONG_HAUL_INTERNATIONAL",
  SHORT_HAUL_INTERCONTINENTAL: "SHORT_HAUL_INTERCONTINENTAL",
  MEDIUM_HAUL_INTERCONTINENTAL: "MEDIUM_HAUL_INTERCONTINENTAL",
  LONG_HAUL_INTERCONTINENTAL: "LONG_HAUL_INTERCONTINENTAL",
  ULTRA_LONG_HAUL_INTERCONTINENTAL: "ULTRA_LONG_HAUL_INTERCONTINENTAL",
};

const INTERNATIONAL_PRICE_MULTIPLIER = 1.05;
const INTERCONTINENTAL_PRICE_MULTIPLIER = 1.10;
const BRACKETS = [ [200, 0.25], [800, 0.125], [1000, 0.1], [Number.POSITIVE_INFINITY, 0.05] ];

export function getFlightType(fromAirport, toAirport, distance) {
  const domestic = fromAirport.countryCode && toAirport.countryCode && fromAirport.countryCode === toAirport.countryCode;
  const sameZone = fromAirport.zone && toAirport.zone && fromAirport.zone === toAirport.zone;
  if (domestic) {
    if (distance <= 1000) return FlightType.SHORT_HAUL_DOMESTIC;
    if (distance <= 3000) return FlightType.MEDIUM_HAUL_DOMESTIC;
    return FlightType.LONG_HAUL_DOMESTIC;
  }
  if (sameZone) {
    if (distance <= 2000) return FlightType.SHORT_HAUL_INTERNATIONAL;
    if (distance <= 4000) return FlightType.MEDIUM_HAUL_INTERNATIONAL;
    return FlightType.LONG_HAUL_INTERNATIONAL;
  }
  if (distance <= 2000) return FlightType.SHORT_HAUL_INTERCONTINENTAL;
  if (distance <= 5000) return FlightType.MEDIUM_HAUL_INTERCONTINENTAL;
  if (distance <= 12000) return FlightType.LONG_HAUL_INTERCONTINENTAL;
  return FlightType.ULTRA_LONG_HAUL_INTERCONTINENTAL;
}

export function flightTypeMultiplier(ft) {
  if (ft && ft.includes("INTERCONTINENTAL")) return INTERCONTINENTAL_PRICE_MULTIPLIER;
  if (ft && ft.includes("INTERNATIONAL")) return INTERNATIONAL_PRICE_MULTIPLIER;
  return 1;
}

// Standard ticket price (ECONOMY by default).
export function computeStandardPrice(distance, ft, linkClass = LinkClass.ECONOMY) {
  let remain = distance;
  let price = 100;
  for (const [bucket, rate] of BRACKETS) {
    if (remain <= 0) break;
    if (bucket >= remain) {
      price += remain * rate;
    } else {
      price += bucket * rate;
    }
    remain -= bucket;
  }
  price *= flightTypeMultiplier(ft);
  price *= linkClass.priceMultiplier;
  return Math.round(price * 1.5);
}

// Flight duration in minutes (approx — matches Computation.scala speed brackets).
const SPEED_LIMITS = [ [300, 350], [400, 500], [400, 700] ];
const MAX_FLIGHT_MINUTES = 24 * 60 * 4; // 4 days/week available, per airplane

export function calculateDuration(modelSpeed, distance, category = "REGULAR") {
  const speed = category === "SUPERSONIC" ? Math.round(modelSpeed * 1.5) : modelSpeed;
  let remain = distance;
  let duration = 0;
  for (const [bucket, maxSpeed] of SPEED_LIMITS) {
    if (remain <= 0) break;
    const eff = Math.min(maxSpeed, speed);
    const segment = Math.min(bucket, remain);
    duration += (segment * 60) / eff;
    remain -= bucket;
  }
  if (remain > 0) {
    duration += (remain * 60) / speed;
  }
  return Math.round(duration);
}

export function calculateFlightMinutesRequired(model, distance) {
  const duration = calculateDuration(model.speed, distance, model.category);
  const turnaround = model.turnaroundTime || 70; // sensible default
  return (duration + turnaround) * 2;
}

export function calculateMaxFrequency(model, distance) {
  if (!model || (model.range || 0) < distance) return 0;
  const rt = calculateFlightMinutesRequired(model, distance);
  if (rt <= 0) return 0;
  return Math.floor(MAX_FLIGHT_MINUTES / rt);
}

export { MAX_FLIGHT_MINUTES };
