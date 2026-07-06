# Digital Omamori — Working Standards

Operating rules for anyone (human or AI) working on this repo. Written after a
recurring failure mode: *user describes a product-level concept → contributor treats
it as an engineering habit → wrong output → rework.* These rules stop that loop.

---

## 1. Reviewer-facing language standard

This project is submitted to an international hackathon (hack2skill × Google Gen AI
Academy, APAC Edition). **All reviewer-facing documentation must be English-first.**

Use English for:
- README
- RUN / deployment instructions
- CHANGELOG
- architecture notes
- code docstrings that explain the product, architecture, or iteration history
- submission-facing comments and metadata

The app UI itself may remain multilingual:
- English
- やさしい日本語 (easy Japanese)
- Japanese disaster terms with ruby support

Do **not** write prototype history, architecture explanations, or reviewer-facing
documentation only in Chinese or Japanese unless explicitly requested.

---

## 2. Single version — Prototype V11

**Product-owner ruling, 2026-07-02 (overrides the earlier two-track decision); bumped to V10 on 2026-07-05 (mobile UX phase); bumped to V11 on 2026-07-06 (coverage-consistency + honest-seed phase).** The project uses **one** version everywhere: `Prototype V11`.

- **Version label (all files):** `Prototype V11`
  (product-iteration style: each major product/architecture/QA phase = one version; now the 11th phase.)
- **No separate internal `v0.8.x` semver.** Do not introduce or bump an internal build number in headers, footers, console logs, or docstrings.
- **Traceability = dated `CHANGELOG.md` entries.** The date is the marker ("what changed, when"). New CHANGELOG entries go under the current Prototype version with a date; no new `v0.x` row.
- The existing `v0.1 … v0.8.30` rows in `CHANGELOG.md` are kept as a **historical build-log** (not renumbered — that would erase real handoff history). They are history only, not a live versioning scheme.

Rationale: the granular internal semver was a recurring sync tax across ~6 files (index.html header, server.py header, INTERNAL_BUILD const, RUN.md title+footer, CHANGELOG) and a source of stale-number bugs, with no value for a hackathon prototype (evaluators never see it; code never depends on it).

---

## 3. Product interpretation rule

When the user describes a feature, first identify its product layer:
- app-level product architecture
- specific feature behavior
- internal engineering / debug state
- reviewer-facing explanation
- user-facing UI copy

Do **not** collapse app-level product concepts into the nearest technical feature.

Example:
- `Local guidance mode` is **app-level resilience architecture**.
- It is **not** a Lens-only Gemini fallback.

---

## 4. Dropdown / `<select>` labels — 漢字(かな) plain text, NOT ruby

All dropdown / `<select><option>` labels use 漢字 with **half-width** parentheses reading,
e.g. `水(みず)`, `調理(ちょうり)`. **Not ruby. Not full-width （）.**
Reason: HTML `<option>` cannot render `<ruby>`; and `applyRuby` only converts full-width
`漢字（かな）`. Half-width `()` therefore displays as clean plain text in a `<select>`.
Canonical category label set and review are maintained in the project's internal strategy notes.

## 5. Category schema must match the data layer

The item edit form's category dropdown must include **every** category that exists in
`supply_catalog` / inventory. An unknown category must never silently fall back to the first
option (that corrupts data on save). Categories must round-trip: open edit → no change → save
must not change the category. See the 對照表 doc above.

---

*App localization is multilingual. Reviewer-facing documentation is English-first.*
