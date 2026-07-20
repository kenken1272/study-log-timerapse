"""Logging setup.

Chunk objects contain a uid, which is personal data, so object names are logged
at DEBUG only. Tokens and credentials are never logged at any level.
"""

from __future__ import annotations

import logging
import logging.handlers
import re
import sys
from pathlib import Path

# Belt-and-braces: scrub anything that looks like a bearer token or key even if
# a dependency tries to log one.
_REDACTIONS = (
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(hf_)[A-Za-z0-9]{8,}"), r"\1[REDACTED]"),
    (re.compile(r"(\"private_key\"\s*:\s*\")[^\"]+"), r"\1[REDACTED]"),
    (re.compile(r"(X-Goog-Signature=)[A-Fa-f0-9]+"), r"\1[REDACTED]"),
)


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        for pattern, replacement in _REDACTIONS:
            message = pattern.sub(replacement, message)
        return message


def configure(log_dir: Path, level: str = "INFO") -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    formatter = RedactingFormatter(
        "%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers.clear()

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    root.addHandler(stream)

    rotating = logging.handlers.RotatingFileHandler(
        log_dir / "worker.log", maxBytes=20 * 1024 * 1024, backupCount=5
    )
    rotating.setFormatter(formatter)
    root.addHandler(rotating)

    # These are chatty and occasionally echo request URLs.
    for noisy in ("google", "urllib3", "grpc"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
