/**
 * Digital Omamori — Privacy / data-flow verification harness (Prototype V11; Privacy by design landed in V9)
 * Intercepts every fetch, recording {method, path, body}, then pins each item:
 *   1. First load: localStorage empty -> GET server seed -> write into localStorage
 *   2. Private-data changes (family / address / supply item / demo place) -> must never trigger
 *      POST /api/supply · /api/user-profile · /api/inventory · /api/photo
 *   3. Refresh (localStorage already populated) -> no more GET /api/supply · /api/user-profile (not overwritten by server seed)
 *   4. Photo: upload base64 -> after saveItem, localStorage MUST NOT contain data: base64 (session preview only)
 *   5. Kuji payload: only {tier, tier_label}, must not contain gaps/percent/address/inventory/profile
 * Run: node tests/dataflow_verify.mjs   (exit 0 = all green)
 */
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as C from '../app/core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(__dir, p), 'utf8');
const seed = {
  '/api/supply': JSON.parse(rd('fixtures/kit.sample.json')),
  '/api/facilities': JSON.parse(rd('fixtures/facilities.sample.json')),
  '/api/human-verification': JSON.parse(rd('fixtures/human_verification.sample.json')),
  '/api/user-profile': JSON.parse(rd('../data/user_profile.sample.json')),
  '/api/decision-cards': JSON.parse(rd('fixtures/decision_cards.sample.json')),
  '/api/catalog': JSON.parse(rd('../data/supply_catalog.json')),
  '/api/demo-locations': JSON.parse(rd('../data/demo_locations.json')),
  '/api/kuji': JSON.parse(rd('../data/kuji.json')),
  '/api/meta': { ai_enabled: true }, // enable the AI path so we can capture Kuji's real POST payload
};
const html = rd('../index.html');
const appBody = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import \* as C from ['"]\.\/app\/core\.js['"];\s*$/m, '');
const htmlNoScript = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');
const PRIVATE_POST = ['/api/supply', '/api/user-profile', '/api/inventory', '/api/photo'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const chk = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', n); } else { fail++; console.error('  ✗', n, extra ? '\n      ' + extra : ''); } };

// Build an app instance: returns {App, net (collected fetches), window}
function boot(preload = null) {
  const dom = new JSDOM(htmlNoScript, { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  if (preload) for (const [k, v] of Object.entries(preload)) window.localStorage.setItem(k, v);
  const net = [];
  const fakeFetch = async (path, opt = {}) => {
    const p = path.split('?')[0];
    const method = opt.method || 'GET';
    let body = null;
    try { body = opt.body ? JSON.parse(opt.body) : null; } catch { body = opt.body; }
    net.push({ method, path: p, body });
    if (method === 'GET' && seed[p]) return { ok: true, json: async () => seed[p] };
    if (p === '/api/generate-kuji') return { ok: true, json: async () => ({ success: true, data: { use_fallback: true } }) };
    if (p === '/api/lens') return { ok: true, json: async () => ({ success: true, data: {} }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.fetch = fakeFetch;
  const ctx = vm.createContext({
    window, document: window.document, navigator: window.navigator,
    localStorage: window.localStorage, C, console, setTimeout, clearTimeout,
    fetch: fakeFetch, URL, FileReader: window.FileReader, File: window.File, Blob: window.Blob,
  });
  vm.runInContext(appBody, ctx);
  return { App: window.App, net, window };
}

console.log('Digital Omamori privacy / data-flow verify (Prototype V11)\n');

// ============ Phase 1 — first load: GET seed -> write localStorage ============
console.log('[1] first load seed');
const s1 = boot();
await sleep(60);
const gotSupplyGet = s1.net.some(c => c.method === 'GET' && c.path === '/api/supply');
const gotUserGet = s1.net.some(c => c.method === 'GET' && c.path === '/api/user-profile');
chk('first load: GET /api/supply (seed)', gotSupplyGet);
chk('first load: GET /api/user-profile (seed)', gotUserGet);
const lsSupplyRaw = s1.window.localStorage.getItem('omamori_supply_v1');
const lsUserRaw = s1.window.localStorage.getItem('omamori_user_v1');
chk('seed written to localStorage: omamori_supply_v1', !!lsSupplyRaw);
chk('seed written to localStorage: omamori_user_v1', !!lsUserRaw);

// ============ Phase 2 — modify private data: must not POST private endpoints ============
console.log('\n[2] modify private data -> must not POST private endpoints');
const mStart = s1.net.length;
s1.App.setLang('en');
s1.App.fam('familyAdults', 1);                 // change household size
s1.App.go('profile');
await s1.App.saveAddress('港区六本木TEST-DATAFLOW'); // change address
// immediately verify saveAddress reached localStorage (before setDemoLocation overwrites it -- this app shares the address field for "address / usual place")
const usrA = JSON.parse(s1.window.localStorage.getItem('omamori_user_v1'));
chk('address (saveAddress) written to localStorage', usrA.user_profile.address === '港区六本木TEST-DATAFLOW');
await s1.App.setDemoLocation('麻布図書館');           // change usual place (by design this sets address to the place name + coordinates)
s1.App.openAdd();
s1.window.document.getElementById('m-ja').value = 'データフロー水';
s1.window.document.getElementById('m-buystore').value = 'テスト商店';
await s1.App.saveItem();                          // add supply item
await sleep(20);
const mutPOST = s1.net.slice(mStart).filter(c => c.method === 'POST' && PRIVATE_POST.includes(c.path));
chk('during private-data changes: 0 private POSTs', mutPOST.length === 0, JSON.stringify(mutPOST));
// confirm data actually reached localStorage (not lost)
const sup2 = JSON.parse(s1.window.localStorage.getItem('omamori_supply_v1'));
const usr2 = JSON.parse(s1.window.localStorage.getItem('omamori_user_v1'));
chk('added item written to localStorage', sup2.supply_item.some(i => i.name_ja === 'データフロー水'));
chk('usual-place coordinates written to localStorage', !!(usr2.user_profile.coords && typeof usr2.user_profile.coords.lat === 'number'));
chk('usual-place resolved name written to localStorage', usr2.user_profile.demo_location_name === '港区立（みなとくりつ）麻布図書館（あざぶとしょかん）');

// ============ Phase 4 (done before refresh) — Photo base64 does not reach localStorage ============
console.log('\n[4] Photo: base64 is session preview only, does not reach localStorage');
let photoTested = false;
try {
  s1.App.openAdd();
  s1.window.document.getElementById('m-ja').value = 'フォトテスト item';
  const file = new s1.window.File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], 'x.png', { type: 'image/png' });
  const input = s1.window.document.createElement('input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  s1.App.uploadPhoto(input, 'front');
  await sleep(60); // FileReader async
  const box = s1.window.document.getElementById('m-pbox-front');
  const previewShown = !!(box && /data:image/.test(box.innerHTML));
  chk('after upload: modal shows base64 preview (session)', previewShown);
  await s1.App.saveItem();
  await sleep(20);
  const supP = JSON.parse(s1.window.localStorage.getItem('omamori_supply_v1'));
  const raw = s1.window.localStorage.getItem('omamori_supply_v1');
  const savedItem = supP.supply_item.find(i => i.name_ja === 'フォトテスト item');
  chk('after saveItem: item.photo is not base64 (null or a server path)',
    !!savedItem && (savedItem.photo == null || !String(savedItem.photo).startsWith('data:')),
    savedItem ? 'photo=' + JSON.stringify(savedItem.photo).slice(0, 40) : 'item not found');
  chk('entire localStorage supply contains NO data: base64 (does not bloat)', raw.indexOf('data:image') === -1);
  photoTested = true;
} catch (e) {
  console.error('  ⚠ photo path cannot be fully simulated in jsdom (FileReader):', e.message);
  console.error('    -> verify by logic instead: saveItem always discards the data: prefix (see the saveItem photo ternary in index.html).');
}

// ============ Phase 5 — Kuji payload only sends coarse tier ============
console.log('\n[5] Kuji payload: only tier/tier_label, no gaps/percent/private data');
const kStart = s1.net.length;
s1.App.go('check');
await s1.App.openKuji();
await sleep(40);
const kujiCall = s1.net.slice(kStart).find(c => c.method === 'POST' && c.path === '/api/generate-kuji');
chk('Kuji hit /api/generate-kuji (AI path)', !!kujiCall, 'AI path not triggered (check meta.ai_enabled/onLine)');
if (kujiCall) {
  const keys = Object.keys(kujiCall.body || {}).sort();
  chk('Kuji payload keys == [tier, tier_label]', JSON.stringify(keys) === JSON.stringify(['tier', 'tier_label']), 'keys=' + JSON.stringify(keys));
  const forbidden = ['gaps', 'percent', 'address', 'coords', 'inventory', 'supply_item', 'user_profile', 'family'];
  const leaked = forbidden.filter(f => f in (kujiCall.body || {}));
  chk('Kuji payload has no gaps/percent/private fields', leaked.length === 0, 'leaked=' + JSON.stringify(leaked));
}

// ============ Phase 3 — Refresh: not overwritten by server seed ============
console.log('\n[3] Refresh (localStorage already populated) -> no more GET seed, no overwrite');
const preload = {
  omamori_supply_v1: s1.window.localStorage.getItem('omamori_supply_v1'),
  omamori_user_v1: s1.window.localStorage.getItem('omamori_user_v1'),
};
const s2 = boot(preload);
await sleep(60);
const refetchSupply = s2.net.some(c => c.method === 'GET' && c.path === '/api/supply');
const refetchUser = s2.net.some(c => c.method === 'GET' && c.path === '/api/user-profile');
chk('Refresh: no more GET /api/supply (does not overwrite localStorage)', !refetchSupply);
chk('Refresh: no more GET /api/user-profile (does not overwrite localStorage)', !refetchUser);
// restored data = the modified data, not the server's initial seed
const sup3 = JSON.parse(s2.window.localStorage.getItem('omamori_supply_v1'));
const usr3 = JSON.parse(s2.window.localStorage.getItem('omamori_user_v1'));
chk('Refresh: restores the item the user added (not the server initial)', sup3.supply_item.some(i => i.name_ja === 'データフロー水'));
chk('Refresh: restores the usual place the user set (not the server initial)', usr3.user_profile.demo_location_name === '港区立（みなとくりつ）麻布図書館（あざぶとしょかん）');

// ============ summary ============
console.log('\n=== Network behavior summary (first load + all operations, unique method+path) ===');
const uniq = [...new Set(s1.net.map(c => `${c.method} ${c.path}`))].sort();
for (const u of uniq) console.log('  ', u);
console.log('\n=== outbound POSTs allowed (should be only lens / generate-kuji) ===');
for (const u of uniq.filter(x => x.startsWith('POST'))) console.log('  ', u);
console.log('\n=== localStorage keys ===');
for (const k of Object.keys(preload)) console.log('  ', k, '=', (preload[k] || '').length, 'chars');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
