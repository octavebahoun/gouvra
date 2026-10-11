"""Webhook signatures.

Gouvra's format (the default), like Stripe's: `Gouvra-Signature: t=<unix seconds>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, "<t>." + raw body)`. The timestamp is signed, so a captured request
cannot be replayed after the tolerance window, and within it the same signature is recognised
as the same delivery. Several `v1` values may be sent (e.g. while rotating secrets).

GitHub's format is also accepted for hooks configured with it: `X-Hub-Signature-256:
sha256=<hex>` over the raw body; replays are caught by the delivery id (`X-GitHub-Delivery`).
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

GOUVRA_HEADER = "gouvra-signature"
GITHUB_HEADER = "x-hub-signature-256"
TOLERANCE_S = 300


@dataclass(frozen=True)
class Verdict:
    ok: bool
    code: str | None = None
    message: str | None = None
    timestamp: int | None = None
    digest: str | None = None


def _hmac(secret: str, payload: bytes) -> str:
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def sign(secret: str, body: bytes, timestamp: int) -> str:
    """The header value a sender computes (documented, and used by test deliveries)."""
    return f"t={timestamp},v1={_hmac(secret, f'{timestamp}.'.encode() + body)}"


def sign_github(secret: str, body: bytes) -> str:
    return f"sha256={_hmac(secret, body)}"


def verify_gouvra(secret: str, header: str | None, body: bytes, now: float) -> Verdict:
    if not header:
        return Verdict(False, "missing_signature", "The Gouvra-Signature header is missing.")
    parts: dict[str, list[str]] = {}
    for item in header.split(","):
        key, _, value = item.strip().partition("=")
        parts.setdefault(key, []).append(value)
    try:
        timestamp = int(parts["t"][0])
    except (KeyError, ValueError):
        return Verdict(False, "malformed_signature", "The signature has no valid timestamp.")
    if abs(now - timestamp) > TOLERANCE_S:
        return Verdict(
            False,
            "stale_signature",
            "The signature is older than 5 minutes (or the sender's clock is off).",
            timestamp,
        )
    expected = _hmac(secret, f"{timestamp}.".encode() + body)
    for candidate in parts.get("v1", []):
        if hmac.compare_digest(expected, candidate):
            return Verdict(True, timestamp=timestamp, digest=expected)
    return Verdict(False, "invalid_signature", "The signature does not match the body.", timestamp)


def verify_github(secret: str, header: str | None, body: bytes) -> Verdict:
    if not header or not header.startswith("sha256="):
        return Verdict(False, "missing_signature", "The X-Hub-Signature-256 header is missing.")
    expected = _hmac(secret, body)
    if hmac.compare_digest(expected, header.removeprefix("sha256=")):
        return Verdict(True, digest=expected)
    return Verdict(False, "invalid_signature", "The signature does not match the body.")
