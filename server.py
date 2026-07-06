#!/usr/bin/env python3
"""
Digital Omamori — server.py
Local-first disaster-prep web app. Python stdlib http.server, Cloud Run-ready.

=== Version: Prototype V11 ===
(Hackathon-1 agent.py style: each major product/architecture/QA phase = one version; now 11th phase.
 Single version — no separate internal semver; V11 bump 2026-07-06 (was V10 2026-07-05). Change history is date-stamped in CHANGELOG.md.)
  V11 — Coverage-consistency + honest seed (2026-07-06): real-household seed (22 items) with
        targetQuantity via resolveTarget(); Today ring / omikuji / Ready Check all read one
        household-coverage %; UI/data only, no core.js change. 108 tests + 13 vocab-lint + 19 dataflow.
  V10 — Mobile UX overhaul + language QA close-out: bottom navigation (4 slots + More panel,
        phones only); emergency-app header pattern on mobile; language-independent layout
        anchors (EN ⇄ easy-Japanese no UI shift); page-by-page copy QA + vocab lint suite;
        "Offline mode" naming unified; two-layer item classification; AED English names
        app-generated with ＊ labeling. 108 tests + 10 vocab-lint + 19 dataflow checks.
  V9 — Submission / credibility QA: "Local guidance mode" (app-level resilience, not an error);
       internal rule-matching hidden -> plain-language "Counts toward Ready Check";
       empty water container != drinking water (no false coverage); overclaims removed;
       Guide rewritten; Ready Check = primary add-entry + Extra kit; Babies/Pets gating;
       full Japanese furigana. Coverage counts only save-time classification
       (extra items never inflate readiness). 99 tests + 19 privacy dataflow checks.
  V8 — Rebrand to Digital Omamori + source trust: omamori concept + tagline;
       pack consent + source-level badges (public guidance / common preparedness /
       household-specific) + citations.
  V7 — Lens multimodal: photo/upload a Japanese notice -> native-language summary +
       easy-Japanese action, grounded on local hard data.
  V6 — Ready-Kuji (disaster omikuji) + full Gemini wiring: google-genai +
       gemini-3.5-flash + service-account ADC.
  V5 — Inventory expansion + Profile calculator + Nearby view + Guide draft.
  V4 — Real official local pack: all 311 Minato-ku facilities (shelters/AED/water
       stations) + GSI elevation.
  V3 — Recommendation/coverage engine (core.js §10): scan -> matched_rule +
       personalized target + Ready Check.
  V2 — Real management app: server.py + JSON CRUD + PWA (offline shell); dropped
       phone-frame demo.
  V1 — prototype skeleton: disaster-supply DB + Emergency decision
       cards + Prepare/Respond dual track.

Design:
  - Cloud Run: listen on $PORT, plain HTTP, bind 0.0.0.0 (TLS handled by the Cloud Run edge; no self-signed certs).
  - Read-only JSON entities served at /api/<entity> GET (storage.py: local fs <-> GCS).
  - AI proxy (/api/lens, /api/generate-kuji) is server-side only; the frontend never sees the key.
    dev / AI-off -> sample or use_fallback; AI on -> real Gemini (Vertex ADC).
    Auth prefers ADC / service account; an API key is only a temporary demo fallback, kept in env, never in repo/HTML/client.
  - Abuse guards: body size cap / image size cap / allowed MIME / simple rate limit / error -> mock fallback.
"""
import json
import os
import re
import time
import base64
from collections import defaultdict, deque
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import storage

PORT = int(os.environ.get('PORT', '8080'))
APP_NAME = 'Digital Omamori'

# --- Read-only GET entities (public packs + seed/demo defaults). Private data lives in the browser's localStorage; the server never writes it. ---
# supply / user-profile are kept as read-only seed defaults: the frontend GETs them once on first load (empty localStorage), then reads/writes locally.
ENTITIES = {
    'supply': 'supply_items.json',
    'facilities': 'facilities.json',
    'human-verification': 'human_verification.json',
    'user-profile': 'user_profile.sample.json',
    'decision-cards': 'decision_card_templates.json',
}

ENTITY_DEFAULTS = {
    'supply': {'supply_item': [], 'family': None},
    'facilities': {'_meta': {}, 'facility': []},
    'human-verification': {'human_verification': []},
    'user-profile': {'user_profile': {}},
    'decision-cards': {'decision_card_template': []},
}

# --- Abuse guards ---
MAX_BODY = 8 * 1024 * 1024          # 8MB total body cap
MAX_IMAGE_B64 = 6 * 1024 * 1024     # per-image base64 cap (~4.5MB original)
ALLOWED_IMAGE_MIME = {'image/jpeg', 'image/png'}  # jpg/png only (HEIC excluded: Chrome cannot preview it + cross-platform issues)
RATE_LIMIT_WINDOW = 60              # seconds
RATE_LIMIT_MAX = 20                 # AI-endpoint hits per IP per window
_rate = defaultdict(deque)
_KANA_PAREN_RE = re.compile(r'（[぀-ヿー]+）')   # full-width parens + kana reading


def _title_guard(s):
    """Reading-aware title guard: <=5 base chars (readings excluded), balanced parens.
    Title is optional — return '' to hide instead of showing a broken string."""
    s = str(s or '')[:40]
    if s.count('（') != s.count('）'):
        return ''
    return s if len(_KANA_PAREN_RE.sub('', s)) <= 5 else ''

# --- AI config (stub by default in dev) ---
# When live: prefer ADC (Vertex AI); an API key is only a temporary fallback. Both come from env and never leave the server.
AI_ENABLED = os.environ.get('ENABLE_AI', '').lower() in {'1', 'true', 'yes'}
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', '')  # not hardcoded; set per environment


def _extract_json(raw):
    """Extract JSON from a Gemini response (strip any ```json fence)."""
    s = str(raw).strip()
    if s.startswith('```'):
        s = s.split('```', 2)[1] if '```' in s[3:] else s.strip('`')
        if s.lstrip().lower().startswith('json'):
            s = s.lstrip()[4:]
    i, j = s.find('{'), s.rfind('}')
    return s[i:j + 1] if i != -1 and j != -1 else s


_GEMINI_CLIENT = None


def _get_gemini_client():
    """Build once and reuse — avoids redoing the service-account auth handshake on every draw (~5s each)."""
    global _GEMINI_CLIENT
    if _GEMINI_CLIENT is None:
        from google import genai
        api_key = os.environ.get('GEMINI_API_KEY', '')
        if api_key:
            _GEMINI_CLIENT = genai.Client(api_key=api_key)
        else:
            _GEMINI_CLIENT = genai.Client(vertexai=True,
                                          project=os.environ.get('GOOGLE_CLOUD_PROJECT', ''),
                                          location=os.environ.get('GOOGLE_CLOUD_LOCATION', 'global'))
    return _GEMINI_CLIENT


# Omikuji output schema: enforced via response_schema (constrained decoding) so long Japanese never breaks the JSON.
_KUJI_SCHEMA = {
    'type': 'object',
    'properties': {
        'title_ja': {'type': 'string'}, 'title_en': {'type': 'string'},
        'poem_ja': {'type': 'string'}, 'poem_en': {'type': 'string'},
        'tip_ja': {'type': 'string'}, 'tip_en': {'type': 'string'},
    },
    'required': ['title_ja', 'title_en', 'poem_ja', 'poem_en', 'tip_ja', 'tip_en'],
}

# Lens (reads a disaster notice) output schema: raw text + For My Brain (native-language summary) + For My Action (easy-Japanese step).
_LENS_SCHEMA = {
    'type': 'object',
    'properties': {
        'raw_ja': {'type': 'string'},      # the original text Gemini read from the photo (kept in Japanese)
        'brain_ja': {'type': 'string'}, 'brain_en': {'type': 'string'},   # what this says (summary)
        'action_ja': {'type': 'string'}, 'action_en': {'type': 'string'},  # what to do (action_ja = easy Japanese with furigana)
    },
    'required': ['raw_ja', 'brain_ja', 'brain_en', 'action_ja', 'action_en'],
}


def _rate_ok(ip):
    now = time.time()
    q = _rate[ip]
    while q and q[0] < now - RATE_LIMIT_WINDOW:
        q.popleft()
    if len(q) >= RATE_LIMIT_MAX:
        return False
    q.append(now)
    return True


def _strip_data_url(value):
    s = str(value or '')
    return s.split(',', 1)[1] if ',' in s else s


class Handler(SimpleHTTPRequestHandler):
    # ---------- helpers ----------
    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
        except (TypeError, ValueError):
            return None  # malformed Content-Length -> reject
        if length < 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length) if length > 0 else b''

    def _client_ip(self):
        # Cloud Run adds X-Forwarded-For. Take the LAST hop = the real client IP appended by the Google Front End;
        # the first hop is client-spoofable (spoofing would bypass the rate limit).
        fwd = self.headers.get('X-Forwarded-For', '')
        return fwd.split(',')[-1].strip() if fwd else self.client_address[0]

    def end_headers(self):
        path = self.path.split('?')[0]
        if path == '/' or path.endswith(('.html', '.js', '.css', '.json')):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def _send_missing_index(self):
        body = (
            '<!doctype html><meta charset="utf-8">'
            '<title>Digital Omamori</title>'
            '<body style="font-family:Arial,sans-serif;margin:32px;line-height:1.5">'
            '<h1>Digital Omamori</h1>'
            '<p>App shell is incomplete: <code>index.html</code> is not present in this cleanup copy.</p>'
            '<p>API health is available at <code>/api/health</code>.</p>'
            '</body>'
        ).encode('utf-8')
        self.send_response(503)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _static_allowed(path):
        if path in {'/index.html', '/sw.js', '/manifest.json'}:
            return True
        if path.startswith('/app/') and not any(part.startswith('.') for part in path.split('/')):
            return path.endswith(('.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'))
        if path.startswith('/photos/') and not any(part.startswith('.') for part in path.split('/')):
            return path.endswith(('.png', '.jpg', '.jpeg', '.webp'))
        return False

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/health':
            self.send_json({'ok': True, 'app': APP_NAME, 'ai_enabled': AI_ENABLED})
            return
        if path == '/api/meta':
            # Public: report only whether AI is enabled, never a key/credential
            self.send_json({'ai_enabled': AI_ENABLED, 'model': GEMINI_MODEL or 'stub'})
            return
        if path == '/api/catalog':
            # Official preparedness-item recommendation list (read-only; not in ENTITIES so no POST). Used by the frontend matching engine.
            self.send_json(storage.read_json('supply_catalog.json', default={'catalog': []}))
            return
        if path == '/api/demo-locations':
            # Local demo address resolution (alias -> fixed coordinates; not geocoding, not a real address, no external API). Read-only.
            self.send_json(storage.read_json('demo_locations.json', default=[]))
            return
        if path == '/api/kuji':
            # Disaster-omikuji fortune DB (read-only; generated from kuji_content_draft.md). Used by the frontend draw.
            self.send_json(storage.read_json('kuji.json', default={'kuji': []}))
            return
        if path.startswith('/api/'):
            entity = path[len('/api/'):]
            if entity in ENTITIES:
                self.send_json(storage.read_json(ENTITIES[entity], default=ENTITY_DEFAULTS[entity]))
                return
            self.send_error(404)
            return
        if path == '/':
            if os.path.exists('index.html'):
                self.path = '/index.html'
                super().do_GET()
            else:
                self._send_missing_index()
            return
        if self._static_allowed(path):
            super().do_GET()  # static: index.html / app/ / sw.js / manifest / photos
            return
        self.send_error(404)

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split('?')[0]

        # Privacy by design: private household data (inventory/profile/places/photos) is never written back to the server.
        # The frontend uses localStorage; /api/supply and /api/user-profile keep read-only GET seed only. Full-object POST + /api/photo were removed.

        if path in ('/api/generate-kuji', '/api/lens'):
            # Rate-limit BEFORE reading the body — otherwise unlimited 8MB floods could burn bandwidth/memory.
            if not _rate_ok(self._client_ip()):
                self.send_json({'success': False, 'error': 'rate limit'}, code=429)
                return
            body = self._read_body()
            if body is None:
                self.send_json({'success': False, 'error': 'payload too large'}, code=413)
                return
            try:
                payload = json.loads(body.decode('utf-8')) if body else {}
            except Exception:
                self.send_json({'success': False, 'error': 'invalid json'}, code=400)
                return
            handler = {'/api/generate-kuji': self._ai_generate_kuji,
                       '/api/lens': self._ai_lens}[path]
            try:
                self.send_json(handler(payload))
            except Exception as e:
                # error -> mock fallback (an AI-layer failure must not take down the app)
                self.log_error('AI fallback on %s: %s', path, type(e).__name__)
                self.send_json({'success': True, 'stub': True, 'data': self._mock_for(path)})
            return

        self.send_error(404)

    # ---------- AI proxy (dev = stub; wired to real Gemini for the demo, key server-side only) ----------
    def _mock_for(self, path):
        if path == '/api/generate-kuji':
            # Omikuji: in mock mode, tell the frontend to use its own 20 static fallback fortunes (never fabricate a fortune server-side).
            return {'use_fallback': True}
        if path == '/api/lens':
            # AI off (dev/demo without AI) -> sample two-card result. With AI on, runs multimodal Gemini.
            return {'raw_ja': '満員のため受付を中止しています。最寄りの麻布小学校へ移動してください。給水：本日12:00〜',
                    'brain_en': '(SAMPLE) This shelter is full and has stopped intake. Please move to the nearest Azabu Elementary School. Water is available today from 12:00.',
                    'brain_ja': '(サンプル) ここは いっぱいです。近（ちか）くの 麻布小学校（あざぶしょうがっこう）へ いって ください。みずは 12時（じ）から もらえます。',
                    'action_en': '(SAMPLE) Go to Azabu Elementary School. Water is available from 12:00.',
                    'action_ja': '麻布小学校（あざぶしょうがっこう）へ いって ください。みずは 12時（じ）から もらえます。'}
        return {'use_fallback': True}

    # ===== Lens: photo -> Gemini multimodal reading of a disaster notice -> native-language summary + easy-Japanese action (two cards) =====
    def _ai_lens(self, payload):
        """payload: {image: base64(jpg/png), mime}. AI off -> sample cards; error/unreadable -> use_fallback (frontend shows "cannot read", no fake sample)."""
        if not AI_ENABLED:
            return {'success': True, 'stub': True, 'data': self._mock_for('/api/lens')}
        image_b64 = _strip_data_url(payload.get('image', ''))
        mime = payload.get('mime', 'image/jpeg')
        if not image_b64 or mime not in ALLOWED_IMAGE_MIME or len(image_b64) > MAX_IMAGE_B64:
            return {'success': True, 'data': {'use_fallback': True}}
        try:
            raw = self._call_gemini_vision(self._lens_prompt(), image_b64, mime, schema=_LENS_SCHEMA)
            return {'success': True, 'data': self._normalize_lens(json.loads(_extract_json(raw)))}
        except Exception:
            return {'success': True, 'data': {'use_fallback': True}}

    @staticmethod
    def _lens_prompt():
        return (
            "You are a calm disaster-support assistant for FOREIGN RESIDENTS in Japan. "
            "The image is a real-world Japanese disaster-related notice, shelter whiteboard, sign, or product label. "
            "Read it and help someone who cannot read Japanese well. Return STRICT JSON:\n"
            "- raw_ja: the Japanese text you actually see, transcribed faithfully (same wording, NO translation), "
            "and ADD furigana in full-width parens 漢字（かな） for every kanji so it can be read.\n"
            "- brain_en: short plain-English summary of what this notice means for the reader.\n"
            "- brain_ja: the same short summary in EASY Japanese (やさしい日本語): short sentences, base kanji + furigana "
            "in full-width parens 漢字（かな） for every kanji, NO keigo.\n"
            "- action_en: what the reader should do, plain and short.\n"
            "- action_ja: the same action in EASY Japanese (やさしい日本語): short sentences, base kanji + furigana "
            "in full-width parens 漢字（かな） for every kanji, NO keigo.\n"
            "NOTE: ALL Japanese (raw_ja, brain_ja, action_ja) is read by a foreigner and the bystander helping them — "
            "every kanji needs furigana 漢字（かな）.\n"
            "RULES:\n"
            "- Register for brain_ja / action_ja: EVERY sentence ends in polite です/ます form. "
            "NO plain-form endings (〜だ。/〜である。/dictionary form like 逃げる。), NO 〜ましょう "
            "(use 〜て ください for instructions), no stacked compound verbs 〜て おく / 〜て しまう. "
            "Write 危険（きけん）です NOT 危険だ; 逃（に）げて ください NOT 逃げましょう. "
            "(raw_ja is EXEMPT — transcribe the sign exactly as written, even if it uses ましょう.)\n"
            "- Ground everything ONLY in what the image actually says. If unreadable/unsure, say so plainly; "
            "NEVER invent facility names, times, or instructions.\n"
            "- This is a plain-language AID, NOT an official translation. Never claim it is official or 100% accurate.\n"
            "- Convey real warnings the notice contains (e.g. 避難/危険) faithfully, but stay calm; do not add your own guarantees.\n"
            "- If the image is not a disaster notice, transcribe raw_ja and gently say it does not look like one."
        )

    @staticmethod
    def _normalize_lens(d):
        """Truncate length + require the mandatory fields. Do NOT strip real warnings like 避難/危険 — those are the notice's actual content and must be conveyed; safety is enforced by the prompt (no fabrication / labeled as an aid / never claims to be official)."""
        def c(s, n=400):
            return str(s or '')[:n]
        out = {'raw_ja': c(d.get('raw_ja'), 600),
               'brain_ja': c(d.get('brain_ja')), 'brain_en': c(d.get('brain_en')),
               'action_ja': c(d.get('action_ja')), 'action_en': c(d.get('action_en'))}
        if not (out['brain_en'] and out['action_ja']):  # 組不成雙卡 → 退回
            return {'use_fallback': True}
        # ましょう guard: applies only to our own voice (brain_ja/action_ja).
        # raw_ja is exempt — it is a faithful transcription of the sign (real official signage often uses 〜しましょう; quoting reality is fine).
        if 'ましょう' in out['brain_ja'] or 'ましょう' in out['action_ja']:
            return {'use_fallback': True}
        return out

    # ===== Disaster omikuji (fuses real readiness into a fortune). Real Gemini here; dev/offline = frontend's 20 static fallbacks. =====
    def _ai_generate_kuji(self, payload):
        """payload: {tier, tier_label, gaps:[{name_ja,name_en,status,need,unit}], percent, context}
        AI off -> tell the frontend to use its 20 static fallbacks. AI on -> Gemini generates the fortune.
        Any error is caught by do_POST -> _mock_for -> also returns use_fallback (safety net)."""
        if not AI_ENABLED:
            return {'success': True, 'stub': True, 'data': {'use_fallback': True}}
        prompt = self._kuji_prompt(payload)
        raw = self._call_gemini(prompt, schema=_KUJI_SCHEMA)
        data = self._normalize_kuji(json.loads(_extract_json(raw)))
        return {'success': True, 'data': data}

    @staticmethod
    def _kuji_prompt(payload):
        """System prompt: tier is fixed and must not change, gaps use real data (never fabricated), always positive, JSON enforced."""
        tier = str(payload.get('tier_label') or payload.get('tier') or '吉')
        gaps = payload.get('gaps') or []
        gap_lines = '; '.join(
            f"{g.get('name_ja','')}/{g.get('name_en','')} ({g.get('status','')}"
            + (f", short {g.get('need')}{g.get('unit','')}" if g.get('need') else '') + ")"
            for g in gaps[:5]) or '(no major gaps — well prepared)'
        pct = payload.get('percent', '')
        return (
            "You are a warm, slightly humorous Shinto shrine fortune-monk for the Japanese "
            "disaster-preparedness app 'Digital Omamori'. Write a personalised omikuji that FUSES "
            "the user's REAL emergency-supply situation into a shrine-style fortune poem, plus one "
            "gentle grounded disaster-safety tip.\n"
            f"- Fortune tier (FIXED, do NOT change, always a good fortune): {tier}\n"
            f"- Readiness: {pct}%\n"
            f"- Their REAL supply gaps right now (do NOT invent items): {gap_lines}\n"
            "RULES:\n"
            "- Always positive/encouraging. Never threatening. Never output 凶 / 'safe' / 'danger' / "
            "guarantees ('you are protected', 'nothing bad will happen' are FORBIDDEN).\n"
            "- Weave the real gap warmly into the poem (e.g. low on water -> a gentle nudge), do not scold.\n"
            "- LANGUAGE for ALL *_ja fields = Yasashii Nihongo (Easy Japanese) for non-native residents:\n"
            "  * Vocabulary: JLPT N4/N5 everyday words ONLY. NO literary/classical Japanese "
            "(FORBIDDEN styles: 〜ならず, 〜あふる, 万事, 運気, 兆し, 〜ず negation), no N1/N2 words, no keigo.\n"
            "  * EVERY kanji word carries its reading right after it in FULL-WIDTH parentheses: "
            "水（みず）, 家（いえ）. Okurigana stays outside the reading: 揺（ゆ）れる — NEVER 揺れる（ゆれる）.\n"
            "  * Short sentences with spaces between phrases (wakachigaki). Half-width numbers. "
            "Polite desu/masu endings, no fragments.\n"
            "  * Grammar: ONE simple verb form per clause. FORBIDDEN forms: 〜ましょう endings "
            "(for suggestions use 〜て ください or plain です/ます), stacked compound verbs like "
            "〜て おく / 〜て しまう (write 固定（こてい）して ください, NOT 固定して おきましょう).\n"
            "- poem_ja: 1-2 short sentences, warm shrine-omikuji rhythm (a gentle couplet feel is good) "
            "but built ONLY from plain modern words. Example of the register: "
            "「そなえる 心（こころ）に、福（ふく）が きます。」\n"
            "- tip_ja: 1-2 short sentences, ONE piece of information per sentence. Must be a real "
            "official-style 防災 basic (Tokyo Bosai level common knowledge); never invent numbers, "
            "never give unsafe advice, never promise safety. Standard disaster terms "
            "(避難所, 懐中電灯, 賞味期限 etc.) may stay, with reading.\n"
            "- Keep BOTH poems SHORT: 1-2 short sentences only, gentle and brief — about one-third "
            "shorter than a full paragraph (poem_ja roughly 1-2 short lines). The tip stays short too.\n"
            "- title_ja: evocative, MAX 5 characters BEFORE readings (readings in （…） are NOT counted); "
            "add the reading for any kanji, e.g. 福（ふく）の 花（はな） = 4 base chars. "
            "Hiragana-only titles are also welcome. NO numbers, NO 第X番. title_en = ONE short word.\n"
            "- Output STRICT JSON only, no markdown fence:\n"
            '{"title_ja":"…","title_en":"…","poem_ja":"...（…）...","poem_en":"...","tip_ja":"...（…）...","tip_en":"..."}'
        )

    @staticmethod
    def _call_gemini(prompt, schema=None):
        """google-genai SDK (replaces the deprecated vertexai.generative_models; Google's current recommendation).
        Auto-selects: GEMINI_API_KEY -> Gemini API; otherwise service account/ADC -> Vertex (location defaults to global, widest model set).
        schema: if passed, response_schema enforces the structure (constrained decoding) so long output never breaks the JSON.
        Credentials come only from env, never in code/HTML. Errors are caught by do_POST -> fallback."""
        from google.genai import types
        model_name = GEMINI_MODEL or 'gemini-3.5-flash'
        client = _get_gemini_client()  # reuse the cached client, saving an auth handshake each call
        # Gemini 3.5: thinking cannot be fully disabled, but the old thinking_budget is deprecated -> use thinking_level="minimal"
        # (minimal thinking, ~15s -> ~3s, good for short JSON generation like omikuji).
        # Robustness: SDK version differences (Enum vs string) + the backend may reject -> try [minimal thinking] then [no thinking config], first success wins.
        def _min_think():
            TL = getattr(types, 'ThinkingLevel', None)
            lvl = getattr(TL, 'MINIMAL', 'minimal') if TL else 'minimal'
            return types.ThinkingConfig(thinking_level=lvl)

        def _cfg(thinking):
            kw = dict(temperature=0.9, response_mime_type='application/json')
            if schema is not None:
                kw['response_schema'] = schema  # enforced structure = always valid JSON
            if thinking is not None:
                kw['thinking_config'] = thinking
            return types.GenerateContentConfig(**kw)

        attempts = []
        try:
            attempts.append(_cfg(_min_think()))
        except Exception:
            pass
        attempts.append(_cfg(None))
        last = None
        for cfg in attempts:
            try:
                return client.models.generate_content(model=model_name, contents=prompt, config=cfg).text
            except Exception as e:
                last = e
        raise last

    @staticmethod
    def _call_gemini_vision(prompt, image_b64, mime, schema=None):
        """Multimodal: feed the photo + prompt to Gemini together (for Lens). Reuses the cached client + minimal thinking + response_schema.
        Low temperature (0.4) for accurate reading, not creativity."""
        from google.genai import types
        model_name = GEMINI_MODEL or 'gemini-3.5-flash'
        client = _get_gemini_client()
        image_b64 = _strip_data_url(image_b64)
        if len(image_b64) > MAX_IMAGE_B64:
            raise ValueError('image too large')
        img_bytes = base64.b64decode(image_b64, validate=True)
        contents = [types.Part.from_bytes(data=img_bytes, mime_type=mime), prompt]

        def _min_think():
            TL = getattr(types, 'ThinkingLevel', None)
            lvl = getattr(TL, 'MINIMAL', 'minimal') if TL else 'minimal'
            return types.ThinkingConfig(thinking_level=lvl)

        def _cfg(thinking):
            kw = dict(temperature=0.4, response_mime_type='application/json')
            if schema is not None:
                kw['response_schema'] = schema
            if thinking is not None:
                kw['thinking_config'] = thinking
            return types.GenerateContentConfig(**kw)

        attempts = []
        try:
            attempts.append(_cfg(_min_think()))
        except Exception:
            pass
        attempts.append(_cfg(None))
        last = None
        for cfg in attempts:
            try:
                return client.models.generate_content(model=model_name, contents=contents, config=cfg).text
            except Exception as e:
                last = e
        raise last

    @staticmethod
    def _normalize_kuji(d):
        """Normalize the Gemini response into the frontend schema + safety guard (removes bad-fortune/danger content)."""
        def clean(s):
            s = str(s or '')
            # Over-length -> reject (do NOT slice: a slice could cut inside （かな） -> broken ruby on screen).
            # An empty field triggers use_fallback below (poem/tip) or is simply hidden (title).
            if len(s) > 200:
                return ''
            bad = ('danger', 'guaranteed', '100% safe', 'will die')
            # 〜ましょう is a globally banned sentence ending (the only exception is static No.9, which never passes through here).
            # The prompt forbids it but the AI occasionally ignores that -> block deterministically and fall back.
            if 'ましょう' in s:
                return ''
            return '' if ('凶' in s or any(b in s.lower() for b in bad)) else s
        out = {'poem_ja': clean(d.get('poem_ja')), 'poem_en': clean(d.get('poem_en')),
               'tip_ja': clean(d.get('tip_ja')), 'tip_en': clean(d.get('tip_en'))}
        # If any required field was cleared by the guard -> tell the frontend to fall back (no half-broken fortune). Title is not required.
        if not all(out.values()):
            return {'use_fallback': True}
        # Optional short title: ja = reading-aware guard (base <=5 chars, balanced parens; hide it entirely if broken,
        # replacing the old blind [:5] slice that could cut （かな） in half). en <=12 chars. If missing, no fallback — the frontend just hides it.
        out['title_ja'] = _title_guard(clean(d.get('title_ja')))
        out['title_en'] = clean(d.get('title_en'))[:12]
        return out

    def log_message(self, fmt, *args):
        try:
            if '/api/' in str(args[0]):
                super().log_message(fmt, *args)
        except Exception:
            pass


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    if AI_ENABLED:
        # Background warm-up: make one tiny Gemini call at startup to warm the client + auth token,
        # so the first draw is fast (daemon thread; failure does not affect startup).
        import threading

        def _warm_gemini():
            try:
                Handler._call_gemini('warmup, reply with {"ok":true}')
                print('[startup] Gemini warm-up done (first draw is fast)', flush=True)
            except Exception as e:
                print(f'[startup] Gemini warm-up skipped (no impact): {type(e).__name__}', flush=True)

        threading.Thread(target=_warm_gemini, daemon=True).start()
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'{APP_NAME} on http://0.0.0.0:{PORT}  (AI={"on" if AI_ENABLED else "stub"})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()
