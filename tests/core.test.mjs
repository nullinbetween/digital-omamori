/**
 * Digital Omamori core.js — node unit tests (no deps, no browser).
 * Run: node tests/core.test.mjs   (exit 0 = all green)
 * Covers bug-prone deterministic logic: distance / nearest / slot filling / language locking / required caution / readiness / guard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from '../app/core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const rd = (p) => JSON.parse(readFileSync(join(__dir, p), 'utf8'));
// Since v0.3 the pack is split into data/*.json; here we reassemble it into the pack shape core.js expects (facility/decision_card_template/human_verification).
const _fac = rd('fixtures/facilities.sample.json');        // Frozen fixture: decoupled from demo data (app data now uses real official Minato-ku facilities)
const _cards = rd('fixtures/decision_cards.sample.json');
const _hv = rd('fixtures/human_verification.sample.json');
const pack = {
  facility: _fac.facility,
  decision_card_template: _cards.decision_card_template,
  human_verification: _hv.human_verification,
};
const kit = rd('fixtures/kit.sample.json'); // Frozen fixture: logic tests decoupled from demo data (tests stay stable even after demo data changes)
const catalog = rd('../data/supply_catalog.json').catalog; // v0.4 recommended-list rules
const NOW = C.DEMO_NOW; // pin demo date

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('Digital Omamori core.js — unit tests\n');

/* --- distance / geo --- */
test('haversine: same point = 0', () => {
  assert.equal(C.haversineMeters({ lat: 35.65, lng: 139.73 }, { lat: 35.65, lng: 139.73 }), 0);
});
test('haversine: known distance roughly correct (~157m, +/-20m)', () => {
  // 0.001 lat delta ~= 111m; 0.001 lng delta @35.65N ~= 90m -> hypotenuse ~143-160m
  const d = C.haversineMeters({ lat: 35.6558, lng: 139.7361 }, { lat: 35.6565, lng: 139.7360 });
  assert.ok(d > 60 && d < 100, `got ${d}`);
});
test('walkMinutes: 0m->1 min (minimum 1), 800m->10 min', () => {
  assert.equal(C.walkMinutes(0), 1);
  assert.equal(C.walkMinutes(800), 10);
});
test('formatDistance: language lock (EN has no Japanese / JA has no English phrase)', () => {
  const en = C.formatDistance(320, C.LANG.EN);
  const ja = C.formatDistance(320, C.LANG.JA);
  assert.ok(/min walk/.test(en) && !/徒歩/.test(en), en);
  assert.ok(/徒歩/.test(ja) && !/walk/.test(ja), ja);
});

/* --- nearest support point --- */
test('nearestFacilities: sorted by distance, limit applied', () => {
  const r = C.nearestFacilities(C.DEMO_USER_LOCATION, pack.facility, { limit: 2 });
  assert.equal(r.length, 2);
  assert.ok(r[0].distance_m <= r[1].distance_m);
});
test('pickEmergencySupportPoint: returns the single nearest facility', () => {
  const pick = C.pickEmergencySupportPoint(C.DEMO_USER_LOCATION, pack.facility);
  const all = C.nearestFacilities(C.DEMO_USER_LOCATION, pack.facility);
  assert.equal(pick.facility.facility_id, all[0].facility.facility_id);
});

/* --- language lock --- */

/* --- Decision Card slot filling + required caution --- */
test('fillDecisionCard EN: all slots filled, no leftover {}', () => {
  const t = pack.decision_card_template[0];
  const card = C.fillDecisionCard(t, { area: 'Roppongi-Azabu', nearest_support_point: 'X', distance: '300 m · 4 min walk' }, C.LANG.EN);
  assert.ok(!/\{[a-z_]+\}/.test(card.text), `leftover slot: ${card.text}`);
  assert.ok(card.caution && card.caution.length > 0);
});
test('fillDecisionCard JA: uses mock JA strings, no leftover {}, no English sentence', () => {
  const t = pack.decision_card_template[0];
  const card = C.fillDecisionCard(t, { area: 'ろっぽんぎ', nearest_support_point: '麻布地区総合支所', distance: '300m・徒歩4分' }, C.LANG.JA);
  assert.ok(!/\{[a-z_]+\}/.test(card.text), `leftover slot: ${card.text}`);
  assert.ok(/かないで|案内/.test(card.text), card.text);  // official format: 動（うご）かないで / 案内（あんない）
});
test('fillDecisionCard: missing caution -> throw (responsible AI guardrail)', () => {
  const bad = { template_id: 'x', slots: [], english: 'hi', yasashii_jp: 'hi' };
  assert.throws(() => C.fillDecisionCard(bad, {}, C.LANG.EN), /caution/);
});
test('fillDecisionCard: missing slot -> throw (no silent pass-through)', () => {
  const t = pack.decision_card_template[0];
  assert.throws(() => C.fillDecisionCard(t, { area: 'x' }, C.LANG.EN), /missing slots/);
});
test('buildEmergencyCard: offline full chain produces card + caution + support point', () => {
  const { card, supportPoint, distance_m } = C.buildEmergencyCard({
    user: C.DEMO_USER_LOCATION, pack, lang: C.LANG.EN,
  });
  assert.ok(card.text.length > 0 && card.caution.length > 0);
  assert.ok(supportPoint && supportPoint.facility_id);
  assert.ok(distance_m >= 0);
  assert.ok(card.text.includes(supportPoint.name), 'card should contain the nearest support point name');
});

/* --- Emergency routing kit-gap-aware (v0.2) --- */
test('pickEmergencySupportPoint: no gap -> nearest (shelter 50m beats conv 70m)', () => {
  const user = { lat: 35.0, lng: 139.0 };
  const facs = [
    { facility_id: 's', type: 'shelter', is_official: true, lat: 35.00045, lng: 139.0 },        // ~50m
    { facility_id: 'c', type: 'convenience_support', is_official: false, lat: 35.00063, lng: 139.0 }, // ~70m
  ];
  const pick = C.pickEmergencySupportPoint(user, facs);
  assert.equal(pick.facility.facility_id, 's');
});
test('pickEmergencySupportPoint: water gap -> convenience store weighted, 70m x0.6 beats shelter 50m', () => {
  const user = { lat: 35.0, lng: 139.0 };
  const facs = [
    { facility_id: 's', type: 'shelter', is_official: true, lat: 35.00045, lng: 139.0 },
    { facility_id: 'c', type: 'convenience_support', is_official: false, lat: 35.00063, lng: 139.0 },
  ];
  const pick = C.pickEmergencySupportPoint(user, facs, { gapCategories: new Set(['water']) });
  assert.equal(pick.facility.facility_id, 'c');
});
test('buildEmergencyCarry: shows only owned (ready/low) portable essentials + location; excludes missing/expiring/not_checked/food (canned-tomato bug)', () => {
  const carry = C.buildEmergencyCarry(kit.supply_item, NOW);
  const names = carry.map((c) => c.name_en);
  assert.ok(names.includes('Power bank 10000mAh'), 'should include the owned power bank');
  assert.ok(!names.some((n) => /water|cash|biscuit|medicine|tomato|canned/i.test(n)),
    `missing(water/cash)/expiring(biscuit)/not_checked(medicine)/food must not appear: ${names.join(', ')}`);
  assert.ok(carry.every((c) => c.location !== undefined), 'should carry a location field');
});
test('buildEmergencyCard: returns carry array (not a gap sentence) + no food suggestions + keeps gap-aware routing', () => {
  const r = C.buildEmergencyCard({ user: C.DEMO_USER_LOCATION, pack, supplyItems: kit.supply_item, lang: C.LANG.EN, now: NOW });
  assert.ok(Array.isArray(r.carry), 'r.carry should be an array');
  assert.ok(!r.carry.some((c) => /biscuit|tomato|canned|rice/i.test(c.name_en)), 'Emergency must not suggest food');
  assert.ok(r.gapCategories.has('water'), 'gap-aware routing (pickSupportPoint) preserved');
});

/* --- glossary / verify task / guard --- */
/* --- Emergency Kit DB (supply_item) v0.2 --- */
test('computeSupplyStatus: missing/ready/expiring_soon/not_checked (using sample + DEMO_NOW)', () => {
  const byId = Object.fromEntries(kit.supply_item.map((i) => [i.item_id, i]));
  assert.equal(C.computeSupplyStatus(byId['kit-water-001'], NOW), 'missing');     // q0
  assert.equal(C.computeSupplyStatus(byId['kit-power-001'], NOW), 'ready');        // q1/t1 no expiry
  assert.equal(C.computeSupplyStatus(byId['kit-childfood-001'], NOW), 'expiring_soon'); // 2026-07-05, within 15 days
  assert.equal(C.computeSupplyStatus(byId['kit-medicine-001'], NOW), 'not_checked');    // manual flag preserved
});
test('computeSupplyStatus: expired (injected expiry date)', () => {
  assert.equal(C.computeSupplyStatus({ quantity: 1, targetQuantity: 1, expiryDate: '2026-06-01' }, NOW), 'expired');
});
test('computeSupplyStatus: low (has quantity but below target, no expiry risk)', () => {
  assert.equal(C.computeSupplyStatus({ quantity: 1, targetQuantity: 5 }, NOW), 'low');
});
test('computeKitSummary: percent + grab sorted by urgency + includes ready', () => {
  const s = C.computeKitSummary(kit.supply_item, NOW);
  assert.equal(s.total, 5);
  assert.equal(s.readyCount, 1);            // only power is ready
  assert.equal(s.percent, 20);
  // first grab rank should be <= the rest (expired/missing first)
  for (let i = 1; i < s.grab.length; i++) {
    assert.ok(C.SUPPLY_STATUS_RANK[s.grab[i - 1].status] <= C.SUPPLY_STATUS_RANK[s.grab[i].status]);
  }
  assert.ok(s.grab.some((it) => it.category === 'water' && it.status === 'missing'));
});
test('kitGapCategories: includes water/cash/child, excludes ready power', () => {
  const gaps = C.kitGapCategories(kit.supply_item, NOW);
  assert.ok(gaps.has('water') && gaps.has('cash') && gaps.has('child'));
  assert.ok(!gaps.has('power'));
});
test('guardOutput: strips spuriously triggered medical disclaimer', () => {
  const r = C.guardOutput('Go to the shelter. This is not medical advice. Consult a doctor.', C.LANG.EN);
  assert.equal(r.stripped, true);
  assert.ok(!/medical advice|consult a doctor/i.test(r.text), r.text);
  assert.ok(/shelter/.test(r.text));
});
test('guardOutput: normal disaster-prep string is not wrongly stripped', () => {
  const r = C.guardOutput('Go to the nearest support point if the road is safe.', C.LANG.EN);
  assert.equal(r.stripped, false);
});

/* --- journey structure --- */

/* --- §10 recommended list + scan-matching engine (v0.4 main build (1)) --- */
const FAMILY = kit.family; // {familyAdults:2, familyChildren:1, targetDays:3}
const ruleOf = (id) => catalog.find((r) => r.rule_id === id);

test('resolveTarget: water 3L x 3 people x 3 days = 27L', () => {
  const t = C.resolveTarget(ruleOf('water'), FAMILY);
  assert.equal(t.value, 27);
  assert.equal(t.unit, 'L');
});
test('resolveTarget: staple 1 x 3 people x 3 days x 3 meals = 27 meals', () => {
  assert.equal(C.resolveTarget(ruleOf('food_staple'), FAMILY).value, 27);
});
test('resolveTarget: per_household fixed value (light=1)', () => {
  assert.equal(C.resolveTarget(ruleOf('light'), FAMILY).value, 1);
});
test('resolveTarget: per_infant engine branch still live (synthetic rule; after 07-04 catalog split all sub-items changed to per_household = existence check, not sufficiency check)', () => {
  const synth = { target: { type: 'per_infant', value: 1, unit: '式' } };
  assert.equal(C.resolveTarget(synth, { ...FAMILY, familyInfants: 2 }).value, 2);
  assert.equal(C.resolveTarget(ruleOf('infant_diaper'), { ...FAMILY, familyInfants: 2 }).value, 1, 'infant sub-item = per_household 1 (presence check, quantity not multiplied by infant count)');
});
test('resolveTarget: rounds up (canned 0.5 x3 x3 x3 = 13.5 -> 14)', () => {
  assert.equal(C.resolveTarget(ruleOf('food_canned'), FAMILY).value, 14);
});

test('buildRecommendedList: needs gate — infant/pet not applicable when no infant/pet', () => {
  const list = C.buildRecommendedList(catalog, FAMILY);
  const infant = list.find((r) => r.rule_id === 'infant_milk');
  const pet = list.find((r) => r.rule_id === 'pet_food');
  // 07-04 split contract: infant/pet each have 4 sub-items (presence check only, no quantity-sufficiency check)
  assert.equal(catalog.filter((r) => r.needs === 'has_infant').length, 4);
  assert.equal(catalog.filter((r) => r.needs === 'has_pet').length, 4);
  const water = list.find((r) => r.rule_id === 'water');
  assert.equal(infant.applicable, false, 'infant should not be applicable (no has_infant)');
  assert.equal(pet.applicable, false);
  assert.equal(water.applicable, true);
  assert.ok(list.filter((r) => r.applicable).length < catalog.length);
});
test('buildRecommendedList: familyInfants>0 -> infant applicable + quantity by infant count; =0 -> hidden', () => {
  const withBaby = C.buildRecommendedList(catalog, { ...FAMILY, familyInfants: 2 });
  const infant = withBaby.find((r) => r.rule_id === 'infant_diaper');
  assert.equal(infant.applicable, true);
  assert.equal(infant.target.value, 1, 'infant sub-item = presence check (1 set), not multiplied by infant count (07-04)');
  const noBaby = C.buildRecommendedList(catalog, { ...FAMILY, familyInfants: 0 });
  assert.equal(noBaby.find((r) => r.rule_id === 'infant_diaper').applicable, false, 'no infant -> hidden');
});
test('buildRecommendedList: familyPets>0 -> pet applicable (1 set, not precise); =0 -> hidden', () => {
  const withPet = C.buildRecommendedList(catalog, { ...FAMILY, familyPets: 1 });
  const pet = withPet.find((r) => r.rule_id === 'pet_food');
  assert.equal(pet.applicable, true);
  assert.equal(pet.target.value, 1, 'pet stays 1 set (per_household), not scaled by pet count');
  const noPet = C.buildRecommendedList(catalog, { ...FAMILY, familyPets: 0 });
  assert.equal(noPet.find((r) => r.rule_id === 'pet_food').applicable, false, 'no pet -> hidden');
});

test('matchScanToRule: strong keyword "アルファ米" -> food_staple, auto-classified', () => {
  const m = C.matchScanToRule({ name_ja: 'アルファ米 5年保存' }, catalog);
  assert.equal(m.matched_rule_id, 'food_staple');
  assert.equal(m.confidence, 0.9);
  assert.equal(m.needs_manual_confirm, false);
});
test('matchScanToRule: "保存水 2L" -> water, auto-classified', () => {
  const m = C.matchScanToRule({ name_ja: '保存水 2L', name_en: 'Long-life water 2L' }, catalog);
  assert.equal(m.matched_rule_id, 'water');
  assert.equal(m.needs_manual_confirm, false);
});
test('matchScanToRule: "モバイルバッテリー" -> power_bank, auto-classified', () => {
  const m = C.matchScanToRule({ name_ja: 'モバイルバッテリー 10000mAh' }, catalog);
  assert.equal(m.matched_rule_id, 'power_bank');
  assert.equal(m.needs_manual_confirm, false);
});
test('matchScanToRule: weak single word "缶" -> hits food_canned but needs confirmation (not auto-classified)', () => {
  const m = C.matchScanToRule({ name_ja: '缶' }, catalog);
  assert.equal(m.matched_rule_id, 'food_canned');
  assert.ok(m.confidence < C.AUTO_CONFIRM_THRESHOLD);
  assert.equal(m.needs_manual_confirm, true);
});
test('matchScanToRule categoryLock: レトルト離乳食 + child lock -> infant_food (ends cross-category contamination; 07-04 two-layer mechanism)', () => {
  const m = C.matchScanToRule({ name_ja: 'レトルトパウチ離乳食' }, catalog, { categoryLock: 'child' });
  assert.equal(m.matched_rule_id, 'infant_food');
  const m2 = C.matchScanToRule({ name_ja: 'レトルトパウチ離乳食' }, catalog);  // no lock = old behavior, adult retort wins (keyword 2:1)
  assert.equal(m2.matched_rule_id, 'food_retort');
});
test('matchScanToRule categoryLock=other -> free zone, no matching; water-container guard takes priority over category lock', () => {
  assert.equal(C.matchScanToRule({ name_ja: 'アルファ米' }, catalog, { categoryLock: 'other' }).matched_rule_id, null);
  assert.equal(C.matchScanToRule({ name_en: 'Water Tank 12L' }, catalog, { categoryLock: 'other' }).matched_rule_id, 'water_storage', 'do-no-harm guard is not bypassed by category lock');
});
test('matchScanToRule: no match at all -> null + needs manual selection', () => {
  const m = C.matchScanToRule({ name_ja: 'バナナ', name_en: 'banana' }, catalog);
  assert.equal(m.matched_rule_id, null);
  assert.equal(m.confidence, 0);
  assert.equal(m.needs_manual_confirm, true);
  assert.equal(m.candidates.length, 0);
});
test('matchScanToRule: categoryHint used as tiebreak boost', () => {
  const m = C.matchScanToRule({ name_ja: 'パウチ' }, catalog, { categoryHint: 'food' });
  assert.equal(m.matched_rule_id, 'food_retort'); // レトルト/パウチ
});

test('matchScanToRule: water containers (タンク/ポリタンク/水袋) -> water_storage, never drinking water (do-no-harm guard)', () => {
  for (const scan of [
    { name_en: 'Polyethylene water tank 12L', name_ja: '水タンク' },
    { name_ja: 'ポリタンク' },
    { name_en: 'Foldable water bag', name_ja: '折りたたみ水袋' },
  ]) {
    const m = C.matchScanToRule(scan, catalog);
    assert.equal(m.matched_rule_id, 'water_storage', `should map to water_storage: ${JSON.stringify(scan)}`);
    assert.notEqual(m.matched_rule_id, 'water', `container misclassified as drinking water: ${JSON.stringify(scan)}`);
  }
});

test('computeCoverage: only water container (no drinking water) -> drinking water still missing (container does not falsely report water)', () => {
  const items = [{ name_en: 'Water tank 12L', name_ja: '水タンク', category: 'tools', quantity: 1, targetQuantity: 1, matched_rule_id: 'water_storage' }];
  const cov = C.computeCoverage(items, catalog, FAMILY, NOW);
  assert.ok(cov.missingRules.includes('water'), 'drinking water should still be missing; a container must not count toward drinking water coverage');
});

test('computeCoverage: inventory vs recommended list -> water/cash missing, power covered, percentage reasonable', () => {
  const cov = C.computeCoverage(kit.supply_item, catalog, FAMILY, NOW);
  assert.ok(cov.percent >= 0 && cov.percent <= 100);
  assert.ok(cov.missingRules.includes('water'), 'water should be missing');
  assert.ok(cov.missingRules.includes('cash'), 'cash should be missing');
  const power = cov.rows.find((r) => r.rule_id === 'power_bank');
  assert.equal(power.status, 'covered', 'power bank 1>=1 should be covered');
  assert.ok(cov.applicableCount < catalog.length, 'infant/pet already excluded by needs gate');
});
test('computeCoverage: met target but expiring soon -> covered_expiring (rotation reminder)', () => {
  const items = [{ name_ja: '保存水', category: 'water', quantity: 30, targetQuantity: 27, expiryDate: '2026-07-01', matched_rule_id: 'water' }];
  const cov = C.computeCoverage(items, catalog, FAMILY, NOW);
  const water = cov.rows.find((r) => r.rule_id === 'water');
  assert.equal(water.status, 'covered_expiring');
});
test('computeCoverage: not_checked item -> unknown (unverified does not count as met)', () => {
  const items = [{ name_ja: '救急セット', category: 'medical', quantity: 1, targetQuantity: 1, status: 'not_checked', matched_rule_id: 'medical' }];
  const cov = C.computeCoverage(items, catalog, FAMILY, NOW);
  assert.equal(cov.rows.find((r) => r.rule_id === 'medical').status, 'unknown');
});
// 2026-07-02 approach-A regression net: coverage trusts only the saved matched_rule_id.
// Anything the UI saved as "Not counted" must never be silently re-matched / byCat-counted by the engine (do-no-harm: no false readiness).
test('computeCoverage approach A: Extra item (matched_rule_id=null) never counted — snack bar / helmet not falsely reported', () => {
  const items = [
    { name_en: 'snack bar', category: 'food', quantity: 30, targetQuantity: 1, matched_rule_id: null },   // old bug: 0-keyword ambiguous -> food_nutrition covered
    { name_en: 'Helmet', name_ja: 'ヘルメット', category: 'tools', quantity: 2, targetQuantity: 1, matched_rule_id: null }, // old bug: byCat fallback
  ];
  const cov = C.computeCoverage(items, catalog, FAMILY, NOW);
  for (const r of cov.rows) assert.equal(r.have, 0, `Extra item must not inflate ${r.rule_id} (have=${r.have})`);
  assert.equal(cov.coveredCount, 0);
});
test('computeCoverage approach A: item with saved rule_id is counted as usual (no harm to the normal path)', () => {
  const items = [{ name_en: 'snack bar', category: 'food', quantity: 32, targetQuantity: 1, matched_rule_id: 'food_nutrition' }];
  const cov = C.computeCoverage(items, catalog, FAMILY, NOW);
  assert.equal(cov.rows.find((r) => r.rule_id === 'food_nutrition').status, 'covered');
});

test('scanToSupplyItem: scan + match -> carries matched_rule_id + personalized targetQuantity', () => {
  const scan = { name_ja: '保存水 2L', quantity: 6, expiryDate: '2028-01-01' };
  const m = C.matchScanToRule(scan, catalog);
  const item = C.scanToSupplyItem(scan, m, FAMILY, catalog);
  assert.equal(item.matched_rule_id, 'water');
  assert.equal(item.category, 'water');
  assert.equal(item.targetQuantity, 27);
  assert.equal(C.computeSupplyStatus(item, NOW), 'low'); // 6 < 27, no expiry risk
});

/* --- §11 restock ledger (v0.5 fast log) --- */

/* --- §1 bearing (v0.6 Local Pack A) --- */
test('bearingDeg: due north / due east roughly correct', () => {
  const a = { lat: 35.0, lng: 139.0 };
  assert.ok(Math.abs(C.bearingDeg(a, { lat: 35.01, lng: 139.0 }) - 0) < 2, 'north≈0');
  const e = C.bearingDeg(a, { lat: 35.0, lng: 139.01 });
  assert.ok(e > 88 && e < 92, `east≈90 got ${e}`);
});
test('compass8: degrees -> bearing (language lock)', () => {
  assert.equal(C.compass8(0, 'ja'), '北（きた）');
  assert.equal(C.compass8(90, 'en'), 'E');
  assert.equal(C.compass8(45, 'ja'), '北東（ほくとう）');
  assert.equal(C.compass8(350, 'en'), 'N');
});

/* --- §12 Ready-Kuji (disaster-prep fortune) deterministic --- */
test('readyKujiTier: readiness % -> tier deterministic + never draws a bad omen (minimum = kichi)', () => {
  assert.equal(C.readyKujiTier(95).key, 'daidaikichi');
  assert.equal(C.readyKujiTier(70).key, 'daikichi');
  assert.equal(C.readyKujiTier(50).key, 'chukichi');
  assert.equal(C.readyKujiTier(30).key, 'shoukichi');   // shoukichi
  assert.equal(C.readyKujiTier(0).key, 'kichi');        // 0% is still a good fortune "kichi" (no bad omen)
  assert.ok(C.readyKujiTier(0), 'always has a tier, never undefined');
});
test('drawReadyKuji: % -> tier deterministic (confirmed unchanged) + real gaps (not fabricated)', () => {
  const now = new Date('2026-06-23T00:00:00');
  const items = [
    { item_id: 'a', name_ja: '水', name_en: 'Water', quantity: 0, targetQuantity: 9, category: 'water' },       // missing
    { item_id: 'b', name_ja: 'パン', name_en: 'Bread', quantity: 9, targetQuantity: 9, category: 'food' },       // ready
  ];
  const k = C.drawReadyKuji(items, now);
  assert.equal(k.percent, 50);                       // 1/2 ready
  assert.equal(k.tier.key, 'chukichi');              // % -> tier deterministic
  assert.ok(k.gaps.some((g) => g.name_en === 'Water' && g.need === 9), 'real gap = water short by 9');
  assert.ok(k.strong.some((s) => s.name_en === 'Bread'), 'strength = bread');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
