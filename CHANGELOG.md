# Digital Omamori — Changelog

A local-first disaster decision companion for foreign residents in Japan (EN + やさしい日本語).
Built for Google Cloud × Hack2skill Gen AI Academy APAC (Cohort 2, Track 1).

## Versioning

A single product version, **Prototype V11**, shown in the app subtitle and the `index.html` / `server.py` headers. Each major product/architecture/QA phase increments the version. Detailed changes are tracked by date under the current version; there is no separate internal semver.

## Version history

| Version | Date | Milestone |
|---------|------|-----------|
| **V1** | 2026-06-20 | Prototype skeleton: disaster-supply DB + Prepare/Respond dual track + offline single file. |
| **V2** | 2026-06-20 | Real management app: `server.py` + JSON CRUD + PWA (dropped the phone-frame demo). |
| **V3** | 2026-06-21 | Recommendation / coverage-matching engine (`core.js`) + Recommend tab. |
| **V4** | 2026-06-21 | Official local pack: all 311 Minato City facilities (shelters / AED / water stations) with real coordinates + a MUJI demo inventory. |
| **V5** | 2026-06-22–23 | Inventory expansion + Profile calculator + Nearby view + GSI elevation card + Guide. |
| **V6** | 2026-06-23–25 | Ready-Kuji (disaster omikuji) + full Gemini wiring (gemini-3.5-flash / service-account ADC). |
| **V7** | 2026-06-25–26 | Lens multimodal: photograph a Japanese notice → native-language summary + easy-Japanese action, grounded on local hard data. |
| **V8** | 2026-06-30 | Rebrand to Digital Omamori + source-trust: omamori concept + tagline + pack consent with source-level badges (public guidance / common preparedness / household-specific) + citations; full Japanese furigana. |
| **V9** | 2026-06-30–07-02 | Submission / credibility QA + Privacy by design: internal rule-matching hidden behind plain language; overclaims removed; Guide rewritten; coverage counts only save-time classification (extra items never inflate readiness); **private household data moved to the browser (localStorage), never persisted to the backend**. |
| **V10** | 2026-07-04–05 | Mobile UX overhaul + language-QA close-out: bottom navigation (4 slots + More, phones only); emergency-app header pattern on mobile; one-screen Lens camera on phones (no idle stage, viewport-capped viewfinder with an overlaid shutter — viewfinder, shutter, and zoom always share one screen); language-independent layout anchors (EN ⇄ easy-Japanese with no UI shift); page-by-page copy QA + a vocabulary-lint suite; unified "Offline mode" naming; two-layer item classification; AED English names app-generated with a `＊` label; infant/pet catalog upgraded from official sources. Public-release prep: submission-grade code cleanup (debug logs removed, no raw errors to client, `.dockerignore`, Lens base64 guard) and a full English pass over all developer-facing docs, code comments, and JSON metadata (product Japanese UI, official data, and required open-data attribution kept; internal working notes excluded from the repo). Copy accessibility pass: UI instructions identify buttons by name, never by color alone; internal engineering terms removed from all user-facing copy; a Guide entry explains the color system (red = emergency only, warm gold = AI content that needs a network, purple = saved data that works offline). 108 tests + 19 dataflow + 13 vocab-lint green. |
| **V11** | 2026-07-06 | Coverage-consistency + honest seed (UI/data layer only — no `core.js` / coverage-logic change). First real-household inventory seed: 22 photographed items across all readiness categories (incl. 2 expired items for the rotation reminder) replaces the MUJI demo dummy; seed `targetQuantity` is now the system-computed `resolveTarget(rule, family)` value (it had been hand-seeded equal to quantity, which falsely marked every stocked item "sufficient"). Today ring, disaster-omikuji %, and Ready Check % now all read the same household-coverage number (`computeCoverage`); previously Today and omikuji showed a kit "usable %" that ignored sufficiency and could imply false safety (it read 91% while real coverage was far lower). The app's own add-flow computation is now mirrored in the seed. The My Emergency Kit header then dropped its remaining "usable %" entirely — an inventory-health percentage next to Ready Check's coverage % read as a second, more comfortable answer to "how prepared am I?" — and now shows plain counts (items on hand / expiring / running low), leaving Ready Check as the single readiness number. Profile reorganized for the mobile-primary view: My family and My place stay open at the top (My place moved up beside My family; family steppers are two-per-row on phones) while the longer reference sections collapse, with open state persisted across re-renders. On very narrow phones (iPhone SE and smaller — common among elderly / caregiver users in Japan) the Kit and Ready Check header stats are pinned to two columns instead of collapsing to one. Demo data: a real MUJI 12L water container (`matched_rule_id=water_storage`, outside Ready Check by design — `water_storage` is not a catalog rule) was added to the household seed so the water-station Lens flow can remind the user to bring an empty container; verified to leave the readiness % unchanged (29%). 108 tests + 19 dataflow + 13 vocab-lint green. |

> The detailed day-by-day build log for every phase is preserved in the repository snapshots (`snapshots/`) and is intentionally kept out of this public changelog.

## Architecture & security highlights

- **Three-layer resilience:** Gemini (understanding / multilingual expression, never inventing life-critical facts) → Cloud Run + Storage (distribution) → local deterministic layer (works with no AI or network once the page has loaded: 20 omikuji, decision cards, facilities, elevation).
- **Deterministic core:** facts, numbers, lists, and routing are hardcoded; Gemini only handles understanding and expression. Elevation reports facts only and never judges "safe/danger".
- **Privacy by design:** public municipal data can be served from Cloud Run; private household data (profile, saved places, inventory, readiness) stays in the browser and is never POSTed to the backend. Omikuji sends only a coarse readiness tier; Lens sends only the image the user chose to analyze.
- **Key security:** credentials never enter the repo, HTML, or client; authentication uses ADC / service account / Secret Manager. On Cloud Run no key file is needed (attached service account).
- **Server hardening:** directory listing → 404, static-file allowlist, source paths → 404, body/image size caps, MIME allowlist, per-IP rate limit on AI endpoints.
- **PWA / offline (honest scope):** `sw.js` is self-uninstalling (no caching, so QA never sees a stale build); page-loaded deterministic features work offline, but cold-start offline is deliberately not claimed.

## Notable resolved issues

- **Coverage integrity:** readiness counts only the save-time classification, so free-form "Extra" items can never silently inflate the ready percentage.
- **Category matching:** a two-layer scheme (user-chosen category → keyword ranking within that category) prevents cross-category pollution; over-broad keywords were narrowed and English keywords phrased to avoid false matches (e.g. watermelon → water, toilet paper → portable toilet).
- **Facility English names:** the AED open-data source has no English column, so app-generated names are stored in a separate field and clearly labeled; official names are never overwritten.
- **AI output guards:** omikuji and Lens Japanese are constrained to easy-Japanese with furigana and validated deterministically; on any failure the app falls back to static content, so a broken or unsafe generation never reaches the user.

## Tests

108 tests (50 core + 38 dashboard + 20 server) + 19 privacy-dataflow checks + 13 vocabulary-lint checks. Run with `python3 server.py` for the app and the suites in `tests/` (see `RUN.md`).

## Deployment

- **Live on Cloud Run** (redeployed 2026-07-05): `https://digital-omamori-554364795398.asia-northeast1.run.app` — region `asia-northeast1` (Tokyo), public (`--allow-unauthenticated`), AI enabled via an attached service account (no key file in the image). The URL is stable across revisions; each deploy overwrites the previous revision under the same service name.
- Latest deployed build includes: the English-clean, submission-grade release; **Lens v2** (mobile one-screen camera); and the **field-test copy accessibility pass** (buttons identified by name not color, internal engineering terms removed, Guide color-system entry). Verified on deploy: `/` → 200, `/server.py` → 404 (source not downloadable), `/api/health` → 200 with `ai_enabled: true`.
- Redeploy = re-run `gcloud run deploy --source .` (see `DEPLOY_GUIDE.md`); the same service name overwrites the previous revision.
