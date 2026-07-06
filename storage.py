"""
Digital Omamori — storage adapter.
Local filesystem (dev) <-> Google Cloud Storage bucket (Cloud Run deploy).

The Cloud Run filesystem is ephemeral (wiped on restart) -> set env GCS_BUCKET on deploy to route reads/writes through GCS.
In local dev, without GCS_BUCKET, it reads/writes ./data and ./photos (atomic write).
"""
import json
import os
import threading

DATA_DIR = os.environ.get('DATA_DIR', 'data')
PHOTOS_DIR = os.environ.get('PHOTOS_DIR', 'photos')
GCS_BUCKET = os.environ.get('GCS_BUCKET')  # if set, use GCS (Cloud Run deploy)
_lock = threading.Lock()


def _bucket():
    """Lazy import google-cloud-storage (so local-fs dev works without it installed)."""
    from google.cloud import storage as gcs  # noqa: lazy
    return gcs.Client().bucket(GCS_BUCKET)


def read_json(name, default=None):
    if GCS_BUCKET:
        blob = _bucket().blob(f'{DATA_DIR}/{name}')
        if not blob.exists():
            return default
        return json.loads(blob.download_as_text())
    path = os.path.join(DATA_DIR, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json(name, data):
    """Whole-file overwrite (CRUD is per-collection). Local writes use atomic replace."""
    with _lock:
        if GCS_BUCKET:
            _bucket().blob(f'{DATA_DIR}/{name}').upload_from_string(
                json.dumps(data, ensure_ascii=False, indent=2),
                content_type='application/json; charset=utf-8',
            )
            return
        os.makedirs(DATA_DIR, exist_ok=True)
        path = os.path.join(DATA_DIR, name)
        tmp = f'{path}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)  # atomic


def save_photo(filename, raw_bytes, content_type='image/jpeg'):
    if GCS_BUCKET:
        _bucket().blob(f'{PHOTOS_DIR}/{filename}').upload_from_string(raw_bytes, content_type=content_type)
        return f'{PHOTOS_DIR}/{filename}'
    os.makedirs(PHOTOS_DIR, exist_ok=True)
    with open(os.path.join(PHOTOS_DIR, filename), 'wb') as f:
        f.write(raw_bytes)
    return f'{PHOTOS_DIR}/{filename}'
