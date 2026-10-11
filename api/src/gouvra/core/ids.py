"""Identifier helpers."""

from __future__ import annotations

import hashlib
import secrets
import time
import uuid


def uuid7() -> uuid.UUID:
    """Time-ordered UUID (RFC 9562, version 7): index-friendly and sortable by creation time."""
    unix_ms = time.time_ns() // 1_000_000
    raw = bytearray(unix_ms.to_bytes(6, "big") + secrets.token_bytes(10))
    raw[6] = (raw[6] & 0x0F) | 0x70  # version 7
    raw[8] = (raw[8] & 0x3F) | 0x80  # RFC 4122 variant
    return uuid.UUID(bytes=bytes(raw))


def new_token(nbytes: int = 32) -> str:
    """Opaque, URL-safe random token (256 bits by default)."""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Tokens are stored only as SHA-256 digests: a database leak does not leak live tokens."""
    return hashlib.sha256(token.encode()).hexdigest()
