"""The worker must never be able to delete a user's footage.

This was originally guaranteed twice: the dedicated service account had no
storage.objects.delete permission, and the code had no delete path. The worker
now authenticates with ADC belonging to a human account that almost certainly
*can* delete, so the IAM half of that guarantee is gone and the code is the only
thing left holding the line. These tests keep it honest.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

# Checked by reading the source rather than importing it: this must hold on a
# bare checkout with no GCP SDK installed, which is where the suite runs.
SOURCE_DIR = Path(__file__).resolve().parent.parent / "app"

# Anything that removes a GCS object. Local spool cleanup is a different thing
# and is checked separately below.
GCS_DELETE_PATTERNS = (
    re.compile(r"\.delete\s*\("),
    re.compile(r"delete_blob"),
    re.compile(r"\.delete_objects\b"),
    re.compile(r"batch_delete"),
)


def test_gcs_client_exposes_no_delete_method():
    tree = ast.parse((SOURCE_DIR / "gcs_client.py").read_text(encoding="utf-8"))
    offenders = [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and ("delete" in node.name.lower() or "remove" in node.name.lower())
    ]
    assert offenders == [], f"GcsClient must expose no delete surface, found: {offenders}"


@pytest.mark.parametrize("path", sorted(SOURCE_DIR.glob("*.py")), ids=lambda p: p.name)
def test_no_module_calls_a_gcs_delete(path: Path):
    source = path.read_text(encoding="utf-8")
    # Strip comments so prose about deletion does not trip the scan.
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )

    for pattern in GCS_DELETE_PATTERNS:
        match = pattern.search(code)
        if match is None:
            continue
        # rmtree/unlink on the local spool is expected and unrelated to GCS.
        context = code[max(0, match.start() - 200) : match.end() + 80]
        if "spool" in context or "work_dir" in context or "Path(" in context:
            continue
        pytest.fail(f"{path.name} appears to delete a GCS object: {match.group(0)!r}")


def test_spool_cleanup_is_confined_to_the_worker_root(tmp_path, monkeypatch):
    """Local cleanup must only ever touch the spool directory."""
    # app.main pulls in the GCP SDK, which a bare checkout does not have.
    pytest.importorskip("google.cloud.storage", reason="GCP SDK not installed")
    from app.main import purge_stale_spool

    class FakeSettings:
        spool_dir = tmp_path / "spool"
        spool_retention_sec = 0

    FakeSettings.spool_dir.mkdir()
    victim = FakeSettings.spool_dir / "old-chunk"
    victim.mkdir()
    outside = tmp_path / "not-the-spool"
    outside.mkdir()

    purge_stale_spool(FakeSettings())

    assert not victim.exists()
    assert outside.exists(), "cleanup must never reach outside the spool directory"
