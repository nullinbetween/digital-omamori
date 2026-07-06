/**
 * Digital Omamori — core.js  (Prototype V11)
 *
 * Deterministic engine (single source of truth): distance / nearest support point / language lock /
 * decision cards / Emergency Kit DB / dashboard filters; the §10 recommended-list + scan-matching engine
 * (resolveTarget, buildRecommendedList, matchScanToRule, computeCoverage, scanToSupplyItem); §12 Ready-Kuji.
 * Matching = keyword hit count + category weighting; low confidence (<0.85) always requires manual
 * confirmation (no silent auto-classification, per responsible AI). Iteration history: see CHANGELOG.md.
 * ---------------------------------------------------------------------------
 * Pure logic layer / SINGLE SOURCE OF TRUTH for deterministic behaviour.
 * This layer has no "appearance": no DOM, no styling. Shared by index.html (browser) and node (test).
 *
 * Responsibility split (hard-coded / Gemini boundary):
 *   - Hard-coded (deterministic, this file): distance, nearest support point, slot filling, language lock, output guard.
 *   - Gemini (presentation layer, wired later): rephrase grounded facts into EN / やさしい日本語.
 *   - The LLM never generates facts. Any text in this file comes from the pack or from grounded constants marked SAMPLE.
 *
 * Important: this file does not modify the canonical pack schema. Anything missing from seed data (see SAMPLE areas)
 * is supplied via clearly marked mocks; the schema is never silently changed.
 */

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

/**
 * Nearest N facilities (deterministic sort). Returns an array of { distance_m, facility }.
 * Does no "route safety" judgement -- that is left to the caution text asking the user to verify themselves (START_HERE dropped escape routes).
 */
export function nearestFacilities(user, facilities, { limit = Infinity } = {}) {
  if (!user) throw new Error('nearestFacilities: missing user location');
  return (facilities || [])
    .filter((f) => typeof f.lat === 'number' && typeof f.lng === 'number')
    .map((f) => ({ facility: f, distance_m: haversineMeters(user, f) }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

/** Categories that make a convenience-store support point (water/toilet/info) worth boosting when there is a consumable gap. */
const CONSUMABLE_GAP_CATS = new Set(['water', 'food', 'child']);
const CONV_BOOST = 0.6; // Convenience-store effective-distance factor (<1 = higher weight)

/**
 * Emergency Mode "nearest support point". Deterministic, kit-gap-aware.
 * - Default: nearest first; official wins on a distance tie.
 * - If the kit has a consumable gap (water/food/child food missing) -> a convenience-store support point that can
 *   provide water gets a higher weight (effective distance x0.6), but a closer official point can still win (weighting, not a hard override).
 * - Promises no safe route; NOT-A-SHELTER is handled by caution.
 * @param opts.gapCategories Set<string> from kitGapCategories()
 * @returns {facility, distance_m, score} | null
 */
export function pickEmergencySupportPoint(user, facilities, { gapCategories = new Set() } = {}) {
  const consumableGap = [...gapCategories].some((c) => CONSUMABLE_GAP_CATS.has(c));
  const ranked = nearestFacilities(user, facilities)
    .map(({ facility, distance_m }) => {
      const boost = consumableGap && facility.type === 'convenience_support' ? CONV_BOOST : 1;
      return { facility, distance_m, score: distance_m * boost };
    })
    .sort((a, b) =>
      a.score - b.score ||
      a.distance_m - b.distance_m ||
      (b.facility.is_official ? 1 : 0) - (a.facility.is_official ? 1 : 0));
  return ranked[0] || null;
}

/* ===========================================================================
 * 2. Decision Card — runtime slot filling (critical: deterministic during a disaster, no API call)
 * ========================================================================= */

/**
 * ⚠️ SAMPLE / MOCK — the seed pack's decision_card_template only has English recommended_action/why/caution,
 * yet the yasashii_jp template references {recommended_action_ja}/{why_ja}/{caution_ja} (not provided by the seed).
 * These やさしい日本語 strings should be the product of "Gemini grounding at rest, stored into the template".
 * The skeleton stage has no Gemini wired in, so grounded MOCKs are supplied here (aligned with the moodboard's JA examples), clearly marked.
 * → Recommendation: add the _ja fields into the canonical decision_card_template. This layer does not silently modify the pack.
 */
export const DECISION_CARD_JA_MOCK = {
  'dc-quake-nearest': {
    recommended_action_ja:
      '道（みち）が 安全（あんぜん）なら、{nearest_support_point}（{distance}）に 行（い）って ください。危（あぶ）ない ときは、その 場（ば）で 待（ま）って ください。',
    why_ja: 'アプリに 保存（ほぞん）して ある 場所（ばしょ）の 中（なか）で、近（ちか）くの 助（たす）けて もらえる 場所（ばしょ）です。',
    caution_ja:
      'まわりの 安全（あんぜん）を 見（み）て ください。道（みち）や 建物（たてもの）が 危（あぶ）ない ときは、無理（むり）に 動（うご）かないで ください。公式（こうしき）の お知（し）らせが ある ときは、その とおりに して ください。',
  },
};

const SLOT_RE = /\{(\w+)\}/g;
function applySlots(tpl, slots) {
  if (typeof tpl !== 'string') return '';
  return tpl.replace(SLOT_RE, (m, key) => (key in slots ? String(slots[key]) : m));
}

/**
 * Fill one runtime decision card. Deterministic: only fills slots, generates no new facts, makes no API call.
 * Hard rule: caution is mandatory -- a missing caution throws (responsible-AI guardrail; no caution-less card reaches the screen).
 *
 * @param template  one decision_card_template from the pack
 * @param slots     { area, nearest_support_point, distance }
 * @param lang      LANG.EN | LANG.JA
 * @returns { lang, action, why, caution, text }
 */
export function fillDecisionCard(template, slots, lang) {
  if (!template) throw new Error('fillDecisionCard: missing template');
  if (!template.caution || !String(template.caution).trim()) {
    throw new Error(`fillDecisionCard: template "${template.template_id}" has no caution (mandatory)`);
  }
  // Verify slots are complete (missing slots are not silently passed through; reported instead)
  const missingSlots = (template.slots || []).filter((s) => !(s in slots));
  if (missingSlots.length) {
    throw new Error(`fillDecisionCard: missing slots [${missingSlots.join(', ')}]`);
  }

  if (lang === LANG.JA) {
    const ja = DECISION_CARD_JA_MOCK[template.template_id];
    if (!ja) throw new Error(`fillDecisionCard: no JA strings for "${template.template_id}"`);
    const action = applySlots(ja.recommended_action_ja, slots);
    const why = applySlots(ja.why_ja, slots);
    const caution = applySlots(ja.caution_ja, slots);
    const text = applySlots(template.yasashii_jp, {
      ...slots,
      recommended_action_ja: action,
      why_ja: why,
      caution_ja: caution,
    });
    return { lang, action, why, caution, text };
  }

  // EN
  const action = applySlots(template.recommended_action, slots);
  const why = applySlots(template.why, slots);
  const caution = applySlots(template.caution, slots);
  const text = applySlots(template.english, {
    ...slots,
    recommended_action: action,
    why,
    caution,
  });
  return { lang, action, why, caution, text };
}

/* Emergency "Bring from your kit" carry-relevant categories: portable / ready-to-use essentials.
 * Emergency does no inventory reminder, only context-aware immediate support.
 * NOT food / toilet / cooking / hygiene / storage -- never tells anyone to carry things like "canned tomatoes". */
export const EMERGENCY_CARRY_CATEGORIES = ['water', 'power', 'light', 'medical', 'cash', 'info', 'child'];
const EMERGENCY_CARRY_RANK = { water: 0, power: 1, light: 2, medical: 3, info: 4, cash: 5, child: 6 };

/** Emergency carry suggestion (deterministic): returns only carry-relevant essentials that are **owned (qty>0) and usable (ready/low)** + location.
 *  Never picks gaps / missing / expiring / not_checked / arbitrary food. No suitable item -> returns [] (frontend shows a fallback message). */
export function buildEmergencyCarry(supplyItems = [], now = new Date(), max = 3) {
  return supplyItems
    .map((it) => ({ it, status: computeSupplyStatus(it, now) }))
    .filter(({ it, status }) =>
      EMERGENCY_CARRY_CATEGORIES.includes(it.category) &&
      Number(it.quantity) > 0 &&
      (status === SUPPLY_STATUS.READY || status === SUPPLY_STATUS.LOW))
    .sort((a, b) => (EMERGENCY_CARRY_RANK[a.it.category] ?? 9) - (EMERGENCY_CARRY_RANK[b.it.category] ?? 9))
    .slice(0, max)
    .map(({ it }) => ({ name_en: it.name_en, name_ja: it.name_ja, location: it.storageLocation || '' }));
}

/**
 * Emergency Mode entry: user location + pack (+ kit) -> runtime decision card.
 * Fully deterministic, offline, no API call, generates no facts. Kit-gap-aware (location + kit gap + nearest support point).
 */
export function buildEmergencyCard({ user, pack, lang, supplyItems = [], scenarioKey = 'earthquake_network_unstable', areaLabel, now = new Date() }) {
  const gapCategories = kitGapCategories(supplyItems, now);
  const pick = pickEmergencySupportPoint(user, pack.facility, { gapCategories });
  if (!pick) throw new Error('buildEmergencyCard: no facility in pack');
  const template = (pack.decision_card_template || []).find((t) => t.scenario_key === scenarioKey);
  if (!template) throw new Error(`buildEmergencyCard: no template for scenario "${scenarioKey}"`);

  // EN card sentences include an English-name fallback (in EN mode, embedding only the kanji name is a dead end for people who cannot read kanji).
  // JA cards keep the official Japanese name; facility-name ruby is never fabricated (trust design, see RUN.md Ruby policy).
  const spName = lang === LANG.JA
    ? pick.facility.name
    : (pick.facility.name_en ? `${pick.facility.name} (${pick.facility.name_en})` : pick.facility.name);
  const slots = {
    area: areaLabel || (lang === LANG.JA ? 'ろっぽんぎ・あざぶ' : 'Roppongi-Azabu'),
    nearest_support_point: spName,
    distance: formatDistance(pick.distance_m, lang),
  };
  const card = fillDecisionCard(template, slots, lang);
  const carry = buildEmergencyCarry(supplyItems, now);
  return { card, supportPoint: pick.facility, distance_m: pick.distance_m, carry, gapCategories };
}

/* ===========================================================================
 * 3. Emergency Kit DB (supply_item) — heart of the Prepare Track (v0.2, restored)
 *    Core of the original DisasterAPP "disaster-supply database"; replaces the old thin readiness checklist.
 *    Facts (expiry/quantity) are grounded, never fabricated; status is computed deterministically from quantity vs target + expiry (hard-coded).
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

const DAY_MS = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
/** Parse YYYY-MM-DD as local 00:00 (avoids timezone off-by-one). */
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }

/**
 * Deterministically compute supply_item status. Hard-coded, no LLM.
 * Rule priority: not_checked (manual flag) -> missing (qty<=0) -> expired -> expiring_soon (<=30d) -> low (qty<target) -> ready.
 * @param item supply_item
 * @param now  Date (injectable for tests; defaults to today)
 */
export function computeSupplyStatus(item, now = new Date()) {
  if (!item) throw new Error('computeSupplyStatus: missing item');
  if (item.status === SUPPLY_STATUS.NOT_CHECKED) return SUPPLY_STATUS.NOT_CHECKED; // not human-verified, cannot infer
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return SUPPLY_STATUS.MISSING;
  if (item.expiryDate) {
    const today = startOfDay(now);
    const exp = startOfDay(parseDate(item.expiryDate));
    const days = Math.round((exp - today) / DAY_MS);
    if (days < 0) return SUPPLY_STATUS.EXPIRED;
    if (days <= EXPIRY_SOON_DAYS) return SUPPLY_STATUS.EXPIRING_SOON;
  }
  if (qty < (Number(item.targetQuantity) || 0)) return SUPPLY_STATUS.LOW;
  return SUPPLY_STATUS.READY;
}

/**
 * Summary of the whole kit (deterministic).
 * @returns { items:[{...item, status}], readyCount, total, percent, grab:[items needing action], byStatus:{...} }
 */
export function computeKitSummary(supplyItems = [], now = new Date()) {
  const items = supplyItems.map((it) => ({ ...it, status: computeSupplyStatus(it, now) }));
  const byStatus = {};
  for (const it of items) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  const readyCount = byStatus[SUPPLY_STATUS.READY] || 0;
  const total = items.length;
  const percent = total ? Math.round((readyCount / total) * 100) : 0;
  // grab list = items needing action (non-ready), sorted by urgency
  const grab = items
    .filter((it) => it.status !== SUPPLY_STATUS.READY)
    .sort((a, b) => SUPPLY_STATUS_RANK[a.status] - SUPPLY_STATUS_RANK[b.status]);
  return { items, readyCount, total, percent, grab, byStatus };
}

/**
 * Set of kit-gap categories (used to weight Emergency routing).
 * Counts only consumable gaps that "affect the next step during a disaster": missing/expired/expiring_soon/low.
 */
export function kitGapCategories(supplyItems = [], now = new Date()) {
  const gapSet = new Set();
  for (const it of supplyItems) {
    const st = computeSupplyStatus(it, now);
    if (st !== SUPPLY_STATUS.READY && st !== SUPPLY_STATUS.NOT_CHECKED) gapSet.add(it.category);
  }
  return gapSet;
}

// ============ §12 Ready-Kuji (防災御神籤) — deterministic fortune-draw engine ============
// Design: tier is determined by the "real supply readiness %" (**not random**, grounded / does not break the moat);
//         always positive (lowest is 末吉, never draws 凶 = positive encouragement, does not scare users off);
//         gaps use the "real" stock gap, never fabricated.
//         Prose (fortune poem) is generated by the UI layer from templates = **offline fallback**; Gemini later only does humanizing "style transfer".
export const READY_KUJI_TIERS = [
  { key: 'daidaikichi', emoji: '🌟', min: 90 }, // 大大吉 (great great blessing)
  { key: 'daikichi',    emoji: '✨', min: 70 }, // 大吉 (great blessing)
  { key: 'chukichi',    emoji: '🍀', min: 50 }, // 中吉 (middle blessing)
  { key: 'shoukichi',   emoji: '🌱', min: 30 }, // 小吉 (small blessing)
  { key: 'kichi',       emoji: '🌤', min: 0  }, // 吉 (blessing) — even the lowest tier is a good fortune; avoids 末吉 to prevent a doom feeling
];
// **% readiness -> luck tier (deterministic, fixed).** Variation comes from the "fortune text", not from tier randomness.
export function readyKujiTier(percent) {
  const p = Number(percent) || 0;
  return READY_KUJI_TIERS.find((t) => p >= t.min) || READY_KUJI_TIERS[READY_KUJI_TIERS.length - 1];
}
/**
 * Disaster-prep fortune draw. Reads real supply readiness -> tier (% -> tier, deterministic) + real gaps + strengths.
 * Returns structured data (no prose, no language); the fortune text (poem + earthquake knowledge) comes from the kuji DB (Gemini can beautify later).
 * @returns { percent, readyCount, total, tier:{key,emoji,min}, gaps:[...], strong:[...], topGap }
 */
export function drawReadyKuji(supplyItems = [], now = new Date()) {
  const summary = computeKitSummary(supplyItems, now);
  const tier = readyKujiTier(summary.percent);
  const need = (it) => Math.max(0, (Number(it.targetQuantity) || 0) - (Number(it.quantity) || 0));
  const gaps = summary.grab.slice(0, 3).map((it) => ({
    name_ja: it.name_ja, name_en: it.name_en, status: it.status,
    category: it.category, need: need(it), unit: it.unit || '',
  }));
  const strong = summary.items
    .filter((it) => it.status === SUPPLY_STATUS.READY)
    .slice(0, 3)
    .map((it) => ({ name_ja: it.name_ja, name_en: it.name_en }));
  return { percent: summary.percent, readyCount: summary.readyCount, total: summary.total, tier, gaps, strong, topGap: gaps[0] || null };
}

/* ===========================================================================
 * 4. Dashboard filters & helpers (v0.3 — for the admin dashboard, deterministic, testable)
 *    Prepare Mode = a Kids-Meal-style management dashboard (search / category / status filter).
 * ========================================================================= */

/** Emergency Kit stock search + category + status filter (returns items with status already computed). */
export function filterSupplyItems(items = [], { query = '', category = 'all', status = 'all' } = {}, now = new Date()) {
  const q = String(query).trim().toLowerCase();
  return items
    .map((it) => ({ ...it, status: computeSupplyStatus(it, now) }))
    .filter((it) => category === 'all' || it.category === category)
    .filter((it) => status === 'all' || it.status === status)
    .filter((it) => !q || `${it.name_en} ${it.name_ja} ${it.category}`.toLowerCase().includes(q));
}

/** Local Pack support-point search + type filter (no route planning, pure data lookup). */
export function filterFacilities(facilities = [], { query = '', type = 'all' } = {}) {
  const q = String(query).trim().toLowerCase();
  return facilities
    .filter((f) => type === 'all' || f.type === type)
    .filter((f) => !q || `${f.name} ${f.english_plain || ''} ${f.official_type_jp || ''}`.toLowerCase().includes(q));
}

/** Missing categories (categories that have a missing/expired item). */
export function kitMissingCategories(items = [], now = new Date()) {
  const s = new Set();
  for (const it of items) {
    const st = computeSupplyStatus(it, now);
    if (st === SUPPLY_STATUS.MISSING || st === SUPPLY_STATUS.EXPIRED) s.add(it.category);
  }
  return [...s];
}

/** Days relative to a date (positive = days in the past, negative = future). */
export function daysSince(dateStr, now = new Date()) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const then = new Date(y, m - 1, d); then.setHours(0, 0, 0, 0);
  return Math.round((startOfDay(now) - then) / DAY_MS);
}

/** Local Pack overview (days since update / count of unverified points) — for the Check dashboard. */
export function localPackInfo(pack, now = new Date()) {
  const facs = pack.facility || [];
  const dates = facs.map((f) => f.last_updated).filter(Boolean).sort();
  const oldest = dates[0] || (pack._meta && pack._meta.generated) || null;
  const unverified = (pack.human_verification || []).filter((h) => h.verification_status !== 'verified');
  return {
    facilityCount: facs.length,
    oldestUpdate: oldest,
    ageDays: oldest ? daysSince(oldest, now) : null,
    unverifiedCount: unverified.length,
    unverified,
  };
}

/* ===========================================================================
 * 5. Output Guard (lock 4: block spurious medical/legal disclaimers; a final pass over output)
 *    Note: lock 3's "language-leak detection" cannot be decided purely by character set given JA/Chinese kanji overlap;
 *    at the skeleton stage all content is curated (no leaks); real leak detection is Gemini's responsibility, stated honestly here.
 * ========================================================================= */
const DISCLAIMER_PATTERNS = [
  /医療(行為|アドバイス|診断)/,
  /医師に(相談|ご相談)/,
  /法律(上の|的)?(助言|アドバイス)/,
  /this is not (medical|legal) advice/i,
  /consult (a|your) (doctor|physician|lawyer)/i,
];

/**
 * Strip out spurious "medical/legal disclaimer" strings. Disaster guidance != medical diagnosis.
 * @returns { text, stripped:boolean, hits:[...] }
 */
export function guardOutput(text, _lang) {
  if (typeof text !== 'string') return { text: '', stripped: false, hits: [] };
  const hits = DISCLAIMER_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  let cleaned = text;
  for (const re of DISCLAIMER_PATTERNS) cleaned = cleaned.replace(new RegExp(re.source, re.flags), '').trim();
  return { text: cleaned.replace(/\s{2,}/g, ' ').trim(), stripped: hits.length > 0, hits };
}

/** Demo user location (Minato-ku Roppongi-Azabu area; earthquake scenario after nursery pickup). SAMPLE coordinates. */
export const DEMO_USER_LOCATION = { lat: 35.6558, lng: 139.7361 };

/** Demo "today" — pinned so kit statuses (expiring_soon, etc.) reproduce consistently in the pitch. Real build uses a live date. */
export const DEMO_NOW = new Date(2026, 5, 20); // 2026-06-20

/* ===========================================================================
 * 6. Recommended list + scan-matching engine (v0.4, main build ①)
 *    Flow: official catalog -> compute personalized target by household -> (show recommended list)
 *          user scans a supply item -> matchScanToRule -> matched_rule_id/confidence/needs_manual_confirm
 *          -> write to stock -> computeCoverage checks "whether the recommended list is already satisfied".
 *    Fully deterministic: matching only looks at keyword/category, no LLM-generated facts.
 *    Responsible AI: low confidence (<AUTO_CONFIRM_THRESHOLD) always requires user confirmation, no auto-classification.
 * ========================================================================= */

/** Confidence threshold: >= allows auto-classification; below always sets needs_manual_confirm. */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

/**
 * Resolve an official catalog rule's target into a concrete quantity based on household meta (deterministic formula, hard-coded).
 * Formula source: reference_stock_rules (water 3L x person x day, food x3 meals, portable toilet x5 uses, ...).
 * @param rule   one catalog entry (includes target:{type,value,unit})
 * @param family { familyAdults, familyChildren, targetDays, has_infant, has_pet }
 * @returns { value:number(rounded up, conservative), unit, type }
 */
export function resolveTarget(rule, family = {}) {
  if (!rule || !rule.target) throw new Error('resolveTarget: rule missing target');
  const adults = Number(family.familyAdults) || 0;
  const children = Number(family.familyChildren) || 0;
  const infants = Number(family.familyInfants) || 0;
  const people = adults + children;
  const days = Number(family.targetDays) || 3;
  const t = rule.target;
  let value;
  switch (t.type) {
    case 'per_person_day':       value = t.value * people * days; break;      // water / dry goods
    case 'per_person_days_meals':value = t.value * people * days * 3; break;  // emergency food (3 meals/day)
    case 'per_person_day_uses':  value = t.value * people * days; break;      // portable toilet (uses)
    case 'per_child':            value = t.value * children; break;          // for children
    case 'per_infant':           value = t.value * infants; break;           // infant supplies (milk/diapers/baby food) = by infant count
    case 'per_household':        value = t.value; break;                     // stove/light etc. (per household)
    default:                     value = t.value;
  }
  return { value: Math.ceil(value), unit: t.unit, type: t.type };
}

/** needs gate: whether rule.needs (has_infant/has_pet) applies to this household. No needs = always applies. */
function _needsApplicable(rule, family) {
  if (!rule.needs) return true;
  if (rule.needs === 'has_infant') return !!family.has_infant || (Number(family.familyInfants) || 0) > 0;
  if (rule.needs === 'has_pet') return !!family.has_pet || (Number(family.familyPets) || 0) > 0;
  return true; // unknown needs are not blocked (conservative: prefer to show)
}

/**
 * Turn the whole catalog into a "personalized recommended list".
 * applicable=false entries (e.g. an infant rule with no infant, or a target that resolves to 0) can be hidden or grayed out by the UI.
 * @returns [{ rule_id, category, name_ja, name_en, target:{value,unit}, needs, applicable, match_keywords, source }]
 */
export function buildRecommendedList(catalog = [], family = {}) {
  return catalog.map((rule) => {
    const target = resolveTarget(rule, family);
    const applicable = _needsApplicable(rule, family) && target.value > 0;
    return {
      rule_id: rule.rule_id,
      category: rule.category,
      name_ja: rule.name_ja,
      name_en: rule.name_en,
      target,
      needs: rule.needs || null,
      applicable,
      match_keywords: rule.match_keywords || [],
      source: rule.source || null,
      note_ja: rule.note_ja || null,   // official advisory reminder line
      note_en: rule.note_en || null,
    };
  });
}

/* --- Scan matching: keyword + category weighting, output carries confidence --- */

/** Flatten the scanned item's matchable text (name_ja/name_en/raw_text/text). */
function _scanText(scan) {
  return [scan.name_ja, scan.name_en, scan.raw_text, scan.text]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Keyword strength: Japanese (non-ASCII) >=2 chars, or English >=4 chars = strong feature; single chars (水/缶/薬) count as weak. */
function _isStrongKw(kw) {
  const s = String(kw);
  const ascii = /^[\x00-\x7f]+$/.test(s);
  return ascii ? s.length >= 4 : s.length >= 2;
}

/**
 * Scanned item -> a rule in the recommended list. Deterministic.
 * Scoring: +1 per matched match_keyword; +1 if category matches. A strong keyword hit raises confidence.
 * Confidence tiers:
 *   0.9  = strong keyword hit AND (leads runner-up by >=1, or the only hit) -> auto-classify
 *   0.65 = has a lead but only via weak keywords -> needs confirmation
 *   0.4  = tied with other rules (ambiguous) -> needs confirmation
 *   0    = no hit at all -> needs confirmation (manual pick)
 * @param scan { name_ja?, name_en?, raw_text?, category? }
 * @param catalog rule[]
 * @param opts.categoryHint category hint from Gemini (optional, used as a tiebreak)
 * @returns { matched_rule_id, confidence, needs_manual_confirm, candidates[], reason }
 */
// 🔴 no-harm guard: a water "container" (タンク/水袋/ポリタンク…) must never be treated as drinking water. Otherwise Ready Check would
//    count the container toward "drinking water 3L/person/day" = falsely reporting "you have N L of water". Containers always map to water_storage (not in catalog -> not in drinking-water coverage).
// "水(（みず）)?タンク" tolerates product names carrying furigana ruby annotations (after seed product names were fully ruby-ized, the guard must not miss them)
const WATER_CONTAINER_RE = /water\s*tank|water\s*container|water\s*bag|foldable\s*water|jerr?y\s*can|water\s*carrier|ポリタンク|給水袋|ウォーター\s*タンク|水(（みず）)?\s*タンク|水容器|折(り)?たたみ.*?(水|タンク|バッグ|袋)|water_storage/i;

export function matchScanToRule(scan, catalog = [], { categoryHint, categoryLock } = {}) {
  if (!scan) throw new Error('matchScanToRule: missing scan');
  // Water-container guard: intercept before matching the generic "water" keyword; map to water_storage, not drinking water.
  // (The no-harm guard takes priority over categoryLock: a container must never falsely report drinking water no matter which category it is placed in.)
  if (WATER_CONTAINER_RE.test(`${scan.name_ja || ''} ${scan.name_en || ''}`)) {
    return { matched_rule_id: 'water_storage', confidence: 0.9, needs_manual_confirm: false, candidates: [], reason: 'water_container_guard' };
  }
  // Two-layer mechanism: layer 1 = category (user picks it themselves = user is responsible; その他 = fully free zone, not matched);
  // layer 2 = the keyword map is ranked only within that category's rules -> structurally ends cross-category contamination (retort baby food -> adult food, pet medicine -> human medicine).
  let pool = catalog;
  if (categoryLock) {
    if (categoryLock === 'other') {
      return { matched_rule_id: null, confidence: 0, needs_manual_confirm: true, candidates: [], reason: 'category_other_free_zone' };
    }
    pool = catalog.filter((r) => r.category === categoryLock);
    if (!pool.length) {
      return { matched_rule_id: null, confidence: 0, needs_manual_confirm: true, candidates: [], reason: 'no_rule_in_category' };
    }
  }
  const text = _scanText(scan);
  const cat = categoryHint || scan.category || null;
  const scored = pool
    .map((rule) => {
      const matched = (rule.match_keywords || []).filter((kw) => text.includes(String(kw).toLowerCase()));
      const strong = matched.some((kw) => _isStrongKw(kw));
      let score = matched.length;
      if (cat && rule.category === cat) score += 1; // category-match weighting
      return { rule, matched, strong, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.strong ? 1 : 0) - (a.strong ? 1 : 0));

  const candidates = scored.slice(0, 3).map((s) => ({
    rule_id: s.rule.rule_id, category: s.rule.category, name_ja: s.rule.name_ja,
    matched: s.matched, score: s.score,
  }));

  if (!scored.length) {
    return { matched_rule_id: null, confidence: 0, needs_manual_confirm: true, candidates: [], reason: 'no_keyword_match' };
  }
  const top = scored[0];
  const second = scored[1];
  const margin = top.score - (second ? second.score : 0);

  let confidence;
  if (top.strong && (margin >= 1 || scored.length === 1)) confidence = 0.9;
  else if (margin >= 1) confidence = 0.65;
  else confidence = 0.4; // tied, ambiguous

  const needs_manual_confirm = confidence < AUTO_CONFIRM_THRESHOLD;
  const reason = needs_manual_confirm ? (margin === 0 ? 'ambiguous_tie' : 'weak_match') : 'confident';
  return { matched_rule_id: top.rule.rule_id, confidence, needs_manual_confirm, candidates, reason };
}

/** Internal: map a stored stock item to a rule_id.
 *  Decision (option A, fixes coverage false-reporting): **trust only the matched_rule_id saved at save time**.
 *  null = Extra kit item = not counted in Ready Check -- fully consistent with the "Not counted" promise the UI shows at save time.
 *  ❌ No post-hoc re-match (ambiguous results would be silently counted, violating the Q2 principle)
 *  ❌ No byCat fallback (a zero-keyword hit could be forced into any rule via same category = false readiness, same as the water-container problem)
 *  Historical note: old behavior once forced 6 long-life bread items into "staple food" via a 0-keyword ambiguous tie. */
function _inferRuleId(item) {
  return item.matched_rule_id || null;
}

/**
 * Auto matching: actual stock vs personalized recommended list -> whether each rule is met.
 * This is the core of "I scan my supplies -> the system judges whether the recommended list is already satisfied".
 * status:
 *   missing          = none at all (have<=0)
 *   partial          = have some but below target
 *   covered          = target met
 *   covered_expiring = met but has expired/expiring items -> rotation still needed
 *   unknown          = has items but includes not_checked (not human-verified, counted as neither met nor missing)
 * @returns { rows[], applicableCount, coveredCount, percent, missingRules[] }
 */
export function computeCoverage(supplyItems = [], catalog = [], family = {}, now = new Date()) {
  const rows = buildRecommendedList(catalog, family)
    .filter((r) => r.applicable)
    .map((rule) => {
      const items = supplyItems.filter((it) => _inferRuleId(it) === rule.rule_id);
      const have = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
      const target = rule.target.value;
      const statuses = items.map((it) => computeSupplyStatus(it, now));
      const anyNotChecked = statuses.includes(SUPPLY_STATUS.NOT_CHECKED);
      const anyExpiring = statuses.some((st) => st === SUPPLY_STATUS.EXPIRED || st === SUPPLY_STATUS.EXPIRING_SOON);
      let status;
      if (have <= 0) status = 'missing';
      else if (have >= target) status = anyExpiring ? 'covered_expiring' : 'covered';
      else status = 'partial';
      if (anyNotChecked && status !== 'missing') status = 'unknown';
      return { ...rule, have, targetValue: target, items, status, anyExpiring };
    });
  const applicableCount = rows.length;
  const coveredCount = rows.filter((r) => r.status === 'covered' || r.status === 'covered_expiring').length;
  const percent = applicableCount ? Math.round((coveredCount / applicableCount) * 100) : 0;
  return {
    rows,
    applicableCount,
    coveredCount,
    percent,
    missingRules: rows.filter((r) => r.status === 'missing').map((r) => r.rule_id),
  };
}

/**
 * Scan + match result -> supply_item draft (for the "scan-to-register" flow writing to stock).
 * targetQuantity uses the personalized target of the matched rule (falls back to the scan's own value or 0 if no match).
 * Does not set status (leaves it to computeSupplyStatus's deterministic inference).
 */
export function scanToSupplyItem(scan, match, family = {}, catalog = [], now = new Date()) {
  const rule = match && match.matched_rule_id ? catalog.find((r) => r.rule_id === match.matched_rule_id) : null;
  const target = rule ? resolveTarget(rule, family).value : (Number(scan.targetQuantity) || 0);
  return {
    item_id: scan.item_id || `scan-${now.getTime()}`,
    name_ja: scan.name_ja || '',
    name_en: scan.name_en || '',
    category: rule ? rule.category : (scan.category || 'other'),
    matched_rule_id: match ? match.matched_rule_id : null,
    match_confidence: match ? match.confidence : 0,
    needs_manual_confirm: match ? match.needs_manual_confirm : true,
    expiryDate: scan.expiryDate || null,
    quantity: Number(scan.quantity) || 0,
    targetQuantity: target,
    storageLocation: scan.storageLocation || null,
    photo: scan.photo || null,
    source: scan._source || 'scan',
  };
}
