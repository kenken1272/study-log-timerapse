#!/usr/bin/env bash
#
# Prepare the Ubuntu runtime: virtualenv, pinned dependencies, directory layout.
# Idempotent — safe to re-run after every deploy.
#
# Torch is installed separately from the rest because the correct wheel depends
# on the host CUDA runtime, and pinning it in pyproject.toml would be wrong on
# any other machine.
#
set -euo pipefail

ROOT="${WORKER_ROOT:-/home/suzukilab/study-timelapse-worker}"
VENV="${ROOT}/venv"
CURRENT="${ROOT}/current"
# cu121 wheels run correctly on the newer driver present on this host and are
# the last line with solid Turing (sm_75) support.
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu121}"

log() { printf '\n==> %s\n' "$*"; }

umask 077
mkdir -p "${ROOT}"/{current,models,state,spool,logs,config}
chmod 700 "${ROOT}" "${ROOT}/state" "${ROOT}/spool" "${ROOT}/config"

log "host"
hostname
uname -sr
lsb_release -ds 2>/dev/null || true

log "GPUs"
nvidia-smi --query-gpu=index,name,uuid,memory.total,memory.used --format=csv,noheader

log "disk"
df -h "${ROOT}" | tail -1

log "tooling"
for tool in python3 ffmpeg ffprobe gcloud; do
  if command -v "${tool}" >/dev/null 2>&1; then
    printf '  %-8s %s\n' "${tool}" "$(command -v "${tool}")"
  else
    printf '  %-8s MISSING\n' "${tool}"
  fi
done

if [[ ! -d "${VENV}" ]]; then
  log "creating virtualenv"
  python3 -m venv "${VENV}"
fi

log "installing dependencies"
"${VENV}/bin/pip" install --quiet --upgrade pip wheel

if [[ ! -f "${CURRENT}/pyproject.toml" ]]; then
  echo "error: ${CURRENT}/pyproject.toml missing — run deploy-ubuntu-worker.sh first" >&2
  exit 1
fi

"${VENV}/bin/pip" install --quiet -e "${CURRENT}[dev]"

log "installing torch (${TORCH_INDEX})"
if ! "${VENV}/bin/python" -c "import torch" 2>/dev/null; then
  "${VENV}/bin/pip" install --quiet torch==2.4.1 torchvision==0.19.1 --index-url "${TORCH_INDEX}"
else
  echo "  already installed"
fi

log "installing VLM extras"
"${VENV}/bin/pip" install --quiet -e "${CURRENT}[vlm]"

log "verifying CUDA is visible to torch"
"${VENV}/bin/python" - <<'PY'
import torch

print(f"  torch            {torch.__version__}")
print(f"  cuda available   {torch.cuda.is_available()}")
print(f"  cuda version     {torch.version.cuda}")
for index in range(torch.cuda.device_count()):
    name = torch.cuda.get_device_name(index)
    major, minor = torch.cuda.get_device_capability(index)
    total = torch.cuda.get_device_properties(index).total_memory / 1024**3
    # sm_75 (Turing) has no bf16 path — the runtime uses fp16 for this reason.
    bf16 = "yes" if major >= 8 else "no (fp16 required)"
    print(f"  cuda:{index}           {name} sm_{major}{minor} {total:.1f}GiB bf16={bf16}")
PY

log "running unit tests"
cd "${CURRENT}" && "${VENV}/bin/python" -m pytest -q

log "preflight complete"
echo "Next: place credentials in ${ROOT}/config/worker.env (chmod 600), then"
echo "      systemctl --user start study-timelapse-worker"
