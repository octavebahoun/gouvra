"""Secrets at rest: AES-256-GCM with a key ring held outside the database.

- The first key of `ENCRYPTION_KEYS` encrypts; every key in the ring can decrypt (rotation).
- Associated data binds a ciphertext to its owner (workspace + resource + purpose): a
  ciphertext copied into another row or workspace fails to decrypt.
- Stored layout: 12-byte nonce || ciphertext+tag; the key id is stored next to it.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from gouvra.core.config import get_settings

NONCE_BYTES = 12


class SecretDecryptionError(Exception):
    """The secret cannot be decrypted (unknown key id, tampered data or wrong owner)."""


@dataclass(frozen=True)
class EncryptedSecret:
    ciphertext: bytes
    key_id: str
    last4: str


def _aad(workspace_id: uuid.UUID, resource_id: uuid.UUID, purpose: str) -> bytes:
    return f"gouvra:{purpose}:{workspace_id}:{resource_id}".encode()


def mask_tail(secret: str) -> str:
    """Last 4 characters only, for display ("••••abcd"); empty for very short secrets."""
    return secret[-4:] if len(secret) >= 12 else ""


def encrypt_secret(
    plaintext: str, *, workspace_id: uuid.UUID, resource_id: uuid.UUID, purpose: str
) -> EncryptedSecret:
    key_id, key = get_settings().encryption_key_ring()[0]
    nonce = os.urandom(NONCE_BYTES)
    sealed = AESGCM(key).encrypt(
        nonce, plaintext.encode(), _aad(workspace_id, resource_id, purpose)
    )
    return EncryptedSecret(ciphertext=nonce + sealed, key_id=key_id, last4=mask_tail(plaintext))


def decrypt_secret(
    ciphertext: bytes, key_id: str, *, workspace_id: uuid.UUID, resource_id: uuid.UUID, purpose: str
) -> str:
    ring = dict(get_settings().encryption_key_ring())
    key = ring.get(key_id)
    if key is None:
        raise SecretDecryptionError(f"unknown key id {key_id!r}")
    nonce, sealed = ciphertext[:NONCE_BYTES], ciphertext[NONCE_BYTES:]
    try:
        return AESGCM(key).decrypt(nonce, sealed, _aad(workspace_id, resource_id, purpose)).decode()
    except InvalidTag as exc:
        raise SecretDecryptionError("integrity check failed") from exc


def active_key_id() -> str:
    return get_settings().encryption_key_ring()[0][0]
