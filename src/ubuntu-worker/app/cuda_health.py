"""Classifying CUDA failures that a process cannot recover from.

Some CUDA errors are *sticky*: once raised, the CUDA context is poisoned and
**every subsequent CUDA call in that process fails with the same error**, on
every device, regardless of what the new call is doing.

This is not theoretical. In production a single Xid 13 (misaligned address) on
GPU1 during aggregation was followed two seconds later by the VLM failing on
GPU0 — a different device, different model, valid input. The worker caught the
exception and retried in the same process, so all five retries of four chunks
ran against an already-dead context and dead-lettered work that was never
actually broken. Re-running one of those chunks in a fresh process succeeded
first time.

The only correct response is to stop using this process. The queue is durable,
so exiting non-zero costs a restart and nothing else; systemd brings the worker
back with a fresh CUDA context and the work resumes.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# Substrings that indicate the CUDA context is unusable from here on.
# Deliberately narrow: a plain OOM is recoverable and must not land here, or
# the worker would restart on ordinary memory pressure.
FATAL_CUDA_MARKERS = (
    "misaligned address",
    "an illegal memory access",
    "illegal memory access was encountered",
    "device-side assert triggered",
    "unspecified launch failure",
    "ECC uncorrectable",
    "uncorrectable ECC error",
    "CUDA error: unknown error",
)

# Exit code the worker uses for "this process is done, start a new one".
# Distinct from 1 so it is identifiable in journalctl.
FATAL_CUDA_EXIT_CODE = 70


class FatalCudaError(Exception):
    """The CUDA context is poisoned; this process must not continue."""

    def __init__(self, original: BaseException) -> None:
        super().__init__(str(original))
        self.original = original


def is_fatal_cuda_error(error: BaseException) -> bool:
    """True when the error corrupts the CUDA context for the whole process.

    Matched on message text because PyTorch surfaces all of these as a plain
    RuntimeError — there is no distinct exception type to key on. An OOM is
    explicitly excluded: it is recoverable and handled by the fallback ladder.
    """
    text = str(error)
    if "out of memory" in text.lower():
        return False
    return any(marker.lower() in text.lower() for marker in FATAL_CUDA_MARKERS)


def raise_if_fatal(error: BaseException) -> None:
    """Re-raise as FatalCudaError when the context is gone, else return."""
    if is_fatal_cuda_error(error):
        log.critical(
            "fatal CUDA error — the context is poisoned and this process cannot "
            "continue; exiting so a fresh one takes over: %s",
            str(error).splitlines()[0] if str(error) else error,
        )
        raise FatalCudaError(error) from error
