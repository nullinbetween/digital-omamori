# What is withheld from this showcase — and why

This repository shows the **real server, security hardening, AI proxy design, deterministic-engine API
surface, data schemas and deployment setup** of Digital Omamori (Prototype V12). The parts that carry the
product's know-how are withheld, so the code is intentionally **not runnable as a product**.

| Withheld | What it does (what / why — not how) |
|---|---|
| `index.html` (single-page app) | The complete bilingual UI (English + やさしい日本語 with furigana): Lens capture and point-and-frame flow, Ready Check, Nearby, Emergency Mode, Ready-Kuji, and all UI copy. |
| `app/core.js` implementations | Readiness coverage, target calculation, scan-to-rule matching, Emergency Mode card building, Ready-Kuji tiering, Lens framing geometry. Signatures and contracts are kept in `app/core.js`. |
| Lens and Ready-Kuji prompts | How Gemini is instructed to read a notice, refuse honestly when an image is not a notice, and phrase the omikuji in easy Japanese. |
| Output normalizers | Deterministic schema / length / banned-pattern guards applied to AI output before it reaches the UI. |
| `data/` | The processed facility pack (311 Minato City facilities with elevation), preparedness catalog and rules, decision templates, 20 Ready-Kuji slips, demo seed. Field-shaped samples are in [`schema/`](schema/). |
| `tests/` | 164 automated checks: core engine, dashboard, server, privacy dataflow (fails if household data ever appears in a client request) and vocabulary lint. |

**Included and complete:** `server.py` HTTP layer and hardening (static allowlist, directory-listing 404,
body / image caps, MIME allowlist, rate limiting, explicit AI fallbacks), Gemini client wiring with
`response_schema`, the Lens / Kuji output schemas, `storage.py` (local ↔ GCS), geography helpers
(haversine, walking time, bearing, compass), Emergency Kit status enums, sample data schemas, Dockerfile.

Interested in the full implementation (collaboration, licensing, hiring)?
Contact the author via https://github.com/nullinbetween.
