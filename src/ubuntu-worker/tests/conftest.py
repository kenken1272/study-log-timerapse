"""Shared fixtures.

Helper *functions* live in helpers.py rather than here: importing them as
`tests.conftest` resolved to an installed copy under site-packages on the
Ubuntu host and shadowed the real one.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.queue_db import QueueDB


@pytest.fixture()
def db(tmp_path: Path) -> QueueDB:
    database = QueueDB(tmp_path / "pipeline.db")
    yield database
    database.close()
