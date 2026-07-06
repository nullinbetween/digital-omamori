# Digital Omamori

**A local-first disaster decision companion for foreign residents in Japan.**
Bilingual UI — English + やさしい日本語 (Easy Japanese with furigana).

Built for the Google Cloud × Hack2skill Gen AI Academy APAC Edition hackathon — Cohort 2, Track 1: *AI-Powered Decision Intelligence Platform*. Prototype V11.

## Why This Matters

When a disaster hits Japan, many signs, alerts, and official notices are Japanese-first. For the 4M+ foreign residents in the country, readiness is not a calculation problem — it is a **decision problem**: *What does this sign mean? What should I do next? Where do I go when the network is down?*

A parent commuting between Tokyo and Hong Kong, with a child in a Japanese daycare, cannot pause an earthquake to translate a notice or open a spreadsheet of shelter locations. Digital Omamori removes that friction. Point your camera at a Japanese safety sign. Check what your household still needs. Use saved local data for nearby support points, even when live AI is unavailable after load. It turns messy, Japanese-first disaster information into clear, bilingual next steps.

Foreign residents in Japan are a dispersed minority community with shared preparedness barriers, so Digital Omamori works **household by household**. When each household becomes better prepared, the wider community becomes more resilient — self-reliance, one family at a time.

## Demo & Links

- **Live deployment:** https://digital-omamori-554364795398.asia-northeast1.run.app (Cloud Run, asia-northeast1 / Tokyo)
- **GitHub:** `nullinbetween/digital-omamori`
- Run & test locally → [`RUN.md`](./RUN.md) · Deploy → [`DEPLOY_GUIDE.md`](./DEPLOY_GUIDE.md) · Full history → [`CHANGELOG.md`](./CHANGELOG.md)

## Key Capabilities

- **Lens — read the sign, get the action.** Photograph a Japanese disaster notice or safety sticker. Gemini returns *For My Brain* and *For My Action* cards, grounded with saved local data such as nearby support points, water stations, and elevation.
- **Ready Check (備えチェック) — official guidance → your household's targets.** Enter your family size; the app converts public preparedness guidance into concrete stock targets. **Deterministic rules decide what counts as "ready"** — free-form extra items can never inflate the number.
- **Nearby (周辺ビュー) — the map you need, on device.** Nearest evacuation shelters, AEDs, water supply points, and per-facility elevation for any saved place, from local data.
- **Emergency Mode — works when the network is down.** Pulls from saved official local packs: your nearest support point, what to bring, and what to check before you move.
- **Ready-Kuji (御神籤) — a daily readiness habit.** The tier comes from your real readiness. Gemini phrases the message; 20 prewritten slips serve offline.

**Trust boundary:** AI (Gemini) is used only for **perception and expression** — reading signs and phrasing the daily message. Every safety-critical output — household targets, nearby facilities, emergency cards, elevation — comes from **deterministic rules over saved official data**, never from generative AI. On any AI failure, the app falls back to static content instead of blocking the user.

## Architecture

```
User — browser PWA (camera · text · offline-capable once loaded)
  │
  ├── Local-first layer (on device, no network needed after load)
  │     • Private data in localStorage: profile, inventory, saved places, readiness
  │     • Deterministic core (app/core.js): coverage engine, category matching,
  │       decision cards, 20 omikuji slips, 311 facilities, GSI elevation
  │     → facts, numbers, lists, and action cards are deterministic — never AI-invented
  │
  └── Cloud Run — Python container (asia-northeast1)
        ├── Serves the app + public municipal data (no private data is ever received)
        └── Gemini 3.5 Flash on Vertex AI (attached service account — no key in the image)
              • Lens: Japanese sign → native-language summary + easy-Japanese action
              • Ready-Kuji: phrases the daily message (validated to easy-JP + furigana)
```

Three layers of resilience: **Gemini** for multilingual understanding → **Cloud Run** for distribution → a **local deterministic layer** that keeps working with no AI and no network once the page has loaded.

## Engineering Story: An Honest Number Beats a Comfortable One

In a disaster app, the most dangerous bug is not a crash — it is **false reassurance**.

An earlier build's Today ring and omikuji read a kit "usable %" that ignored whether each stocked item actually met its target. It showed **91% ready** while true household coverage was far lower. The root cause was in the demo seed, not the engine: each seeded item's `targetQuantity` had been hand-set equal to its `quantity`, which quietly bypassed the deterministic `resolveTarget(rule, family)` calculation the live add-flow uses — so every stocked item was marked "sufficient" by default.

**V11 fixed it at the data layer, with no change to the coverage logic itself.** The first real-household seed — 22 photographed items across every readiness category (including two expired items, to exercise the rotation reminder) — replaces the MUJI demo dummy, and its targets are computed by the same `resolveTarget` the app uses. Today, omikuji, and Ready Check now all read one `computeCoverage()` number.

The readiness percentage dropped — **honestly**. That is the point: in a preparedness tool, a number that overstates safety is worse than a lower, true one. The fix made the honesty principle structural rather than cosmetic.

Then we removed the number that started it all. Even after the seed fix, My Emergency Kit still carried a percentage of its own — how many logged items were individually "fine". Honest or not, a percentage sitting beside Ready Check's coverage number reads as a *second* answer to "how prepared am I?", and the higher one wins the user's attention. So the kit header dropped its percentage entirely: it now shows plain inventory counts — items on hand, how many are expiring, how many are running low — and Ready Check owns the single readiness number. The lesson generalized: **when a number invites the wrong reading, a count beats a percentage.** A header that reads *"22 items · 2 expiring · a few running low"* cannot be mistaken for *"you are 22% safe."*

## Engineering Highlights

- **Coverage integrity.** Readiness counts only the save-time classification, so free-form "Extra" items can never silently inflate the ready percentage.
- **Two-layer category matching.** User-chosen category → keyword ranking within it, preventing cross-category pollution; over-broad keywords were narrowed (e.g. *watermelon* → water, *toilet paper* → portable toilet).
- **Privacy by design.** Private household data stays in the browser and is never POSTed to the backend; omikuji sends only a coarse readiness tier; Lens sends only the image the user chose. Enforced by an automated **dataflow suite (19 checks)** that fails the build if a private field ever leaves the client.
- **AI output guards.** Omikuji and Lens Japanese are constrained to easy-Japanese with furigana and validated deterministically; any failure falls back to static content.
- **Honest facility data.** The AED open-data source has no English column, so app-generated names live in a separate field with a `＊` label — official names are never overwritten.
- **Server hardening.** Directory listing → 404, static-file allowlist, source paths → 404, body/image size caps, MIME allowlist, per-IP rate limit on AI endpoints.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Single-page PWA (`index.html` + `app/core.js`), service worker |
| Backend | Python container (`server.py`) |
| Model | Gemini 3.5 Flash (Vertex AI) |
| Deployment | Google Cloud Run — `asia-northeast1` (Tokyo) |
| Auth | Attached service account / ADC (no key file in the image) |
| Public data | 311 Minato City facilities + GSI elevation |
| Private data | Browser `localStorage` (never sent to the backend) |
| Quality gates | 108 tests (50 core + 38 dashboard + 20 server) + 19 dataflow + 13 vocab-lint |

## Project Structure

```
digital-omamori/
├── server.py            # Container entry: static serving + AI endpoints + hardening
├── storage.py           # JSON persistence for public data
├── index.html           # Single-page PWA (UI, styles, bootstrap)
├── app/
│   ├── core.js          # Deterministic engine: coverage, matching, omikuji, cards
│   └── favicon.svg / icon-192.png / icon-512.png
├── data/                # Public data: facilities, supply catalog, kuji, rules (JSON)
├── photos/              # Real-household seed item photos
├── tests/               # core / dashboard / server / dataflow / vocab-lint suites
├── Dockerfile · requirements.txt · manifest.json · sw.js
└── RUN.md · DEPLOY_GUIDE.md · STANDARDS.md · CHANGELOG.md
```

## Lessons Learned

- **False reassurance is the bug.** In a preparedness app, an inflated readiness number is more dangerous than an honest low one. We shipped the lower, true number.
- **AI for perception, deterministic code for safety.** Keep Gemini for understanding and expression; keep every safety-critical fact, number, and action card deterministic. Elevation reports facts and never judges "safe" or "dangerous".
- **Privacy is an architecture decision, not a policy line.** Data that never leaves the browser cannot leak — and an automated dataflow test keeps it that way build after build.
- **Generation needs a guardrail.** Constrain AI output to easy-Japanese with furigana and validate it, so a broken generation falls back to safe static content instead of blocking the user.

---

## Data Sources & Attribution

This prototype reorganizes public open data into its own schema (renaming fields, filtering, adding English fallbacks, merging elevation). All entries are **processed derivatives** — in Japanese, *加工して作成*, the wording each provider's terms of use require. None require prior application or an approval number; attribution only.

The Japanese attribution text below is kept verbatim because it is the legally required form of citation; the English line summarizes it for reviewers.

**Minato City Open Data** — evacuation shelters (区民避難所・福祉避難所情報, with official English names & furigana) and AED locations (AED設置場所).

> 出典：港区オープンデータカタログサイト（区民避難所・福祉避難所情報、AED設置場所）https://opendata.city.minato.tokyo.jp/ ／防災データ一覧 https://www.city.minato.tokyo.jp/opendata/bousai/index.html （2026年6月に利用）を加工して作成。港区オープンデータ利用規約（CC BY 4.0 互換）に基づき利用。

*Minato City Open Data, processed. CC BY 4.0 compatible.*

**Tokyo Metropolitan Government Open Data Catalog** — disaster water supply stations (Bureau of Waterworks).

> 出典：東京都水道局「給水拠点一覧データ」（東京都オープンデータカタログサイト）https://catalog.data.metro.tokyo.lg.jp/dataset/t000019d0000000001 （資料日 2025-12-11）を加工して作成。クリエイティブ・コモンズ 表示4.0 国際（CC BY 4.0）で提供されています。

*Tokyo Waterworks via Tokyo OpenData Catalog, processed. CC BY 4.0.*

**Geospatial Information Authority of Japan (GSI)** — per-facility elevation (T.P.), computed from GSI elevation tiles (DEM).

> 標高データ：国土地理院 標高タイル（基盤地図情報 数値標高モデル DEM）を使用。出典：国土地理院（https://maps.gsi.go.jp/development/ichiran.html ）各施設の海抜(T.P.)は同標高タイルより算出（加工して作成）。※ 地理院タイルのリアルタイム利用のため、測量法上の複製・使用承認申請は不要（出典明示のみ）。

*GSI elevation tiles, processed. Attribution only; no survey-act approval required for real-time tile use.*

**Preparedness guidance** — recommended stock amounts are based on public guidance; items without an official per-item source are labeled **"Common preparedness" (一般)** in-app, so official guidance is always distinguished from common practice.

- 内閣府「避難所におけるトイレの確保・管理ガイドライン」(2016) — portable toilet: 5 uses/person/day
- 経済産業省「トイレ備蓄 忘れていませんか」 — 35 uses/person = 7 days
- 首相官邸「災害が起きる前にできること」 · 農林水産省「災害時に備えた食品ストックガイド」 · 東京備蓄ナビ（東京都）

## Version History

| Version | Date | Milestone |
|---------|------|-----------|
| **V11** | 2026-07-06 | Coverage-consistency + first real-household seed (honest readiness numbers). |
| **V10** | 2026-07-04–05 | Mobile UX overhaul; bottom navigation; one-screen Lens camera; language-independent layout; vocabulary-lint suite; English pass over developer-facing docs. |
| **V9** | 2026-06-30–07-02 | Submission/credibility QA + privacy by design: private household data moved to the browser (localStorage), never persisted to the backend. |
| **V8** | 2026-06-30 | Rebrand to Digital Omamori + source-trust badges, citations, full furigana. |
| **V7** | 2026-06-25 | Lens multimodal: photograph a notice → summary + easy-Japanese action, grounded on local data. |
| **V6** | 2026-06-23 | Ready-Kuji (disaster omikuji) + Gemini wiring (gemini-3.5-flash / service-account ADC). |
| **V4–V5** | 2026-06-21 | Coverage-matching engine + all 311 Minato City facilities with real coordinates + GSI elevation. |
| **V1–V3** | 2026-06-20 | Prototype skeleton → real management app (server + JSON CRUD + PWA) → recommendation engine. |

Full day-by-day history is in [`CHANGELOG.md`](./CHANGELOG.md).

## License

App code and UI copy are original work. Facility names, coordinates, and official English names retain the open-data provenance above; do not present processed data as if published by Minato City, the Tokyo Metropolitan Government, or GSI.
