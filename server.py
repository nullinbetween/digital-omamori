#!/usr/bin/env python3
"""
Digital Omamori — server.py (Prototype V12) · PUBLIC SHOWCASE EDITION

Copyright (c) 2026 Meredith Cheung (nullinbetween). All rights reserved.
Source-visible for reference only — see LICENSE. Not open source.

Local-first disaster-prep web app. Python stdlib http.server, Cloud Run-ready.

Design:
  - Cloud Run: listen on $PORT, plain HTTP, bind 0.0.0.0 (TLS at the Cloud Run edge).
  - Read-only JSON entities served at /api/<entity> GET (storage.py: local fs <-> GCS).
  - AI proxy (/api/lens, /api/generate-kuji) is server-side only; the frontend never sees credentials.
    AI-off -> explicit fallback (Lens: ai_unavailable; Kuji: static client fallback). Auth via ADC / service account.
  - Abuse guards: body size cap / image size cap / MIME allowlist / rate limit / explicit fallback errors.

In this edition the Lens and Ready-Kuji prompts and the output normalizers are withheld (see WITHHELD.md).
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
    """Deterministic guard for AI-generated titles (strips reading annotations the UI renders separately).

    Implementation withheld from the public showcase.
    """
    raise NotImplementedError("Withheld from the public showcase. See WITHHELD.md.")

# --- AI config (stub by default in dev) ---
# When live: prefer ADC (Vertex AI); an API key is only a temporary fallback. Both come from env and never leave the server.
AI_ENABLED = os.environ.get('ENABLE_AI', '').lower() in {'1', 'true', 'yes'}
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', '')  # not hardcoded; set per environment

# 🔴 POSSIBLE POINT OF RETURN #2 (白霜 ruling, 2026-07-23) — Lens Gemini media resolution.
# MEDIA_RESOLUTION_HIGH was added 2026-07-20 (Lens rebuild) to read distant/small text, when capture was still
# sensor-resolution and there was no sniper crop. It made each vision call ~30-40s (hitting the frontend timeout).
# Sniper now crops/zooms to the target, which replaces HIGH's purpose, so HIGH is DISABLED here for speed.
# To revert (if framed small/distant text reads worse without it): set LENS_MEDIA_RES_HIGH = True.
# ⚠️ Reverting re-introduces the ~30s+ latency — pair it with a latency fix (e.g. keep the higher frontend cap,
# a warmer/min-instance container, or a faster model), not a naive flip.
LENS_MEDIA_RES_HIGH = False


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

# Lens (reads a disaster notice) output schema: raw text + For My Brain (plain-English summary) + For My Action (easy-Japanese step).
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
            # AI off must never fabricate a plausible emergency notice or action.
            return {'use_fallback': True, 'error': 'ai_unavailable'}
        return {'use_fallback': True}

    # ===== Lens: photo -> Gemini multimodal reading of a disaster notice -> plain-English summary + easy-Japanese action (two cards) =====
    def _ai_lens(self, payload):
        """payload: {image: base64(jpg/png), mime}. AI off/error/unreadable -> an explicit fallback error; never a fake notice."""
        if not AI_ENABLED:
            return {'success': True, 'stub': True, 'data': self._mock_for('/api/lens')}
        image_b64 = _strip_data_url(payload.get('image', ''))
        mime = payload.get('mime', 'image/jpeg')
        # Distinct, honest error categories (frontend keeps the photo + offers resend; never says "offline" for these).
        if not image_b64 or mime not in ALLOWED_IMAGE_MIME:
            return {'success': True, 'data': {'use_fallback': True, 'error': 'bad_input'}}
        if len(image_b64) > MAX_IMAGE_B64:
            return {'success': True, 'data': {'use_fallback': True, 'error': 'image_too_large'}}
        try:
            raw = self._call_gemini_vision(self._lens_prompt(), image_b64, mime, schema=_LENS_SCHEMA)
            return {'success': True, 'data': self._normalize_lens(json.loads(_extract_json(raw)))}
        except Exception:
            return {'success': True, 'data': {'use_fallback': True, 'error': 'ai_error'}}

    @staticmethod
    def _lens_prompt():
        """Lens reading instruction for Gemini: read the user-selected notice and return a plain-language
        summary + an easy-Japanese action, with honest refusal for images that are not notices.

        Prompt withheld from the public showcase.
        """
        raise NotImplementedError("Withheld from the public showcase. See WITHHELD.md.")

    @staticmethod
    def _normalize_lens(d):
        """Validate and normalize a Lens response (required fields, length caps) before it reaches the UI.

        Implementation withheld from the public showcase.
        """
        raise NotImplementedError("Withheld from the public showcase. See WITHHELD.md.")

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
        """Ready-Kuji phrasing instruction: the tier is fixed by deterministic code and must not change;
        gaps come from real data only; tone and easy-Japanese constraints enforced.

        Prompt withheld from the public showcase.
        """
        raise NotImplementedError("Withheld from the public showcase. See WITHHELD.md.")

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

        def _media_res_high():
            # Distant, small sign text -> HIGH media resolution WHEN the installed SDK exposes the enum. Now gated behind
            # LENS_MEDIA_RES_HIGH (POINT OF RETURN #2, disabled 2026-07-23: sniper crop replaces it; HIGH was ~30-40s/call).
            if not LENS_MEDIA_RES_HIGH:
                return None
            try:
                MR = getattr(types, 'MediaResolution', None)
                return getattr(MR, 'MEDIA_RESOLUTION_HIGH', None) if MR is not None else None
            except Exception:
                return None

        def _cfg(thinking):
            kw = dict(temperature=0.4, response_mime_type='application/json')
            if schema is not None:
                kw['response_schema'] = schema
            if thinking is not None:
                kw['thinking_config'] = thinking
            mr = _media_res_high()
            if mr is not None:
                try:
                    return types.GenerateContentConfig(media_resolution=mr, **kw)
                except Exception:
                    pass  # SDK build doesn't accept media_resolution -> fall through to the default config
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
        """Deterministic output guard for Ready-Kuji (schema, length, banned patterns) with static fallback.

        Implementation withheld from the public showcase.
        """
        raise NotImplementedError("Withheld from the public showcase. See WITHHELD.md.")

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
