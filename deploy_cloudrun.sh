#!/bin/bash
set -euo pipefail

echo "=============================="
echo "0. Variables"
echo "=============================="

read_env() {
  node -e '
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
process.stdout.write(process.env[process.argv[1]] || "");
' "$1"
}

export PROJECT_ID="${PROJECT_ID:-$(read_env GCP_PROJECT_ID)}"
export PROJECT_ID="${PROJECT_ID:-vla-test1}"
export PROJECT_NUMBER="${PROJECT_NUMBER:-116342725707}"
export REGION="${REGION:-asia-northeast1}"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="${GCS_BUCKET_NAME:-$(read_env GCS_BUCKET_NAME)}"
export BUCKET_NAME="${BUCKET_NAME:-vla-test1-study-timelapse}"
export CLOUD_TASKS_QUEUE="${CLOUD_TASKS_QUEUE:-$(read_env CLOUD_TASKS_QUEUE)}"
export CLOUD_TASKS_QUEUE="${CLOUD_TASKS_QUEUE:-timelapse-processing}"
export CLOUD_TASKS_LOCATION="${CLOUD_TASKS_LOCATION:-$(read_env CLOUD_TASKS_LOCATION)}"
export CLOUD_TASKS_LOCATION="${CLOUD_TASKS_LOCATION:-$REGION}"
export CLOUD_RUN_SERVICE_URL="${CLOUD_RUN_SERVICE_URL:-$(read_env CLOUD_RUN_SERVICE_URL)}"
export CLOUD_RUN_SERVICE_URL="${CLOUD_RUN_SERVICE_URL:-https://study-timelapse-116342725707.asia-northeast1.run.app}"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export COMPUTE_DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "PROJECT_ID=$PROJECT_ID"
echo "PROJECT_NUMBER=$PROJECT_NUMBER"
echo "REGION=$REGION"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "CLOUD_TASKS_QUEUE=$CLOUD_TASKS_QUEUE"
echo "CLOUD_TASKS_LOCATION=$CLOUD_TASKS_LOCATION"
echo "CLOUD_RUN_SERVICE_URL=$CLOUD_RUN_SERVICE_URL"
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
  cloudtasks.googleapis.com \
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

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" \
  --quiet

echo ""
echo "=============================="
echo "8. Ensure Cloud Tasks queue"
echo "=============================="

if gcloud tasks queues describe "$CLOUD_TASKS_QUEUE" \
  --location="$CLOUD_TASKS_LOCATION" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Cloud Tasks queue already exists: $CLOUD_TASKS_QUEUE"
else
  gcloud tasks queues create "$CLOUD_TASKS_QUEUE" \
    --location="$CLOUD_TASKS_LOCATION" \
    --project="$PROJECT_ID" \
    --max-dispatches-per-second=1 \
    --max-concurrent-dispatches=1 \
    --max-attempts=3
fi

echo ""
echo "=============================="
echo "9. Grant Cloud Build / Cloud Run build permission"
echo "=============================="

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${COMPUTE_DEFAULT_SA}" \
  --role="roles/run.builder" \
  --quiet

echo ""
echo "=============================="
echo "10. Local build check"
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
echo "11. Deploy to Cloud Run"
echo "=============================="

RUNTIME_ENV_FILE="$(mktemp)"
BUILD_ENV_FILE="$(mktemp)"
cleanup_env_files() {
  rm -f "$RUNTIME_ENV_FILE" "$BUILD_ENV_FILE"
}
trap cleanup_env_files EXIT

node - "$RUNTIME_ENV_FILE" "$BUILD_ENV_FILE" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

process.env.GCP_PROJECT_ID ||= process.env.PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID;
process.env.GCS_BUCKET_NAME ||= process.env.BUCKET_NAME;
process.env.CLOUD_RUN_SERVICE_URL ||= process.env.CLOUD_RUN_SERVICE_URL;
process.env.CLOUD_TASKS_QUEUE ||= process.env.CLOUD_TASKS_QUEUE;
process.env.CLOUD_TASKS_LOCATION ||= process.env.CLOUD_TASKS_LOCATION;
process.env.INTERNAL_PROCESS_SECRET ||= crypto.randomBytes(32).toString("hex");

const runtimeFile = process.argv[2];
const buildFile = process.argv[3];
const runtimeKeys = [
  "GCP_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCS_BUCKET_NAME",
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "VERTEX_LOCATION",
  "VERTEX_MODEL",
  "ANALYSIS_MAX_OUTPUT_TOKENS",
  "INTERNAL_PROCESS_SECRET",
  "CLOUD_RUN_SERVICE_URL",
  "CLOUD_TASKS_QUEUE",
  "CLOUD_TASKS_LOCATION",
];
const buildKeys = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
];

function writeYaml(file, keys) {
  const lines = keys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(process.env[key] ?? "")}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

writeYaml(runtimeFile, runtimeKeys);
writeYaml(buildFile, buildKeys);
NODE

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
  --env-vars-file="$RUNTIME_ENV_FILE" \
  --build-env-vars-file="$BUILD_ENV_FILE"

echo ""
echo "=============================="
echo "12. Ensure public invoker"
echo "=============================="

gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --quiet || true

echo ""
echo "=============================="
echo "13. Show Cloud Run URL"
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
echo "14. Recent Cloud Run logs"
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
