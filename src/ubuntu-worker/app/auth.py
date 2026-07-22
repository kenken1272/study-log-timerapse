"""Credentials for the worker.

ADC on this host belongs to a human account, which can delete bucket objects.
Rather than run with that authority, the worker impersonates a least-privilege
service account that has subscribe + object read + object create and no delete.

Impersonation is used specifically so that **no service account key file is
ever created**: ADC mints a short-lived token for the target account on demand.
Nothing long-lived is written to disk, copied, or committed.

Set IMPERSONATE_SERVICE_ACCOUNT to enable. Unset, the worker falls back to
plain ADC and logs a warning — that still works, but without the delete-proof
guarantee, so it should not be the production configuration.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def target_service_account() -> str | None:
    value = os.environ.get("IMPERSONATE_SERVICE_ACCOUNT", "").strip()
    return value or None


def build_credentials(scopes: list[str] | None = None):
    """Return credentials for GCS/Pub/Sub, impersonating when configured.

    Returns None to mean "let the client library use ADC itself", which keeps
    the call sites simple in the unimpersonated case.
    """
    target = target_service_account()
    if not target:
        log.warning(
            "IMPERSONATE_SERVICE_ACCOUNT is not set; running with raw ADC. "
            "This grants the worker the operator's own permissions."
        )
        return None

    import google.auth
    from google.auth import impersonated_credentials

    source, _project = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
    credentials = impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=target,
        target_scopes=scopes or [CLOUD_PLATFORM_SCOPE],
        # Short-lived by design; refreshed automatically.
        lifetime=3600,
    )
    log.info("impersonating %s", target)
    return credentials


def describe() -> str:
    target = target_service_account()
    return f"impersonating {target}" if target else "raw ADC (no impersonation)"
