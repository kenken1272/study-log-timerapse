#!/usr/bin/env bash
#
# Run the VLM profile benchmark on the Ubuntu host and fetch the results.
#
set -euo pipefail

HOST="${WORKER_SSH_HOST:-suzukilab@100.74.222.81}"
ROOT="${WORKER_REMOTE_ROOT:-/home/suzukilab/study-timelapse-worker}"
CHUNK="${1:-}"
REPEAT="${REPEAT:-3}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${CHUNK}" ]]; then
  echo "usage: $0 <path-to-chunk.webm-on-ubuntu>" >&2
  echo "  (upload a permitted test chunk first; do not use another user's footage)" >&2
  exit 1
fi

ssh -o ConnectTimeout=10 "${HOST}" "
  set -euo pipefail
  cd '${ROOT}/current'
  set -a; . '${ROOT}/config/worker.env'; set +a
  '${ROOT}/venv/bin/python' -m tools.benchmark_vlm \
    --chunk '${CHUNK}' --repeat '${REPEAT}' \
    --out '${ROOT}/logs/benchmark-vlm.json'
"

mkdir -p "${REPO_ROOT}/docs/benchmarks"
scp "${HOST}:${ROOT}/logs/benchmark-vlm.json" "${REPO_ROOT}/docs/benchmarks/"
echo "==> results in docs/benchmarks/benchmark-vlm.json"
