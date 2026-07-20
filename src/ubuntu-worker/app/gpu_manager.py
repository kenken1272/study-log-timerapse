"""GPU accounting and cross-process exclusion.

Two models compete for two cards. The VLM owns its GPU and must stay warm to
hold the 25s SLO; the LLM runs in bursts. A file lock (not an in-process flag)
guards the exclusive case, so a second worker instance cannot double-load.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from filelock import FileLock, Timeout

log = logging.getLogger(__name__)


class GpuBusy(Exception):
    pass


def _nvidia_smi(query: str, extra: list[str] | None = None) -> list[str]:
    if shutil.which("nvidia-smi") is None:
        return []
    args = ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"]
    if extra:
        args = ["nvidia-smi", *extra, "--format=csv,noheader,nounits"]
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def gpu_uuids() -> dict[int, str]:
    """Map index -> UUID so a reboot that renumbers the cards is detectable."""
    mapping: dict[int, str] = {}
    for line in _nvidia_smi("index,uuid"):
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2:
            mapping[int(parts[0])] = parts[1]
    return mapping


def memory_used_mib() -> dict[int, int]:
    usage: dict[int, int] = {}
    for line in _nvidia_smi("index,memory.used"):
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2:
            usage[int(parts[0])] = int(parts[1])
    return usage


def memory_free_mib(index: int) -> int:
    for line in _nvidia_smi("index,memory.free"):
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2 and int(parts[0]) == index:
            return int(parts[1])
    return 0


def compute_process_count() -> int:
    lines = _nvidia_smi("", extra=["--query-compute-apps=pid"])
    return len(lines)


def peak_vram_mib(index: int) -> int:
    return memory_used_mib().get(index, 0)


class GpuLock:
    """Cross-process exclusion for the whole-machine LLM mode."""

    def __init__(self, root: Path, name: str = "gpu-exclusive") -> None:
        root.mkdir(parents=True, exist_ok=True)
        self._lock = FileLock(str(root / f"{name}.lock"))

    @contextmanager
    def acquire(self, timeout: float = 0.0) -> Iterator[None]:
        try:
            self._lock.acquire(timeout=timeout)
        except Timeout as error:
            raise GpuBusy("another process holds the exclusive GPU lock") from error
        try:
            yield
        finally:
            self._lock.release()
