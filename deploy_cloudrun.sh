#!/bin/bash
set -euo pipefail

echo "=============================="
echo "0. Variables"
echo "=============================="

export PROJECT_ID="vla-test1"
export PROJECT_NUMBER="116342725707"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export COMPUTE_DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "PROJECT_ID=$PROJECT_ID"
echo "PROJECT_NUMBER=$PROJECT_NUMBER"
echo "REGION=$REGION"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "SA_EMAIL=$SA_EMAIL"
echo "COMPUTE_DEFAULT_SA=$COMPUTE_DEFAULT_SA"

echo ""
echo "=============================="
echo "1. Set gcloud project"
echo "=============================="

gcloud config set project "$PROJECT_ID"

echo ""
echo "=============================="
echo "2. Enable required APIs"
echo "=============================="

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  billingbudgets.googleapis.com \
  cloudbilling.googleapis.com \
  --project="$PROJECT_ID"

echo ""
echo "=============================="
echo "3. Ensure Firestore database"
echo "=============================="

if gcloud firestore databases describe --database="(default)" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Firestore default database already exists."
else
  gcloud firestore databases create \
    --database="(default)" \
    --location="$REGION" \
    --edition="standard" \
    --type="firestore-native" \
    --project="$PROJECT_ID"
fi

echo ""
echo "=============================="
echo "4. Ensure GCS bucket"
echo "=============================="

if gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Bucket already exists: gs://${BUCKET_NAME}"
else
  gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --project="$PROJECT_ID"
fi

echo ""
echo "=============================="
echo "5. Apply GCS CORS"
echo "=============================="

cat <<'CORS' > cors.json
[
  {
    "origin": ["*"],
    "method": ["GET", "PUT", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Length", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
CORS

gcloud storage buckets update "gs://${BUCKET_NAME}" \
  --cors-file=cors.json \
  --project="$PROJECT_ID"

echo ""
echo "=============================="
echo "6. Ensure Cloud Run service account"
echo "=============================="

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Service account already exists: $SA_EMAIL"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Study Timelapse Cloud Run Service Account" \
    --project="$PROJECT_ID"
fi

echo ""
echo "=============================="
echo "7. Grant runtime permissions"
echo "=============================="

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/datastore.user" \
  --quiet

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --project="$PROJECT_ID" \
  --quiet

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="$PROJECT_ID" \
  --quiet

echo ""
echo "=============================="
echo "8. Grant Cloud Build / Cloud Run build permission"
echo "=============================="

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${COMPUTE_DEFAULT_SA}" \
  --role="roles/run.builder" \
  --quiet

echo ""
echo "=============================="
echo "9. Local build check"
echo "=============================="

npm install

if npm pkg get scripts.lint | grep -qv "undefined"; then
  npm run lint
else
  echo "lint script not found. skip."
fi

if npm pkg get scripts.typecheck | grep -qv "undefined"; then
  npm run typecheck
else
  echo "typecheck script not found. skip."
fi

npm run build

echo ""
echo "=============================="
echo "10. Deploy to Cloud Run"
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
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET_NAME=$BUCKET_NAME,NEXT_PUBLIC_APP_NAME=Study Timelapse"

echo ""
echo "=============================="
echo "11. Ensure public invoker"
echo "=============================="

gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --quiet || true

echo ""
echo "=============================="
echo "12. Show Cloud Run URL"
echo "=============================="

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"

echo ""
echo "Deployed URL:"
echo "$SERVICE_URL"

echo ""
echo "=============================="
echo "13. Recent Cloud Run logs"
echo "=============================="

gcloud run services logs read "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --limit=80 || true

echo ""
echo "=============================="
echo "DEPLOY FINISHED"
echo "Open this URL:"
echo "$SERVICE_URL"
echo "=============================="
