#!/bin/bash
set -euo pipefail

echo "=============================="
echo "0. Variables"
echo "=============================="

export PROJECT_ID="vla-test1"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

export VERTEX_LOCATION="us-central1"
export VERTEX_MODEL="gemini-2.5-pro"
export ANALYSIS_MAX_OUTPUT_TOKENS="2048"
export DEPLOYED_AT="$(date -u +%Y%m%d%H%M%S)"

echo "PROJECT_ID=$PROJECT_ID"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "SA_EMAIL=$SA_EMAIL"
echo "VERTEX_LOCATION=$VERTEX_LOCATION"
echo "VERTEX_MODEL=$VERTEX_MODEL"

echo ""
echo "=============================="
echo "1. Set project"
echo "=============================="

gcloud config set project "$PROJECT_ID"

echo ""
echo "=============================="
echo "2. Enable Vertex AI API"
echo "=============================="

gcloud services enable aiplatform.googleapis.com \
  --project="$PROJECT_ID"

echo ""
echo "=============================="
echo "3. Wait for API propagation"
echo "=============================="

echo "Vertex AI APIの反映待ちです。60秒待ちます。"
sleep 60

echo ""
echo "=============================="
echo "4. Grant Vertex AI User role to Cloud Run service account"
echo "=============================="

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --quiet

echo ""
echo "=============================="
echo "5. Confirm API enabled"
echo "=============================="

gcloud services list --enabled \
  --project="$PROJECT_ID" \
  --filter="name:aiplatform.googleapis.com" \
  --format="table(config.name,state)"

echo ""
echo "=============================="
echo "6. Confirm IAM role"
echo "=============================="

gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA_EMAIL} AND bindings.role:roles/aiplatform.user" \
  --format="table(bindings.role,bindings.members)"

echo ""
echo "=============================="
echo "7. Local build"
echo "=============================="

rm -rf .next
npm install

if npm pkg get scripts.typecheck | grep -qv "undefined"; then
  npm run typecheck
else
  echo "typecheck script not found. skip."
fi

npm run build

echo ""
echo "=============================="
echo "8. Redeploy Cloud Run with Vertex AI env vars"
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
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET_NAME=$BUCKET_NAME,NEXT_PUBLIC_APP_NAME=Study Timelapse,VERTEX_LOCATION=$VERTEX_LOCATION,VERTEX_MODEL=$VERTEX_MODEL,ANALYSIS_MAX_OUTPUT_TOKENS=$ANALYSIS_MAX_OUTPUT_TOKENS,DEPLOYED_AT=$DEPLOYED_AT" \
  --quiet

echo ""
echo "=============================="
echo "9. Cloud Run URL"
echo "=============================="

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"

echo "$SERVICE_URL"

echo ""
echo "=============================="
echo "10. Recent logs"
echo "=============================="

gcloud run services logs read "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --limit=80 || true

echo ""
echo "=============================="
echo "DONE"
echo "Open:"
echo "$SERVICE_URL"
echo "=============================="
