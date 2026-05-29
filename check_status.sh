#!/bin/bash

echo "=============================="
echo "1. Current directory"
echo "=============================="
pwd
ls -la

echo ""
echo "=============================="
echo "2. Node / npm"
echo "=============================="
node -v || true
npm -v || true

echo ""
echo "=============================="
echo "3. Project files"
echo "=============================="
test -f package.json && echo "package.json OK" || echo "package.json NOT FOUND"
test -f Dockerfile && echo "Dockerfile OK" || echo "Dockerfile NOT FOUND"
test -f next.config.ts && echo "next.config.ts OK" || echo "next.config.ts NOT FOUND"
test -d src && echo "src directory OK" || echo "src directory NOT FOUND"

echo ""
echo "=============================="
echo "4. Git status"
echo "=============================="
git status || true
git remote -v || true

echo ""
echo "=============================="
echo "5. GCloud account / project"
echo "=============================="
gcloud auth list || true
gcloud config get-value project || true
gcloud config get-value account || true

echo ""
echo "=============================="
echo "6. Set variables"
echo "=============================="
export PROJECT_ID="vla-test1"
export PROJECT_NUMBER="116342725707"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "PROJECT_ID=$PROJECT_ID"
echo "PROJECT_NUMBER=$PROJECT_NUMBER"
echo "REGION=$REGION"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "BUCKET_NAME=$BUCKET_NAME"
echo "SA_EMAIL=$SA_EMAIL"

echo ""
echo "=============================="
echo "7. Enabled APIs"
echo "=============================="
gcloud services list --enabled \
  --filter="name:(run.googleapis.com OR cloudbuild.googleapis.com OR artifactregistry.googleapis.com OR storage.googleapis.com OR firestore.googleapis.com OR iamcredentials.googleapis.com OR billingbudgets.googleapis.com OR cloudbilling.googleapis.com)" \
  --format="table(config.name,state)" \
  --project="$PROJECT_ID" || true

echo ""
echo "=============================="
echo "8. Firestore database"
echo "=============================="
gcloud firestore databases list --project="$PROJECT_ID" || true

echo ""
echo "=============================="
echo "9. GCS bucket"
echo "=============================="
gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="$PROJECT_ID" || true

echo ""
echo "=============================="
echo "10. Service account"
echo "=============================="
gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" || true

echo ""
echo "=============================="
echo "11. Cloud Run service"
echo "=============================="
gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" || true

echo ""
echo "=============================="
echo "12. IAM check rough"
echo "=============================="
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:study-timelapse-sa OR bindings.members:60027153aa@gmail.com OR bindings.members:116342725707-compute" \
  --format="table(bindings.role,bindings.members)" || true

echo ""
echo "=============================="
echo "13. package scripts"
echo "=============================="
npm run || true

echo ""
echo "=============================="
echo "14. Local build check"
echo "=============================="
npm install

if npm run | grep -q "lint"; then
  npm run lint
else
  echo "lint script not found. skip."
fi

if npm run | grep -q "typecheck"; then
  npm run typecheck
else
  echo "typecheck script not found. skip."
fi

npm run build

echo ""
echo "=============================="
echo "CHECK FINISHED"
echo "=============================="
