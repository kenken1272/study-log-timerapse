#!/bin/bash
set -euo pipefail

echo "=============================="
echo "0. Project check"
echo "=============================="
pwd
ls -la

echo ""
echo "=============================="
echo "1. Variables"
echo "=============================="

export PROJECT_ID="vla-test1"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export DEPLOYED_AT="$(date -u +%Y%m%d%H%M%S)"

echo "PROJECT_ID=$PROJECT_ID"
echo "REGION=$REGION"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "SA_EMAIL=$SA_EMAIL"
echo "DEPLOYED_AT=$DEPLOYED_AT"

echo ""
echo "=============================="
echo "2. Set gcloud project"
echo "=============================="

gcloud config set project "$PROJECT_ID"

echo ""
echo "=============================="
echo "3. Clean Next.js cache"
echo "=============================="

rm -rf .next

echo ""
echo "=============================="
echo "4. Install dependencies"
echo "=============================="

npm install

echo ""
echo "=============================="
echo "5. Typecheck"
echo "=============================="

if npm pkg get scripts.typecheck | grep -qv "undefined"; then
  npm run typecheck
else
  echo "typecheck script not found. skip."
fi

echo ""
echo "=============================="
echo "6. Build"
echo "=============================="

npm run build

echo ""
echo "=============================="
echo "7. Deploy to Cloud Run"
echo "=============================="

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=3600 \
  --min-instances=0 \
  --max-instances=3 \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET_NAME=$BUCKET_NAME,NEXT_PUBLIC_APP_NAME=Study Timelapse,DEPLOYED_AT=$DEPLOYED_AT" \
  --quiet

echo ""
echo "=============================="
echo "8. Cloud Run URL"
echo "=============================="

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"

echo "$SERVICE_URL"

echo ""
echo "=============================="
echo "9. Recent logs"
echo "=============================="

gcloud run services logs read "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --limit=50 || true

echo ""
echo "=============================="
echo "DONE"
echo "Open:"
echo "$SERVICE_URL"
echo "=============================="
