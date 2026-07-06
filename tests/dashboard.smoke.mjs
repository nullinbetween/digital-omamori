/**
 * Digital Omamori dashboard smoke (v0.3) — runs the dashboard against a real DOM.
 * fetch serves data/*.json; verifies tabs/filter/CRUD/Emergency etc.
 * Run: node tests/dashboard.smoke.mjs
 */
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from '../app/core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(__dir, p), 'utf8');
const docs = {
  '/api/supply': JSON.parse(rd('fixtures/kit.sample.json')), // Frozen fixture, decoupled from demo data
  '/api/facilities': JSON.parse(rd('fixtures/facilities.sample.json')),        // Frozen fixture (decoupled from real demo data)
  '/api/human-verification': JSON.parse(rd('fixtures/human_verification.sample.json')),
  '/api/user-profile': JSON.parse(rd('../data/user_profile.sample.json')),
  '/api/decision-cards': JSON.parse(rd('fixtures/decision_cards.sample.json')),
  '/api/catalog': JSON.parse(rd('../data/supply_catalog.json')),
  '/api/inventory': { logs: [] },
  '/api/demo-locations': JSON.parse(rd('../data/demo_locations.json')),
  '/api/kuji': JSON.parse(rd('../data/kuji.json')),
};
const html = rd('../index.html');
const appBody = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import \* as C from ['"]\.\/app\/core\.js['"];\s*$/m, '');
const htmlNoScript = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');

const dom = new JSDOM(htmlNoScript, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const fakeFetch = async (path, opt = {}) => {
  const p = path.split('?')[0];
  if ((opt.method || 'GET') === 'GET' && docs[p]) return { ok: true, json: async () => docs[p] };
  if (opt.method === 'POST') {
    if (docs[p]) { docs[p] = JSON.parse(opt.body); return { ok: true, json: async () => ({ success: true }) }; }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
globalThis.fetch = fakeFetch;
const ctx = vm.createContext({ window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, C, console, setTimeout, clearTimeout, fetch: fakeFetch, URL });

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.error(`  ✗ ${n}\n      ${e.message}`); } };
const wrap = () => window.document.getElementById('wrap').innerHTML;
// Privacy by design: private data stored in localStorage (no longer POSTed to server). Below we read localStorage to verify.
const lsSupply = () => JSON.parse(window.localStorage.getItem('omamori_supply_v1'));
const lsUser = () => JSON.parse(window.localStorage.getItem('omamori_user_v1'));

console.log('Digital Omamori dashboard smoke (v0.3)\n');
vm.runInContext(appBody, ctx);
const App = window.App;
await new Promise((r) => setTimeout(r, 40));

await (async () => {
  test('Kit tab: stats + inventory cards (Ready Check is now the default tab -> navigate explicitly to kit)', () => {
    App.go('kit');
    const m = wrap();
    // Kit header now shows inventory counts, not a readiness % (the "usable %" was removed to avoid implying false safety — that is Ready Check's job).
    assert.ok(/class="stats"/.test(m) && /Things you have|持/i.test(m), 'kit stats row missing');
    assert.ok(!/\d+%/.test(window.document.querySelector('.stat .v')?.textContent || ''), 'kit header must not show a readiness %');
    assert.ok(/drinking water|Power bank|biscuit/i.test(m), 'supply items not rendered');
  });
  test('not a phone-frame: has .topbar + tab switcher + grid', () => {
    assert.ok(window.document.querySelector('.topbar'), 'no topbar');
    assert.ok(window.document.querySelector('.tabs button'), 'no tab switcher');
    assert.ok(/class="grid"/.test(wrap()), 'no cards grid');
  });
  test('bottom nav (mobile navigation; 07-05): 5 cells = 4 direct + その他, More panel lists 3 pages, switching page auto-collapses panel', () => {
    const bn = window.document.getElementById('bnav');
    assert.ok(bn && bn.querySelectorAll('button').length === 5, 'bottom nav should have 5 cells');
    assert.ok(/More|その他/.test(bn.innerHTML), 'More cell missing');
    const mp = window.document.getElementById('bnav-more');
    assert.ok(mp && mp.querySelectorAll('button').length === 3, 'More panel should list 3 pages');
    App.moreToggle();
    assert.ok(mp.style.display === 'block', 'moreToggle should open the panel');
    App.go('profile');
    assert.ok(mp.style.display === 'none', 'switching page should auto-collapse the panel');
    assert.ok(/on/.test(bn.querySelectorAll('button')[4].className), 'その他 cell should highlight when on a More page');
    App.go('kit');
  });
  test('Kit status filter: selecting missing leaves only missing', () => {
    App.go('kit');
    App.kitStatus('missing');
    const m = wrap();
    assert.ok(/Missing/.test(m), 'missing not shown');
    assert.ok(!/Power bank/i.test(m), 'ready item leaked into missing filter');
    App.kitStatus('all');
  });
  test('Kit search: water filter', () => {
    App.kitQuery('water'); const m = wrap();
    assert.ok(/water/i.test(m) && !/biscuit/i.test(m), 'search filter failed');
    App.kitQuery('');
  });
  test('Nearby View: summary + priority card + facility row', () => {
    App.go('pack'); const m = wrap();
    assert.ok(/Nearest official support points|附近/.test(m), 'summary missing');
    assert.ok(/np-prio/.test(m), 'priority card block missing');
    assert.ok(/np-row/.test(m), 'facility rows missing');
    assert.ok(/麻布地区総合支所/.test(m), 'sample facility missing');
  });
  test('Nearby View elevation card (approach A): your location / shelter elevation + progress bar + no Safe/Danger verdict', () => {
    App.go('pack'); const m = wrap();
    assert.ok(/elev-card/.test(m), 'elevation card missing');
    assert.ok(/\d+(\.\d+)?m</.test(m), 'elevation value missing');
    // 07-04 copy made plainer: defensive "no Safe/Danger verdict" sentence removed, replaced with source note + pointer to Guide; the no-verdict itself is pinned by the negative assert below
    assert.ok(/official GSI data|国土地理院（こくどちりいん）の データ/i.test(m), 'elevation source note missing');
    assert.ok(!/Safe|Danger|安全です|危険です/.test(m), 'must not assert safe/danger');
  });
  test('Nearby View guidance filter: return-home support -> guidance card + find-sign + portal link (not static points)', () => {
    App.go('pack'); App.packType('return_support'); const m = wrap();
    assert.ok(/np-guide/.test(m), 'guidance card missing');
    assert.ok(/city-minato\.my\.site\.com/.test(m), 'portal link missing');
    assert.ok(/Look for this|さがして/.test(m), 'mark cue missing');
    assert.ok(!/np-row/.test(m), 'guidance type should not render static point rows');
    App.packType('all');
  });
  test('Check tab: big ring % readiness + dashboard sections', () => {
    App.go('check'); const m = wrap();
    assert.ok(/big-ring/.test(m), 'readiness big ring missing');
    assert.ok(/--p:\d/.test(m) && /class="bp">\d+%/.test(m), 'ring % missing');
    assert.ok(/Expiring|Low|Missing categories|Local pack/i.test(m), 'check dashboard missing');
  });
  test('Ready-Kuji (disaster-prep fortune): draw button + tier + real % + poem + earthquake tip + safety note', () => {
    App.go('check');
    assert.ok(/kuji-hero/.test(wrap()), 'kuji hero launch missing');  // 07-04: draw button -> mikuji-tube hero (+Lens dual hero)
    App.openKuji();
    const k = window.document.getElementById('kuji').innerHTML;
    assert.ok(/kuji-slip/.test(k), 'kuji slip not rendered');
    assert.ok(/Blessing|吉/.test(k), 'fortune tier missing');
    assert.ok(/%/.test(k), 'readiness % missing');
    assert.ok(/kuji-poem/.test(k), 'poem missing');
    assert.ok(/Disaster tip|防災（ぼうさい）ひとくち/.test(k), 'earthquake tip missing');
    assert.ok(/official guidance|公式（こうしき）の 指示/.test(k), 'safety note missing (do-no-harm)');
    App.closeKuji();
    App.go('kit');
  });
  test('Add modal + scan AI auto-fill populates fields', async () => {
    App.go('kit'); App.openAdd();
    assert.ok(window.document.getElementById('modal-ov').classList.contains('show'), 'modal not open');
    await App.scan();
    assert.equal(window.document.getElementById('m-en').value, 'Long-life emergency bread (sample)');
    assert.equal(window.document.getElementById('m-exp').value, '2027-02-01');
  });
  test('saveItem: CRUD adds one item (after saving to localStorage supply +1, no cloud)', async () => {
    const before = lsSupply().supply_item.length;
    await App.saveItem();
    assert.equal(lsSupply().supply_item.length, before + 1);
    App.go('kit');
  });
  test('Emergency button: opens high-contrast offline screen + caution + kit gap', () => {
    App.openEmergency();
    assert.ok(window.document.getElementById('emergency').classList.contains('show'), 'emergency not shown');
    const m = window.document.getElementById('emergency').innerHTML;
    assert.ok(/class="caution"/.test(m) && /not an official order/i.test(m), 'caution missing');
    assert.ok(/class="kitgap"/.test(m), 'kit gap missing');
    App.closeEmergency();
  });
  test('language lock JA: Emergency caution in Japanese + furigana ruby', () => {
    App.setLang('ja'); App.openEmergency();
    const h = window.document.getElementById('emergency').innerHTML;
    assert.ok(/かないで/.test(h), 'JA caution missing');
    assert.ok(/<ruby>/.test(h), 'furigana ruby not applied');
    App.closeEmergency(); App.setLang('en');
  });
  test('in-Emergency language toggle: toggle button + emerLang->ja redraws card (Japanese + ruby)', () => {
    App.setLang('en'); App.openEmergency();
    assert.ok(/やさしい/.test(window.document.getElementById('emergency').innerHTML), 'emergency lang toggle missing');
    App.emerLang('ja');
    assert.ok(/<ruby>/.test(window.document.getElementById('emergency').innerHTML), 'ja+ruby not applied after emerLang');
    App.closeEmergency(); App.setLang('en');
  });

  /* --- v0.4 matching-engine UI --- */
  test('Recommend tab: coverage % + recommended-list cards + Add to my kit + Extra kit card + ring % + ordering (water first)', () => {
    App.go('recommend'); const m = wrap();
    assert.ok(/Covered/i.test(m), 'coverage stat missing');
    assert.ok(/Drinking water|Power bank/i.test(m), 'recommended rules not rendered');
    assert.ok(/Add to my kit/i.test(m), 'per-gap add action missing');
    assert.ok(/Extra kit items/i.test(m) && /Add extra item/i.test(m), 'Extra kit items free-item entry missing');
    assert.ok(m.indexOf('Drinking water') < m.indexOf('Power bank'), 'card ordering: water should come before power bank (disaster-time priority)');
    assert.ok(/cov-ring/.test(m), 'coverage ring missing');
    assert.ok(/--p:\d/.test(m), 'ring percentage var missing');
    App.go('kit');
  });
  test('Recommend: water out of stock -> Prepare next badge + To prepare quantity', () => {
    App.go('recommend'); const m = wrap();
    assert.ok(/Prepare next/.test(m) && /To prepare/i.test(m), 'prepare-next / to-prepare not shown');
    App.go('kit');
  });
  // The internal rule-matching mechanism is not exposed to the user (it is a Ready Check offset rule, not a category).
  // Old tests (match-ok box / candidate chips / pickRule setting category) were removed with the internal mechanism; now we verify "plain-language readiness label + does not override manual category".
  test('two-layer mechanism (07-04): user selects tools + アルファ米 -> category locked = no cross-category matching (Not counted), category not overridden', () => {
    App.openAdd();
    window.document.getElementById('m-cat').value = 'tools';  // first layer = user's responsibility declaration
    window.document.getElementById('m-ja').value = 'アルファ米 5年保存';
    App.matchName();
    const mb = window.document.getElementById('m-match').innerHTML;
    assert.ok(/Not counted|数（かぞ）えません/.test(mb), 'no rice rule inside tools -> honestly labeled Not counted (does not sneak into food)');
    assert.equal(window.document.getElementById('m-cat').value, 'tools', 'category not overridden');
    App.closeModal();
  });
  test('two-layer mechanism: category=food + アルファ米 -> strong in-category match = silent; switch to other -> free zone clears rule', () => {
    App.openAdd();
    window.document.getElementById('m-cat').value = 'food';
    window.document.getElementById('m-ja').value = 'アルファ米 5年保存';
    App.matchName();
    assert.equal(window.document.getElementById('m-match').innerHTML, '', 'strong match inside food -> silent (confirm row removed)');
    window.document.getElementById('m-cat').value = 'other'; App.catChanged();
    assert.ok(/Not counted|数（かぞ）えません/.test(window.document.getElementById('m-match').innerHTML), 'その他 = free zone -> not counted (user explicitly changed category, old rule yields)');
    App.closeModal();
  });
  test('water container "水タンク" -> readiness labeled "Not counted in Ready Check" (no false drinking-water report) + no chips', () => {
    App.openAdd();
    window.document.getElementById('m-en').value = 'Water Tank 12L';
    window.document.getElementById('m-ja').value = '水タンク';
    App.matchName();
    const mb = window.document.getElementById('m-match').innerHTML;
    assert.ok(/rc-no|Not counted/.test(mb), 'water container should be labeled Not counted in Ready Check');
    assert.ok(!/Drinking water|飲料水|chip-rule/.test(mb), 'water container must not display as drinking water / must not show chips');
    App.closeModal();
  });
  test('Extra kit item (Helmet free item) -> readiness labeled Not counted, no internal matching UI', () => {
    App.openAdd();
    window.document.getElementById('m-en').value = 'Helmet QA';
    App.matchName();
    const mb = window.document.getElementById('m-match').innerHTML;
    assert.ok(/Not counted/i.test(mb), 'extra item should be labeled Not counted in Ready Check');
    assert.ok(!/chip-rule|auto-classified|No auto-match|cert/i.test(mb), 'must not expose internal matching UI');
    App.closeModal();
  });
  test('Ready Check entry (addFromRule) -> modal prefilled + shows "Counts toward Ready Check" + no chips', () => {
    App.addFromRule('water');
    assert.ok(window.document.getElementById('modal-ov').classList.contains('show'), 'modal not open');
    assert.ok(/water/i.test(window.document.getElementById('m-ja').value + window.document.getElementById('m-en').value), 'name not prefilled');
    assert.equal(window.document.getElementById('m-tgt').value, '27', 'personalized target not prefilled');
    const mb = window.document.getElementById('m-match').innerHTML;
    assert.equal(mb, '', 'Ready Check entry = silent even on successful match (07-04)');
    App.closeModal();
  });
  test('addFromRule on-demand item (power_bank=per_household) -> target field blank, not preset to 1 (07-04)', () => {
    App.addFromRule('power_bank');
    assert.equal(window.document.getElementById('m-tgt').value, '', 'on-demand item target should be blank');
    App.closeModal();
  });

  test('Q2 keep-on-ambiguous: item with existing rule renamed to a vague name -> keeps original rule, still counted (rule: no silent clearing)', () => {
    App.setLang('en');
    App.addFromRule('water');  // currentMatch = water rule (strong)
    window.document.getElementById('m-en').value = 'my special bottle thing';
    window.document.getElementById('m-ja').value = '';
    App.matchName();  // vague name, no strong match
    const m = window.App._debugState ? window.App._debugState().currentMatch : null;
    const mb2 = window.document.getElementById('m-match').innerHTML;
    assert.ok(!/Not counted|数えません/i.test(mb2), 'Q2: after vague rename must not be labeled Not counted (original rule preserved = silent)');
    App.closeModal();
  });

  /* --- v0.5 store / profile (Stock fast-log removed in v0.7.6 -> snapshot v0.7.5; core §11 ledger engine kept dormant) --- */
  test('Stock tab removed: tabs exclude stock, cannot navigate to stock', () => {
    assert.ok(!/App\.go\('stock'\)/.test(window.document.getElementById('tabs').innerHTML), 'stock tab still present');
    App.go('stock'); // should not crash (renderMain fallback -> kit)
    assert.ok(/class="grid"/.test(wrap()), 'renderMain fallback broke on unknown tab');
    App.go('kit');
  });
  test('Guide tab: how-to + disaster-prep terms (elevation/shelter) + Our approach (no Safe/Danger verdict)', () => {
    App.go('guide'); const m = wrap();
    assert.ok(/How to use|い方/.test(m), 'how-to section missing');
    assert.ok(/Elevation|海抜/.test(m) && /shelter|避難所/i.test(m), 'keyword section missing');
    assert.ok(/Our approach|考（かんが）え方/.test(m), 'approach section missing');
    assert.ok(/does not (judge|make the final)|判断（はんだん）は しません/.test(m), 'honest-framing (no safe/danger judgment) missing');
    App.go('kit');
  });
  test('Profile tab: family stepper + storage chips + address field (editable)', () => {
    App.go('profile'); const m = wrap();
    assert.ok(/My family|Adults/i.test(m), 'family section missing');
    assert.ok(/stepper/.test(m), 'stepper missing');
    assert.ok(/id="p-address"/.test(m) && !/disabled/.test(m), 'address input should be editable');
    App.go('kit');
  });
  test('saveAddress: writes into user_profile (local localStorage, no cloud)', async () => {
    App.go('profile');
    await App.saveAddress('港区六本木TEST');
    assert.equal(lsUser().user_profile.address, '港区六本木TEST', 'address not saved to localStorage');
    await App.saveAddress(''); // cleanup
    App.go('kit');
  });
  test('Profile: live recommended list (computed from family) + My places "Set place" button + suggestion chips', () => {
    App.go('profile'); const m = wrap();
    assert.ok(/What your household needs/i.test(m), 'live recommended list missing');  // copy finalized 2026-07-02 (was "Your recommended amounts (live)")
    assert.ok(/Set place/i.test(m) && /My places/i.test(m), 'My places / Set place missing');
    assert.ok(/麻布図書館|六本木中学校/.test(m), 'demo location suggestion chips missing');
    App.go('kit');
  });
  test("A' demo location: resolve alias -> set coordinates + demo name (local, no geocoding)", async () => {
    App.go('profile');
    await App.setDemoLocation('麻布図書館');
    const up = lsUser().user_profile;
    assert.ok(up.coords && typeof up.coords.lat === 'number', 'coords not set');
    assert.equal(up.demo_location_name, '港区立麻布図書館', 'demo name not resolved');
    App.go('kit');
  });
  test('Profile family stepper: +1/-1 does not error, profile redraws', () => {
    App.go('profile'); App.fam('familyAdults', 1); App.fam('familyAdults', -1);
    assert.ok(/Adults|My family/i.test(wrap()));
    App.go('kit');
  });
  test('store field: saveItem writes the purchase store (localStorage)', async () => {
    App.openAdd();
    window.document.getElementById('m-ja').value = 'テスト水';
    window.document.getElementById('m-buystore').value = 'テスト商店';
    await App.saveItem();
    assert.ok(lsSupply().supply_item.some(i => i.store === 'テスト商店'), 'store not saved');
  });

  test('Category schema round-trip: dropdown includes toilet/cooking/light/info; selecting toilet does not fall back to water on save (toilet != water)', async () => {
    App.setLang('en'); App.openAdd();
    const sel = window.document.getElementById('m-cat').innerHTML;
    assert.ok(/value="toilet"/.test(sel) && /value="cooking"/.test(sel) && /value="light"/.test(sel) && /value="info"/.test(sel), 'dropdown missing toilet/cooking/light/info');
    window.document.getElementById('m-en').value = 'RT toilet QA';
    window.document.getElementById('m-cat').value = 'toilet';
    assert.equal(window.document.getElementById('m-cat').value, 'toilet', 'toilet cannot be selected (would fall back to water)');
    await App.saveItem();
    assert.ok(lsSupply().supply_item.some(i => i.name_en === 'RT toilet QA' && i.category === 'toilet'), 'toilet category did not round-trip (changed after save)');
  });
  test('D1 field deactivate: non-expiring categories (light) hide expiry date, expiring categories (food/water) show it', () => {
    App.setLang('en'); App.openAdd();  // since 07-04 default category=other (free zone) -> expiry date hidden
    window.document.getElementById('m-cat').value = 'food'; App.catChanged();
    assert.ok(window.document.getElementById('m-exp-row').style.display !== 'none', 'food should show expiry date');
    window.document.getElementById('m-cat').value = 'light'; App.catChanged();
    assert.equal(window.document.getElementById('m-exp-row').style.display, 'none', 'light should hide expiry date (never expires)');
    window.document.getElementById('m-cat').value = 'water'; App.catChanged();
    assert.ok(window.document.getElementById('m-exp-row').style.display !== 'none', 'water should show expiry date');
    App.closeModal();
  });
  test('A/C: new item quantity defaults to 0; water quantity field shows unit (L) + hint', () => {
    App.setLang('en'); App.openAdd();
    assert.equal(window.document.getElementById('m-qty').value, '0', 'C: new item quantity should default to 0');
    App.closeModal();
    App.addFromRule('water');  // water rule -> unit L
    assert.ok(/\(L\)/.test(window.document.getElementById('m-qty-unit').textContent), 'A: water quantity field should show (L)');
    assert.ok(/litres/i.test(window.document.getElementById('m-qty-hint').textContent), 'A: water should have a total-L hint');
    App.closeModal();
  });

  /* --- P1-P3 connection status pill + saved-data mode (real navigator.onLine event + two-layer separation) --- */
  test('Connection pill follows the [button] (saved-data ON -> Offline; OFF -> Online)', () => {
    App.setLang('en');
    App.toggleAiDemo(); // ON
    assert.ok(/Offline/i.test(window.document.getElementById('demo-status-pill-l').innerHTML)
      && window.document.getElementById('demo-status-pill').classList.contains('off'), 'saved-data ON -> pill should be Offline');
    App.toggleAiDemo(); // OFF
    assert.ok(/Online/i.test(window.document.getElementById('demo-status-pill-l').innerHTML)
      && !window.document.getElementById('demo-status-pill').classList.contains('off'), 'saved-data OFF -> pill should be Online');
  });
  test('real connection detection still in the base layer (wired up next phase, not to the pill this time): navigator offline event -> offline banner; saved-data banner independent', () => {
    App.setLang('en'); App.go('kit');
    window.dispatchEvent(new window.Event('offline'));
    assert.ok(/You appear to be offline/i.test(wrap()), 'navigator offline event should trigger offline banner (detection still in base layer)');
    window.dispatchEvent(new window.Event('online'));
    App.toggleAiDemo();
    assert.ok(/Offline mode is ON/i.test(wrap()), 'saved-data banner missing');
    App.toggleAiDemo();
  });
  test('Emergency chip made honest: normal=works offline / saved=using saved data (not hardcoded OFFLINE)', () => {
    App.setLang('en');
    App.openEmergency();
    const norm = window.document.getElementById('emergency').innerHTML;
    assert.ok(/works offline/i.test(norm) && !/OFFLINE ·/.test(norm), 'normal chip should read "works offline", no longer hardcoded "OFFLINE ·"');
    App.closeEmergency();
    App.toggleAiDemo();
    App.openEmergency();
    assert.ok(/Offline mode · using saved data/i.test(window.document.getElementById('emergency').innerHTML), 'saved-data chip missing');
    App.closeEmergency();
    App.toggleAiDemo(); // cleanup
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
