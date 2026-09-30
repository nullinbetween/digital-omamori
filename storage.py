"""
Digital Omamori — read-only storage adapter.
Local filesystem (dev) / Google Cloud Storage bucket (Cloud Run deploy).

Set GCS_BUCKET on deploy to route public-pack and seed reads through GCS.
In local dev, without GCS_BUCKET, reads come from ./data.
"""
import json
import os

DATA_DIR = os.environ.get('DATA_DIR', 'data')
GCS_BUCKET = os.environ.get('GCS_BUCKET')  # if set, use GCS (Cloud Run deploy)


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
