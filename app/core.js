/**
 * Digital Omamori — core.js (Prototype V12) · PUBLIC SHOWCASE EDITION
 *
 * Copyright (c) 2026 Meredith Cheung (nullinbetween). All rights reserved.
 * Source-visible for reference only — see LICENSE. Not open source.
 *
 * The deterministic engine is the single source of truth for everything safety-critical:
 * distance and direction, nearest support point, decision cards, Emergency Kit status,
 * readiness coverage, scan-to-rule matching, Ready-Kuji tier and Lens framing geometry.
 * No DOM, no styling, no AI: the LLM never generates facts.
 *
 * This edition keeps the public API surface (every exported function, with its contract)
 * and the generic geography helpers. Engine implementations are withheld — see WITHHELD.md.
 */

const WITHHELD = 'Withheld from the public showcase. See WITHHELD.md.';

export const LANG = { EN: 'en', JA: 'ja' };

/* ===========================================================================
 * 1. Distance / geography (deterministic, hard-coded)
 * ========================================================================= */

const R_EARTH_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance between two coordinates (meters). Haversine. */
export function haversineMeters(a, b) {
  if (!a || !b) throw new Error('haversineMeters: missing point');
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Meters -> walking minutes (adult ~80 m/min, always rounded up, minimum 1 min). Deterministic. */
export function walkMinutes(meters) {
  return Math.max(1, Math.ceil(meters / 80));
}

/** Human-readable distance format (language lock: separate EN / JA strings, no language mixing). */
export function formatDistance(meters, lang) {
  const min = walkMinutes(meters);
  const m = Math.round(meters);
  const dist = m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
  if (lang === LANG.JA) return `${dist}・徒歩（とほ）${min}分（ふん）`;
  return `${dist} · ${min} min walk`;
}

/** Bearing from a to b (degrees, 0=north, clockwise). Deterministic. */
export function bearingDeg(a, b) {
  if (!a || !b) return 0;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS8 = { en: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], ja: ['北（きた）', '北東（ほくとう）', '東（ひがし）', '南東（なんとう）', '南（みなみ）', '南西（なんせい）', '西（にし）', '北西（ほくせい）'] };
/** Bearing -> 8-point compass label (language lock). */
export function compass8(deg, lang = 'en') {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return (COMPASS8[lang] || COMPASS8.en)[idx];
}


/* ===========================================================================
 * Emergency Kit status enums (public schema)
 * ========================================================================= */
export const SUPPLY_STATUS = {
  READY: 'ready', LOW: 'low', EXPIRING_SOON: 'expiring_soon',
  EXPIRED: 'expired', MISSING: 'missing', NOT_CHECKED: 'not_checked',
};
// Urgency ordering (high -> low): items needing more action rank first
export const SUPPLY_STATUS_RANK = {
  expired: 0, missing: 1, expiring_soon: 2, low: 3, not_checked: 4, ready: 5,
};
export const EXPIRY_SOON_DAYS = 30;

/* ===========================================================================
 * Engine API — implementations withheld
 * ========================================================================= */

/** Nearest facilities to the user, deterministically sorted. @returns [{ facility, distance_m }] */
export function nearestFacilities(user, facilities, options = {}) { throw new Error(WITHHELD); }

/** Choose the single support point to show in Emergency Mode, aware of the household's kit gaps. @returns { facility, distance_m, score } | null */
export function pickEmergencySupportPoint(user, facilities, options = {}) { throw new Error(WITHHELD); }

/** Fill a decision-card template with grounded slot values (language-locked EN / easy-JA). @returns { lang, action, why, caution, text } */
export function fillDecisionCard(template, slots, lang) { throw new Error(WITHHELD); }

/** What to carry right now: only owned and usable essentials, never gaps or arbitrary items. @returns supply_item[] */
export function buildEmergencyCarry(supplyItems, now, max) { throw new Error(WITHHELD); }

/** Fully offline Emergency Mode card: location + nearest support point + kit-aware carry list. */
export function buildEmergencyCard(params) { throw new Error(WITHHELD); }

/** Deterministic item status from quantity vs target and expiry. @returns one of SUPPLY_STATUS */
export function computeSupplyStatus(item, now) { throw new Error(WITHHELD); }

/** Inventory summary as plain counts (items on hand, expiring, low). */
export function computeKitSummary(supplyItems, now) { throw new Error(WITHHELD); }

/** Categories with consumable gaps that affect the next step in a disaster. @returns Set<string> */
export function kitGapCategories(supplyItems, now) { throw new Error(WITHHELD); }

/** Readiness -> omikuji tier (fixed, deterministic; variation comes from the text, not the tier). */
export function readyKujiTier(percent) { throw new Error(WITHHELD); }

/** Draw today's Ready-Kuji from real readiness. @returns { percent, tier, gaps, strong, topGap } */
export function drawReadyKuji(supplyItems, now) { throw new Error(WITHHELD); }

/** Emergency Kit search + category + status filter. */
export function filterSupplyItems(items, filters, now) { throw new Error(WITHHELD); }

/** Local-pack support-point search + type filter (pure lookup, no route planning). */
export function filterFacilities(facilities, filters) { throw new Error(WITHHELD); }

/** Categories that currently contain a missing or expired item. */
export function kitMissingCategories(items, now) { throw new Error(WITHHELD); }

/** Days relative to a date (positive = past). */
export function daysSince(dateStr, now) { throw new Error(WITHHELD); }

/** Local-pack freshness overview for the Check dashboard. */
export function localPackInfo(pack, now) { throw new Error(WITHHELD); }

/** Deterministic output guard for displayed text. @returns { text, stripped, hits } */
export function guardOutput(text, lang) { throw new Error(WITHHELD); }

/** Preparedness rule + family profile -> concrete household target (conservative rounding). @returns { value, unit, type } */
export function resolveTarget(rule, family) { throw new Error(WITHHELD); }

/** Build the household's recommended list from the preparedness catalog. */
export function buildRecommendedList(catalog, family) { throw new Error(WITHHELD); }

/** Match a scanned / typed item to a catalog rule; low confidence always requires manual confirmation. */
export function matchScanToRule(scan, catalog, options = {}) { throw new Error(WITHHELD); }

/** The one readiness number: household coverage against applicable rules. @returns { rows, applicableCount, coveredCount, percent, missingRules } */
export function computeCoverage(supplyItems, catalog, family, now) { throw new Error(WITHHELD); }

/** Convert a confirmed scan + rule match into a supply_item record. */
export function scanToSupplyItem(scan, match, family, catalog, now) { throw new Error(WITHHELD); }

/** Lens point-and-frame: crop rectangle around a tapped point. @returns { x, y, w, h, tooSmall } */
export function computeLensCrop(params) { throw new Error(WITHHELD); }

/** Lens: viewfinder aim frame -> normalized image rectangle. */
export function lensAimToNormRect(params) { throw new Error(WITHHELD); }

/** Lens: normalized rectangle -> pixel crop on the captured image. @returns { x, y, w, h, tooSmall } */
export function lensCropRect(params) { throw new Error(WITHHELD); }
