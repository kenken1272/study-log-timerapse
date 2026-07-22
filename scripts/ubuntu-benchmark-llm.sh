#!/usr/bin/env bash
#
# Run the aggregation-model benchmark on the Ubuntu host and fetch the results.
# Uses synthetic observation logs — no real user footage is involved.
#
set -euo pipefail

HOST="${WORKER_SSH_HOST:-suzukilab@100.74.222.81}"
ROOT="${WORKER_REMOTE_ROOT:-/home/suzukilab/study-timelapse-worker}"
CHUNKS="${CHUNKS:-60}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTRA_ARGS=("$@")

ssh -o ConnectTimeout=10 "${HOST}" "
  set -euo pipefail
  cd '${ROOT}/current'
  set -a; . '${ROOT}/config/worker.env'; set +a
  '${ROOT}/venv/bin/python' -m tools.benchmark_llm \
    --chunks '${CHUNKS}' ${EXTRA_ARGS[*]:-} \
    --out '${ROOT}/logs/benchmark-llm.json'
"

mkdir -p "${REPO_ROOT}/docs/benchmarks"
scp "${HOST}:${ROOT}/logs/benchmark-llm.json" "${REPO_ROOT}/docs/benchmarks/"
echo "==> results in docs/benchmarks/benchmark-llm.json"
