# Digital Omamori — Cloud Run Deployment Guide

> Goal: deploy the app as a **publicly accessible Cloud Run URL** (a required submission item).
> Uses **Cloud Shell** (browser-based gcloud, nothing to install locally). Expect 15–20 minutes, most of it waiting for the build.
> The app is a simple Python `http.server` container, so the steps are short.

---

## Prerequisites (already in place)
- ✅ `Dockerfile` (python:3.12-slim, `$PORT`, runs `server.py`)
- ✅ `.gcloudignore` (keys and dev files excluded from the image)
- ✅ `requirements.txt` (includes `google-genai`)
- ✅ `server.py` authenticates via an attached service account (ADC) → **no `gcp-key.json` needed on Cloud Run** (more secure)
- ✅ Security allowlist (`/server.py` and key paths all return 404)

---

## Step 0: open Cloud Shell + set variables
1. Go to https://console.cloud.google.com → top-right **`>_` (Activate Cloud Shell)**.
2. Paste this (sets the project and variables):
```bash
export PROJECT_ID="plated-magpie-457017-n5"
export REGION="asia-northeast1"          # Tokyo
export SA="digital-omamori-mmc-2026@plated-magpie-457017-n5.iam.gserviceaccount.com"
gcloud config set project $PROJECT_ID
```

## Step 1: confirm the service account has Vertex AI access (one-time)
```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" \
  --role="roles/aiplatform.user"
```
(Safe to run even if the role is already granted.)

## Step 2: get the app code into Cloud Shell
**Simplest:** zip the `plainsafe` folder, upload it via Cloud Shell (top-right **⋮ → Upload**), then unzip:
```bash
cd ~
unzip -o plainsafe.zip -d plainsafe   # use your uploaded filename
cd plainsafe                          # confirm server.py / data/ / app/ / Dockerfile are present
ls
```
⚠️ Before zipping, make sure `data/*.json` are **real files** (downloaded from iCloud, not cloud-only placeholders).
(Once the GitHub repo exists, this step can be replaced with `git clone`.)

## Step 3: deploy 🚀
```bash
gcloud run deploy digital-omamori \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --service-account $SA \
  --set-env-vars="ENABLE_AI=1,GEMINI_MODEL=gemini-3.5-flash,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_VERTEXAI=TRUE" \
  --memory=1Gi \
  --timeout=300
```
- The first run asks to create Artifact Registry / enable APIs → **y**.
- Wait 3–5 minutes. On success it prints a **Service URL** (`https://digital-omamori-xxxxx.asia-northeast1.run.app`). **This is the deployment link for submission.**

## Step 4: verify (against the Service URL)
```bash
URL="<paste the Service URL>"
curl -s -o /dev/null -w "health:%{http_code}\n" "$URL/api/health"     # expect 200
curl -s -o /dev/null -w "server.py:%{http_code}\n" "$URL/server.py"   # expect 404 (security)
curl -s -o /dev/null -w "home:%{http_code}\n" "$URL/"                 # expect 200
curl -s "$URL/api/meta"                                               # expect ai_enabled: true
```
Then open the URL on a phone or computer and test:
- 📷 Lens: upload a sign → two cards + local data below
- 🎴 Omikuji: draw → an AI-generated fortune
- Tabs load; preparedness items and facilities show data

---

## Troubleshooting
| Problem | Fix |
|---|---|
| Lens/omikuji return fallback (AI inactive) | Confirm Step 1 ran; check env `GOOGLE_CLOUD_LOCATION=global` and `GEMINI_MODEL=gemini-3.5-flash` are spelled correctly |
| Build fails | Read the message; usually requirements or Dockerfile |
| 403 (cannot open) | Confirm the deploy used `--allow-unauthenticated` |
| Data is empty (0 items/facilities) | `data/*.json` were iCloud placeholders when zipped → re-download, then re-zip |
| Variables lost (Cloud Shell reopened) | Re-run Step 0 |

---

## After a successful deploy
1. Put the **Service URL** into the submission form's "Project Deployment Link".
2. To update after code changes → re-run Steps 2–3 (the same service name overwrites the previous revision).
3. Deploy once more right before submission to ensure the latest build is live.
