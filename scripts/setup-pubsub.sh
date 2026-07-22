#!/usr/bin/env bash
#
# Create the GCS -> Pub/Sub plumbing the Ubuntu worker pulls from.
#
# Lists what already exists first and prints a plan before changing anything.
# Run with PLAN_ONLY=1 to see the diff without applying it.
#
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
BUCKET="${GCS_BUCKET_NAME:?set GCS_BUCKET_NAME}"
TOPIC="${PUBSUB_TOPIC:-study-timelapse-chunks}"
SUBSCRIPTION="${PUBSUB_SUBSCRIPTION:-study-timelapse-chunks-sub}"
DEAD_LETTER_TOPIC="${PUBSUB_DLQ_TOPIC:-study-timelapse-chunks-dlq}"
WORKER_SA="${WORKER_SERVICE_ACCOUNT:-study-timelapse-worker}"
WORKER_SA_EMAIL="${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
PLAN_ONLY="${PLAN_ONLY:-0}"

# Chunks only. Without this prefix the worker would receive notifications for
# its own analysis writes and loop.
NOTIFICATION_PREFIX="users/"
ACK_DEADLINE=600
RETENTION="7d"

log() { printf '\n==> %s\n' "$*"; }
apply() {
  if [[ "${PLAN_ONLY}" == "1" ]]; then
    printf '  [plan] %s\n' "$*"
  else
    printf '  %s\n' "$*"
    "$@"
  fi
}

log "existing resources in ${PROJECT_ID}"
echo "  topics:"
gcloud pubsub topics list --project "${PROJECT_ID}" --format='value(name)' | sed 's/^/    /' || true
echo "  subscriptions:"
gcloud pubsub subscriptions list --project "${PROJECT_ID}" --format='value(name)' | sed 's/^/    /' || true
echo "  notifications on gs://${BUCKET}:"
gcloud storage buckets notifications list "gs://${BUCKET}" --format='value(id,topic,payload_format)' 2>/dev/null | sed 's/^/    /' || echo "    (none)"

log "plan"
cat <<PLAN
  topic          ${TOPIC}
  dlq topic      ${DEAD_LETTER_TOPIC}
  subscription   ${SUBSCRIPTION} (pull, ack deadline ${ACK_DEADLINE}s, retention ${RETENTION})
  notification   gs://${BUCKET} OBJECT_FINALIZE, prefix '${NOTIFICATION_PREFIX}'
  service acct   ${WORKER_SA_EMAIL}
  IAM granted    roles/pubsub.subscriber on ${SUBSCRIPTION}
                 roles/storage.objectViewer on gs://${BUCKET}
                 roles/storage.objectCreator on gs://${BUCKET}

  Deliberately NOT granted: storage.objects.delete. The worker must never be
  able to remove a user's footage.

  Cost: Pub/Sub is billed per message volume; one 30s chunk produces one
  message. A 2-hour session is ~240 messages, far inside the free tier.

  Teardown:
    gcloud storage buckets notifications delete gs://${BUCKET}/notificationConfigs/<id>
    gcloud pubsub subscriptions delete ${SUBSCRIPTION}
    gcloud pubsub topics delete ${TOPIC} ${DEAD_LETTER_TOPIC}
PLAN

if [[ "${PLAN_ONLY}" == "1" ]]; then
  log "PLAN_ONLY=1; nothing changed"
  exit 0
fi

log "creating topics"
gcloud pubsub topics describe "${TOPIC}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || apply gcloud pubsub topics create "${TOPIC}" --project "${PROJECT_ID}"
gcloud pubsub topics describe "${DEAD_LETTER_TOPIC}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || apply gcloud pubsub topics create "${DEAD_LETTER_TOPIC}" --project "${PROJECT_ID}"

log "granting GCS permission to publish"
# The command emits surrounding whitespace, which makes the IAM member string
# invalid and produces a misleading "service account does not exist" error.
GCS_SA="$(gcloud storage service-agent --project "${PROJECT_ID}" | tr -d '[:space:]')"
apply gcloud pubsub topics add-iam-policy-binding "${TOPIC}" \
  --project "${PROJECT_ID}" \
  --member="serviceAccount:${GCS_SA}" \
  --role=roles/pubsub.publisher

log "creating subscription"
if gcloud pubsub subscriptions describe "${SUBSCRIPTION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists"
else
  # Long ack deadline: a chunk can sit behind a 25s VLM run and an LLM burst.
  apply gcloud pubsub subscriptions create "${SUBSCRIPTION}" \
    --project "${PROJECT_ID}" \
    --topic "${TOPIC}" \
    --ack-deadline="${ACK_DEADLINE}" \
    --message-retention-duration="${RETENTION}" \
    --dead-letter-topic="${DEAD_LETTER_TOPIC}" \
    --max-delivery-attempts=10
fi

log "creating bucket notification"
if gcloud storage buckets notifications list "gs://${BUCKET}" --format='value(topic)' 2>/dev/null \
    | grep -q "${TOPIC}$"; then
  echo "  already exists"
else
  apply gcloud storage buckets notifications create "gs://${BUCKET}" \
    --topic="${TOPIC}" \
    --event-types=OBJECT_FINALIZE \
    --object-prefix="${NOTIFICATION_PREFIX}" \
    --payload-format=json
fi

log "creating worker service account"
if gcloud iam service-accounts describe "${WORKER_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists"
else
  apply gcloud iam service-accounts create "${WORKER_SA}" \
    --project "${PROJECT_ID}" \
    --display-name="Study Timelapse Ubuntu worker"
fi

log "granting least-privilege IAM"
apply gcloud pubsub subscriptions add-iam-policy-binding "${SUBSCRIPTION}" \
  --project "${PROJECT_ID}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role=roles/pubsub.subscriber
apply gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role=roles/storage.objectViewer
apply gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role=roles/storage.objectCreator

log "done"
cat <<'NEXT'
The worker still needs credentials on the Ubuntu host. Preferred order:

  1. Workload Identity Federation (no long-lived key material), or
  2. gcloud auth application-default login  (interactive, user-scoped), or
  3. a service account key file — least preferred; if used, keep it at
     ~/study-timelapse-worker/config/ with mode 600 and never commit it.
NEXT
