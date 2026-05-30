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
export PROJECT_NUMBER="116342725707"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export VERTEX_SA="service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com"

export VERTEX_LOCATION="us-central1"
export VERTEX_MODEL="gemini-2.5-pro"
export ANALYSIS_MAX_OUTPUT_TOKENS="2048"
export DEPLOYED_AT="$(date -u +%Y%m%d%H%M%S)"

echo "PROJECT_ID=$PROJECT_ID"
echo "PROJECT_NUMBER=$PROJECT_NUMBER"
echo "REGION=$REGION"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "SA_EMAIL=$SA_EMAIL"
echo "VERTEX_SA=$VERTEX_SA"
echo "VERTEX_LOCATION=$VERTEX_LOCATION"
echo "VERTEX_MODEL=$VERTEX_MODEL"
echo "DEPLOYED_AT=$DEPLOYED_AT"

echo ""
echo "=============================="
echo "2. Set gcloud project"
echo "=============================="

gcloud config set project "$PROJECT_ID"

echo ""
echo "=============================="
echo "3. Enable required APIs"
echo "=============================="

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  aiplatform.googleapis.com \
  --project="$PROJECT_ID"

echo ""
echo "=============================="
echo "4. Grant Cloud Run service account Vertex AI permission"
echo "=============================="

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --quiet

echo ""
echo "=============================="
echo "5. Grant Vertex AI service agent GCS read permission"
echo "=============================="

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${VERTEX_SA}" \
  --role="roles/storage.objectViewer" \
  --project="$PROJECT_ID" \
  --quiet

echo ""
echo "=============================="
echo "6. Confirm Vertex AI and GCS permissions"
echo "=============================="

gcloud services list --enabled \
  --project="$PROJECT_ID" \
  --filter="name:aiplatform.googleapis.com" \
  --format="table(config.name,state)"

echo ""
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA_EMAIL} AND bindings.role:roles/aiplatform.user" \
  --format="table(bindings.role,bindings.members)" || true

echo ""
gcloud storage buckets get-iam-policy "gs://${BUCKET_NAME}" \
  --project="$PROJECT_ID" \
  --format="table(bindings.role,bindings.members)" | grep -E "storage.objectViewer|${VERTEX_SA}" || true

echo ""
echo "=============================="
echo "7. Clean Next.js cache"
echo "=============================="

rm -rf .next

echo ""
echo "=============================="
echo "8. Install dependencies"
echo "=============================="

npm install

echo ""
echo "=============================="
echo "9. Typecheck"
echo "=============================="

if npm pkg get scripts.typecheck | grep -qv "undefined"; then
  npm run typecheck
else
  echo "typecheck script not found. skip."
fi

echo ""
echo "=============================="
echo "10. Build"
echo "=============================="

npm run build

echo ""
echo "=============================="
echo "11. Deploy to Cloud Run"
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
echo "12. Cloud Run URL"
echo "=============================="

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"

echo "$SERVICE_URL"

echo ""
echo "=============================="
echo "13. Recent logs"
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
