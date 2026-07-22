#!/usr/bin/env bash
#
# Ship the Ubuntu worker from the Mac (the only source of truth) to the lab box.
#
# The repository is never cloned on Ubuntu — only a versioned runtime copy is
# placed there, so there is exactly one place to edit code.
#
set -euo pipefail

HOST="${WORKER_SSH_HOST:-suzukilab@100.74.222.81}"
REMOTE_ROOT="${WORKER_REMOTE_ROOT:-/home/suzukilab/study-timelapse-worker}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/src/ubuntu-worker"
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "error: ${SOURCE_DIR} not found" >&2
  exit 1
fi

REVISION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git -C "${REPO_ROOT}" diff --quiet 2>/dev/null; then
  DIRTY=" (dirty)"
fi

echo "==> deploying ${SOURCE_DIR}"
echo "    revision:  ${REVISION}${DIRTY}"
echo "    target:    ${HOST}:${REMOTE_ROOT}/current"

ssh "${SSH_OPTS[@]}" "${HOST}" "
  set -euo pipefail
  umask 077
  mkdir -p '${REMOTE_ROOT}'/{current,models,state,spool,logs,config}
"

# Secrets, virtualenvs, models, footage and the queue database must never be
# overwritten by a deploy, and the repo's own metadata has no business on the
# runtime host.
rsync -az --delete \
  --exclude '.git' \
  --exclude '.git/**' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '!.env.example' \
  --exclude '.venv*' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.pytest_cache' \
  --exclude 'node_modules' \
  --exclude '*.gguf' \
  --exclude '*.safetensors' \
  --exclude '*.webm' \
  --exclude '*.mp4' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude 'id_rsa*' \
  --exclude '*.pem' \
  --exclude '*.json.key' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${SOURCE_DIR}/" "${HOST}:${REMOTE_ROOT}/current/"

ssh "${SSH_OPTS[@]}" "${HOST}" "
  set -euo pipefail
  echo '${REVISION}${DIRTY}' > '${REMOTE_ROOT}/current/REVISION'
  chmod 700 '${REMOTE_ROOT}' '${REMOTE_ROOT}/state' '${REMOTE_ROOT}/spool' '${REMOTE_ROOT}/config'
  if [[ -f '${REMOTE_ROOT}/config/worker.env' ]]; then
    chmod 600 '${REMOTE_ROOT}/config/worker.env'
  fi
  echo '==> deployed revision:' \$(cat '${REMOTE_ROOT}/current/REVISION')
"

echo "==> done"
echo "    restart with: ssh ${HOST} 'systemctl --user restart study-timelapse-worker'"
