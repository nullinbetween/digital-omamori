#!/usr/bin/env python3
"""Digital Omamori server smoke — self-launches server.py, verifies CRUD round-trip + AI stub normalize + abuse guards.
Run: python3 tests/server_smoke.py   (exit 0 = all green)"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, '..', 'server.py')
PORT = '8095'
B = f'http://127.0.0.1:{PORT}'

def get(p):
    with urllib.request.urlopen(B + p, timeout=5) as r:
        return json.load(r), r.status

def get_code(p):
    try:
        with urllib.request.urlopen(B + p, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

def post(p, obj):
    req = urllib.request.Request(B + p, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r), r.status
    except urllib.error.HTTPError as e:
        raw = e.read() or b'{}'
        try:
            return json.loads(raw), e.code
        except Exception:
            return {}, e.code  # non-JSON error page (e.g. send_error's HTML): take only the code

ok = bad = 0
def chk(n, cond):
    global ok, bad
    if cond: ok += 1; print('  ✓', n)
    else: bad += 1; print('  ✗', n)

proc = subprocess.Popen([sys.executable, SERVER], env={**os.environ, 'PORT': PORT},
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(1.6)
    print('Digital Omamori server smoke\n')
    chk('health ok', get('/api/health')[0]['ok'] is True)
    sup, _ = get('/api/supply'); chk('GET supply has inventory', len(sup['supply_item']) >= 1)
    chk('GET facilities has facilities', len(get('/api/facilities')[0]['facility']) >= 1)
    cat, _ = get('/api/catalog'); chk('GET catalog recommended list (read-only)', len(cat.get('catalog', [])) >= 10)
    chk('catalog read-only: POST not written as an entity (404)', post('/api/catalog', {'catalog': []})[1] == 404)
    kj, _ = get('/api/kuji'); chk('GET kuji 20 fortunes (read-only)', len(kj.get('kuji', [])) == 20)
    # Privacy by design: private data no longer written to the server -> GET seed stays read-only, POST of a private entity should be rejected (404)
    chk('supply read-only seed: POST not written (404)', post('/api/supply', sup)[1] == 404)
    chk('user-profile read-only seed: POST not written (404)', post('/api/user-profile', {'user_profile': {}})[1] == 404)
    chk('/api/inventory entity removed -> GET 404', get_code('/api/inventory') == 404)
    chk('/api/photo endpoint removed -> POST 404', post('/api/photo', {'id': 1, 'mime': 'image/jpeg', 'image': 'AA'})[1] == 404)
    # Dead stub endpoints removed (recognize/rephrase/decision-card) -> should return 404, no longer fake success
    chk('/api/recognize removed → 404', post('/api/recognize', {})[1] == 404)
    chk('/api/rephrase removed → 404', post('/api/rephrase', {})[1] == 404)
    chk('/api/decision-card removed → 404', post('/api/decision-card', {})[1] == 404)
    # New fortune contract: sends only coarse tier (no gaps/percent) -> still falls back normally
    gk, _ = post('/api/generate-kuji', {'tier': 'chukichi', 'tier_label': '中吉'})
    chk('generate-kuji coarse tier → use_fallback', gk.get('data', {}).get('use_fallback') is True)
    ln, _ = post('/api/lens', {})
    chk('lens AI-off -> dual card (brain_en+action_ja)', bool(ln.get('data', {}).get('brain_en')) and bool(ln.get('data', {}).get('action_ja')))
    chk('unknown entity 404', get_code('/api/nope') == 404)
    # yasashii guard: AI fortune containing the ましょう ending (banned by COPY_RULES) -> whole fortune falls back (caught in a real draw 07-03)
    sys.path.insert(0, os.path.join(HERE, '..'))
    import server as _srv
    _nk = _srv.Handler._normalize_kuji
    _v = {'poem_ja': 'そなえる 心（こころ）に 福（ふく）。', 'poem_en': 'ok', 'tip_en': 'ok',
          'tip_ja': '家具（かぐ）を 固定（こてい）して おきましょう。'}
    chk('kuji guard: ましょう ending -> use_fallback', _nk(_v).get('use_fallback') is True)
    _v2 = dict(_v, tip_ja='家具（かぐ）を 固定（こてい）して ください。')
    chk('kuji guard: ください ending -> passes normally', _nk(_v2).get('tip_ja', '').endswith('ください。'))
    # Lens yasashii guard ("alignment" 07-04): brain/action ましょう -> fallback; raw_ja (original notice text) is exempt
    _nl = _srv.Handler._normalize_lens
    _lv = {'raw_ja': 'x', 'brain_ja': 'あぶないです。', 'brain_en': 'ok',
           'action_ja': 'にげましょう。', 'action_en': 'ok'}
    chk('lens guard: action_ja ましょう -> use_fallback', _nl(_lv).get('use_fallback') is True)
    _lv2 = dict(_lv, raw_ja='みんなで 協力しましょう', action_ja='にげて ください。')
    chk('lens guard: raw_ja ましょう is exempt (original notice text)', _nl(_lv2).get('action_ja', '').endswith('ください。'))
finally:
    proc.terminate()

print(f'\n{ok} passed, {bad} failed')
sys.exit(1 if bad else 0)
