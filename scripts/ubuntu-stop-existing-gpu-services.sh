#!/usr/bin/env bash
#
# Gracefully stop whatever currently holds the GPUs, so the analysis pipeline
# can have them.
#
# Design rules, all deliberate:
#   * nothing is deleted — not files, not conda envs, not model weights
#   * no PID is hardcoded; targets are discovered and identity-checked
#   * no `kill -9`, no `pkill -f python`, no `killall`
#   * restart information is recorded before anything is signalled
#
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
RESTORE_DIR="${RESTORE_DIR:-/home/suzukilab/study-timelapse-worker/state}"
TARGET_PORTS=(50051 8787 11434)

log() { printf '%s\n' "$*"; }
run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "  [dry-run] $*"
  else
    "$@"
  fi
}

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "error: nvidia-smi not found; is this the right host?" >&2
  exit 1
fi

mkdir -p "${RESTORE_DIR}"
RESTORE_FILE="${RESTORE_DIR}/gpu-restore-$(date +%Y%m%d-%H%M%S).txt"
umask 077

log "==> current GPU state"
nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader

mapfile -t GPU_PIDS < <(
  nvidia-smi --query-compute-apps=pid --format=csv,noheader | tr -d ' ' | grep -E '^[0-9]+$' || true
)

if [[ ${#GPU_PIDS[@]} -eq 0 ]]; then
  log "==> no GPU compute processes; nothing to stop"
else
  log "==> found ${#GPU_PIDS[@]} GPU compute process(es)"
fi

{
  echo "# GPU services stopped for study-timelapse pipeline on $(date -Is)"
  echo "# Recorded before any signal was sent. Use these to restore."
} > "${RESTORE_FILE}"

for PID in "${GPU_PIDS[@]}"; do
  OWNER="$(ps -o user= -p "${PID}" 2>/dev/null | tr -d ' ' || true)"
  EXE="$(readlink -f "/proc/${PID}/exe" 2>/dev/null || true)"
  CWD="$(readlink -f "/proc/${PID}/cwd" 2>/dev/null || true)"

  if [[ -z "${EXE}" ]]; then
    log "  skip ${PID}: cannot read identity"
    continue
  fi
  # Only ever touch this user's own processes.
  if [[ "${OWNER}" != "${USER}" ]]; then
    log "  skip ${PID}: owned by ${OWNER}, not ${USER}"
    continue
  fi

  {
    echo ""
    echo "## PID ${PID}"
    echo "exe:     ${EXE}"
    echo "cwd:     ${CWD}"
    echo "started: $(ps -o lstart= -p "${PID}" 2>/dev/null || true)"
    echo "argv:"
    tr '\0' ' ' < "/proc/${PID}/cmdline" 2>/dev/null || true
    echo ""
  } >> "${RESTORE_FILE}"

  log "  stopping ${PID} (${EXE})"
  run kill -TERM "${PID}"
done

if [[ ${#GPU_PIDS[@]} -gt 0 && "${DRY_RUN}" != "1" ]]; then
  log "==> waiting up to 30s for graceful exit"
  for _ in $(seq 1 30); do
    STILL_ALIVE=0
    for PID in "${GPU_PIDS[@]}"; do
      kill -0 "${PID}" 2>/dev/null && STILL_ALIVE=1
    done
    [[ "${STILL_ALIVE}" -eq 0 ]] && break
    sleep 1
  done

  for PID in "${GPU_PIDS[@]}"; do
    if kill -0 "${PID}" 2>/dev/null; then
      # Escalation is a human decision, not this script's.
      log "  WARNING: ${PID} did not exit on SIGTERM."
      log "           Investigate before considering anything stronger."
    fi
  done
fi

# Ollama is a system unit and needs sudo, which this script never supplies
# non-interactively.
if systemctl is-active --quiet ollama 2>/dev/null; then
  echo "sudo systemctl start ollama   # was active before this run" >> "${RESTORE_FILE}"
  log "==> ollama.service is active"
  if sudo -n true 2>/dev/null; then
    run sudo systemctl stop ollama
    log "  stopped ollama.service"
  else
    log "  NOTE: stopping ollama needs a password. Run manually if required:"
    log "        sudo systemctl stop ollama"
    log "  (ollama holds no VRAM while no model is loaded, so this is optional.)"
  fi
fi

chmod 600 "${RESTORE_FILE}"

log ""
log "==> resulting GPU state"
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
log ""
log "==> remaining compute processes:"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader || true
log ""
log "==> target ports still listening:"
ss -lntp 2>/dev/null | grep -E ":($(IFS='|'; echo "${TARGET_PORTS[*]}"))([[:space:]]|$)" || log "  (none)"
log ""
log "==> restore information: ${RESTORE_FILE}"
