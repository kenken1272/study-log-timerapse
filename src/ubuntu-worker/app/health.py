"""Loopback-only health endpoint.

Bound to 127.0.0.1 deliberately: this exposes queue depth and GPU state and has
no authentication, so it must never be reachable off-host.
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Callable

log = logging.getLogger(__name__)


class _Handler(BaseHTTPRequestHandler):
    snapshot: Callable[[], dict] = staticmethod(dict)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path not in ("/health", "/healthz", "/"):
            self.send_response(404)
            self.end_headers()
            return

        try:
            payload = type(self).snapshot()
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            status = 200 if payload.get("ok") else 503
        except Exception:
            log.exception("health snapshot failed")
            body = b'{"ok": false, "error": "snapshot failed"}'
            status = 503

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        # Silence per-request stderr spam from the stdlib server.
        return


class HealthServer:
    def __init__(self, port: int, snapshot: Callable[[], dict]) -> None:
        _Handler.snapshot = staticmethod(snapshot)
        self._server = HTTPServer(("127.0.0.1", port), _Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="health", daemon=True
        )

    def start(self) -> None:
        self._thread.start()
        log.info("health endpoint on http://127.0.0.1:%d/health", self._server.server_port)

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
