#!/usr/bin/env node
// Terminology lint (banned terms confirmed in review go into this test net)
// Source of rules = COPY_RULES_yasashii.md + QA_TRACKER 5th-batch decisions. A hit = red. New decisions add a line to BANNED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
let src = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
// Strip comments (historical notes often quote old terms and are not violations): /* */, <!-- -->, line-leading //, in-line " // "
src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
         .replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const BANNED = [
  [/パック/, 'パック (engineering term; 07-04 retired -> 保存して ある 地域データ)'],
  [/そろって います/, '「そろって います」 (state phrase: no space before います per 07-04 -> そろっています)'],
  [/local pack/i, '"local pack" (-> saved local data)'],
  [/[Ss]aved-data mode/, '"saved-data mode" (-> offline demo; 07-04 approach A)'],
  [/公的/, '「公的」 (banned site-wide 07-03)'],
  [/達成率/, '「達成率」 (-> そろい具合)'],
  [/そろった 割合/, '「そろった 割合」 (-> そろい具合; 07-04)'],
  [/field check|か所（しょ）確認待/, 'field check / ◯か所確認待ち (internal QA concept not exposed; the row 確認済/確認待 chip = separate case pending decision)'],
  [/ましょう/, '「ましょう」 sentence ending (banned site-wide; sole exception = kuji.json No.9, not in this file)'],
  [/用意（ようい）する もの/, '「用意する もの」 stat label (-> まだ ない もの)'],
  [/行動（こうどう）カード|行動カード|action cards?/i, '行動カード / "action cards" (internal component name never shown in the UI; 07-05 -> 次に できる こと / what to do now)'],
  [/deterministic/i, '"deterministic" in user-facing copy (engineering term; 07-05; code comments are stripped before this check)'],
  [/赤（あか）い ボタン|red button|[Ll]avender parts/, 'color-as-UI-pointer (07-05 accessibility ruling: instructions never identify app UI by color — use the button name; the Guide 「色の意味」 design note is the single sanctioned place for color talk; physical-world descriptions like the yellow sticker are exempt)'],
];
let bad = 0, ok = 0;
for (const [re, name] of BANNED) {
  const m = src.match(new RegExp(re.source, re.flags.replace('g','') + 'g'));
  if (m) { bad++; const i = src.search(re); const ln = src.slice(0, i).split('\n').length;
    console.log(`  ✗ ${name} — ${m.length} occurrence(s) (first seen near source line ${ln})`);
  } else { ok++; console.log(`  ✓ banned term not present: ${name}`); }
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
