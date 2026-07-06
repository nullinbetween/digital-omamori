# Digital Omamori — Run & Test (Prototype V11)

> **A local-first disaster decision companion for foreign residents in Japan** (EN + やさしい日本語 / Easy Japanese with furigana).
> Stack: Python standard-library `http.server` (single-file container, Cloud Run-ready) + vanilla-JS PWA + JSON data + a Gemini AI proxy.
> Versioning: a single product version, **Prototype V11** (V11 = coverage-consistency + honest-seed phase; V10 was the mobile-UX phase). Detailed change history is tracked by date in [`CHANGELOG.md`](./CHANGELOG.md).
> **Architecture — privacy by design:** private household data (inventory, profile, address, saved places, readiness state) is stored in the browser via **localStorage** and is never POSTed back to Cloud Run. The server only serves the static shell, public data packs, read-only seed/demo defaults, and the Gemini Lens proxy.
> Public deployment steps: [`DEPLOY_GUIDE.md`](./DEPLOY_GUIDE.md).

## File structure
```
plainsafe/
├── server.py            # Python web app (Cloud Run: $PORT, plain HTTP): public packs + read-only seed GET + Gemini proxy
├── storage.py           # storage adapter: local fs (dev) <-> GCS bucket (deploy); public/seed only, no private data
├── index.html           # single-file responsive app (7 tabs; public packs via /api/*, private data via localStorage)
├── app/core.js          # pure, testable logic: inventory / coverage matching / distance & bearing / decision cards / language lock / omikuji engine / guards
├── sw.js, manifest.json # PWA (sw.js = self-uninstall, no caching, so QA always gets the latest build)
├── data/                # data: facilities (Minato, 311 points) / elevation (GSI) / supply_items (MUJI demo) / kuji / catalog / profile ...
├── Dockerfile, requirements.txt, .gcloudignore, .gitignore, .dockerignore
└── tests/               # core.test.mjs (node) / dashboard.smoke.mjs (jsdom) / server_smoke.py / dataflow_verify.mjs / vocab_lint.mjs
```

## Run (local dev)
```bash
cd plainsafe
python3 server.py          # http://localhost:8080 (reads $PORT, defaults to 8080)
```
- Seven tabs: Lens · Today · Ready Check · My Emergency Kit · Nearby View · Profile · Guide, plus a red Emergency button (top-right).
- **Private data lives in localStorage** (inventory / profile / address / places / readiness). On first load, if localStorage is empty, the app fetches the seed/demo defaults from the server once, then reads and writes locally only. `data/*.json` serves as the public pack plus read-only seed.
- **AI is OFF by default** (offline fallback). To enable real Gemini, set `ENABLE_AI=1` and Vertex authentication (below).

### Enable real Gemini (Lens / Omikuji)
```bash
ENABLE_AI=1 GEMINI_MODEL=gemini-3.5-flash \
GOOGLE_CLOUD_PROJECT=<your-project> GOOGLE_CLOUD_LOCATION=global \
GOOGLE_GENAI_USE_VERTEXAI=TRUE \
python3 server.py
```
- Authentication uses an attached service account (ADC) on Cloud Run, or `gcloud auth application-default login` locally. **Keys never enter the repo or the container image.**

## Tests (must pass)
```bash
node tests/core.test.mjs         # pure logic (no deps); includes the coverage-integrity regression (Extra items never inflate readiness)
npm install                      # installs jsdom (needed only by the dashboard smoke test)
node tests/dashboard.smoke.mjs   # real DOM: tabs / filters / localStorage access / omikuji / Lens / connection / category render
python3 tests/server_smoke.py    # public GET + private POST rejected (404) + AI fallback + removed-endpoint 404
node tests/dataflow_verify.mjs   # privacy dataflow: no silent client uploads + refresh does not overwrite + base64 not stored + coarse kuji payload
node tests/vocab_lint.mjs        # Easy-Japanese vocabulary lint: banned/ruled-out terms fail the build if they reappear
```
All green = **108 tests** (50 core + 38 dashboard + 20 server) **+ 19 privacy-dataflow checks + 13 vocabulary-lint checks**. `npm test` runs the Node suites in one command.

## AI endpoints — live vs removed (honest labeling)
| Endpoint | Status |
|---|---|
| `/api/lens` | ✅ **Live Gemini 3.5 Flash (multimodal)**: photograph or upload a disaster sign or notice → For My Brain (native-language summary) + For My Action (Easy Japanese) |
| `/api/generate-kuji` | ✅ **Live Gemini 3.5 Flash** (disaster-omikuji: tier is decided deterministically from the real readiness %, always positive) + 20 static fallback fortunes |
| `/api/recognize` · `/api/rephrase` · `/api/decision-card` | ❌ **Removed** (former AI-proxy stubs, unused by the frontend; recognition is handled by Lens, Emergency cards by deterministic templates; these paths now return 404) |
- The frontend only calls endpoints; the **Gemini key stays server-side**. On AI failure, timeout, or offline, the app falls back to deterministic content automatically.

## Privacy by design (reviewer-facing)
> Digital Omamori separates public safety data from private household data.
> Public municipal data — shelters, AEDs, water stations, elevation, and preparedness guidance — can be served from Cloud Run.
> Private household data — family profile, saved places, inventory, and readiness state — stays in the user's browser in this prototype. It is not persisted to the Cloud Run backend.
> For a real release, this would move to secure on-device storage, with export/import backup and optional encrypted cloud sync only after explicit user consent.

**One-liner (pitch):** Public data in the cloud. Private readiness data on device. Gemini assists only where AI adds value.
**Demo privacy note (judging):** Household profile, inventory, and saved places are stored locally in this browser for the prototype. Please use sample details during judging.

Implementation notes:
- Private data flow: `localStorage` (keys `omamori_supply_v1` / `omamori_user_v1`). Empty on first load → GET server seed once → local-only reads/writes after that; never POSTed back.
- Private write endpoints (`POST /api/supply`, `/api/user-profile`, `/api/photo`, `/api/inventory`) are **removed**; `supply` / `user-profile` keep read-only GET seed only.
- Photos: **session preview only** (local preview, no upload, no persisted base64); future = secure on-device (IndexedDB) photo storage.
- Omikuji sends Gemini only a **coarse readiness tier** (no full gaps / percent) — data minimization.
- Lens sends `{image, mime}` only when the user explicitly taps Analyze; it never sends the household profile, address, inventory, or readiness gaps.

## Architecture / security
- **Three-layer resilience:** L1 Gemini (understanding / multilingual / expression — never invents life-critical facts) → L2 Cloud Run + Storage (distribution) → L3 local deterministic (runs with no AI or network **once the page has loaded**: 20 omikuji / decision cards / facilities / elevation; cold-start offline is not claimed).
- **Deterministic core:** facts, numbers, lists, and routing are all hardcoded; Gemini only handles understanding and expression, never fabricating life-critical facts. `fillDecisionCard` throws if a caution is missing; elevation reports facts only and never judges "safe/danger".
- **Key security (hard rule):** keys and credentials never enter the repo, HTML, or client; authentication prefers ADC / service account / Secret Manager.
- **Server hardening:** directory listing → 404, static-file allowlist, source paths such as `/server.py` → 404, body/image size caps, MIME allowlist, per-IP rate limit on AI endpoints. **Private data never touches the server** (see Privacy by design), which removes cross-reviewer data contamination and address-level exposure.
- **PWA / offline scope (honest):** `sw.js` is **self-uninstall** (no caching, so QA never sees a stale build). **Page-loaded resilience:** once the app shell and local pack have loaded, deterministic features keep working with no AI or network; **cold-start offline is deliberately not claimed** in this prototype. The manifest is a PWA-ready shell (mobile layout + icons); a fully installable offline PWA is future infrastructure.
- **Copy accessibility:** UI instructions identify buttons by name, never by color alone (colorblind-safe); colors are reinforcement only — red = Emergency, warm gold = AI content (needs a network), purple = saved data (works offline) — and a Guide entry explains them. Internal engineering terms never appear in user-facing copy. Both rules are enforced by the vocabulary-lint suite, so a regression fails the build.

## Mobile UX (phones, ≤640px — the V10 phase)
- **Bottom navigation:** four direct slots (Lens · Today · Ready Check · Nearby View) plus a "More" panel (Kit / Profile / Guide), all in the thumb zone. The top tab row is desktop-only.
- **Emergency-first header:** centered brand → status caption → one large centered Emergency button → utility pills, modeled on emergency-alert apps (the most critical action gets the most visual weight).
- **One-screen Lens camera:** when idle, no camera stage is rendered — just the intro and two large buttons (Open camera / Upload photo), so the Lens page needs zero scrolling. Opening the camera (or loading a photo) reveals the stage at working size, height-capped to the viewport (~55dvh), with the Scan shutter overlaid inside the frame and the zoom slider just above it — the real-camera-app pattern: viewfinder, shutter, and zoom always share one screen. Desktop keeps the fixed stage and the button row unchanged.
- **Language-independent layout anchors:** switching EN ⇄ Easy Japanese never moves navigation, buttons, or card frames; line heights pre-reserve furigana space, so content may grow inside a card body but the skeleton never jumps.

## Deployment (Cloud Run)
See [`DEPLOY_GUIDE.md`](./DEPLOY_GUIDE.md) (Cloud Shell + `gcloud run deploy --source .`, AI enabled via env vars, authentication via an attached service account).

## Data sources
- `facilities.json` = **official Minato City open data, 311 points** (82 shelters + 226 AEDs + 3 water stations; real coordinates, official categories and English names, `source_year: 2026`).
- `elevation` = **GSI (Geospatial Information Authority of Japan) elevation (T.P., measured)**.
- `supply_items.json` = a MUJI demo inventory (readiness % computed by the coverage-matching engine).
- Source-year single source of truth: facilities = 2026; minor-population distribution = 2020 (never mixed).

— Digital Omamori, Prototype V11 (Python http.server + public pack/seed GET + on-device localStorage for private data + PWA-ready shell + Gemini 3.5 + Cloud Run)
