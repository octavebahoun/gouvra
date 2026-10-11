"""Password hashing (Argon2id), password policy, session cookies and CSRF tokens."""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Response

from gouvra.core.config import Settings, get_settings

# RFC 9106 "second recommended option": m = 64 MiB, t = 3, p = 4.
_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16)
# Verified when the e-mail is unknown so that response times do not reveal whether it exists.
_DUMMY_HASH = _hasher.hash("gouvra-timing-equaliser")

PASSWORD_MIN = 10
PASSWORD_MAX = 128

# Most common passwords (NIST 800-63B asks to refuse known-weak values).
_COMMON_PASSWORDS = frozenset(
    {
        "password",
        "password1",
        "password12",
        "password123",
        "password1234",
        "passw0rd",
        "p@ssw0rd",
        "p@ssword",
        "123456789",
        "1234567890",
        "12345678",
        "123456",
        "1234567",
        "qwerty123",
        "qwertyuiop",
        "qwerty1234",
        "azerty123",
        "azertyuiop",
        "1q2w3e4r5t",
        "1qaz2wsx3edc",
        "iloveyou",
        "iloveyou1",
        "sunshine1",
        "princess1",
        "football1",
        "baseball1",
        "welcome1",
        "welcome123",
        "letmein123",
        "trustno1",
        "dragon123",
        "monkey123",
        "master123",
        "superman1",
        "starwars1",
        "whatever1",
        "freedom123",
        "abc123456",
        "abcdefghij",
        "0123456789",
        "9876543210",
        "aaaaaaaaaa",
        "1111111111",
        "0000000000",
        "changeme123",
        "changeme",
        "administrator",
        "admin12345",
        "adminadmin",
        "motdepasse",
        "motdepasse1",
        "motdepasse123",
        "soleil123",
        "bonjour123",
        "doudou123",
        "loulou1234",
        "chouchou12",
        "nicolas123",
        "marseille13",
        "football12",
        "qwerty12345",
        "gouvra1234",
        "gouvra12345",
        "agenthub123",
        "letmein!23",
        "welcome2026",
        "summer2026",
        "winter2026",
        "autumn2026",
        "spring2026",
        "password2026",
        "password!",
        "passwordpassword",
    }
)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Constant-shape verification: an unknown account costs the same as a wrong password."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def password_problems(password: str, email: str | None = None) -> list[str]:
    """Return machine-readable reasons why a password is refused (empty list = accepted)."""
    problems: list[str] = []
    if len(password) < PASSWORD_MIN:
        problems.append("too_short")
    if len(password) > PASSWORD_MAX:
        problems.append("too_long")
    if not password.strip():
        problems.append("blank")
    lowered = password.lower()
    if lowered in _COMMON_PASSWORDS or len(set(lowered)) <= 2:
        problems.append("too_common")
    if email:
        local = email.split("@", 1)[0].lower()
        if lowered == email.lower() or (len(local) >= 4 and local in lowered):
            problems.append("contains_email")
    return problems


# ---------------------------------------------------------------- cookies & CSRF


@dataclass(frozen=True)
class CookieNames:
    session: str
    csrf: str


def cookie_names(settings: Settings | None = None) -> CookieNames:
    """`__Host-` cookies are bound to the exact origin (no Domain, Path=/, Secure)."""
    settings = settings or get_settings()
    prefix = "__Host-" if settings.cookie_secure else ""
    return CookieNames(session=f"{prefix}gv_session", csrf=f"{prefix}gv_csrf")


def csrf_token_for(session_token_hash: str) -> str:
    """CSRF token bound to the session (HMAC), so a planted cookie cannot be replayed."""
    key = get_settings().session_secret.get_secret_value().encode()
    return hmac.new(key, f"csrf:{session_token_hash}".encode(), hashlib.sha256).hexdigest()


def csrf_matches(session_token_hash: str, provided: str | None) -> bool:
    return bool(provided) and hmac.compare_digest(
        csrf_token_for(session_token_hash), provided or ""
    )


def set_session_cookies(response: Response, token: str, token_hash: str, max_age: int) -> None:
    settings = get_settings()
    names = cookie_names(settings)
    response.set_cookie(
        names.session,
        token,
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    # Readable by the web app, which echoes it in the X-CSRF-Token header.
    response.set_cookie(
        names.csrf,
        csrf_token_for(token_hash),
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=False,
        samesite="lax",
    )


def clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    names = cookie_names(settings)
    for name in (names.session, names.csrf):
        response.delete_cookie(name, path="/", secure=settings.cookie_secure, samesite="lax")


def sign_value(value: str, purpose: str) -> str:
    """Short HMAC signature for values stored client-side (e.g. OAuth state cookie)."""
    key = get_settings().session_secret.get_secret_value().encode()
    return hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


def verify_signed(value: str, signature: str, purpose: str) -> bool:
    return hmac.compare_digest(sign_value(value, purpose), signature)
