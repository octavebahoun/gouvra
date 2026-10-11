"""OAuth 2.0 sign-in (GitHub, Google): authorization code + PKCE (S256) + signed state cookie."""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.logging import get_logger
from gouvra.core.security import sign_value, verify_signed
from gouvra.modules.audit.service import record
from gouvra.modules.identity.models import OAuthAccount, User, UserStatus
from gouvra.modules.identity.service import revoke_all_sessions

log = get_logger(__name__)

STATE_COOKIE = "gv_oauth"
STATE_COOKIE_PATH = "/api/v1/auth/oauth"
STATE_TTL_S = 600


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    authorize_url: str
    token_url: str
    scope: str


PROVIDERS = {
    "github": ProviderSpec(
        "github",
        "https://github.com/login/oauth/authorize",
        "https://github.com/login/oauth/access_token",
        "read:user user:email",
    ),
    "google": ProviderSpec(
        "google",
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "openid email profile",
    ),
}


class OAuthError(Exception):
    """Ends the flow with a redirect to the sign-in page and a machine-readable reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ProviderIdentity:
    provider: str
    account_id: str
    email: str
    email_verified: bool
    name: str | None
    login: str | None


def enabled(provider: str) -> bool:
    return provider in get_settings().oauth_providers


def credentials(provider: str) -> tuple[str, str]:
    s = get_settings()
    if provider == "github":
        return s.github_client_id, s.github_client_secret.get_secret_value()
    return s.google_client_id, s.google_client_secret.get_secret_value()


def redirect_uri(provider: str) -> str:
    return f"{get_settings().api_public_url}/api/v1/auth/oauth/{provider}/callback"


def safe_next(value: str | None) -> str:
    """Only same-site relative paths: prevents open redirects."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/app"
    return value[:512]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def start(provider: str, next_path: str | None) -> tuple[str, str]:
    """Return (authorization URL, signed state cookie value)."""
    spec = PROVIDERS[provider]
    client_id, _ = credentials(provider)
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64(hashlib.sha256(verifier.encode()).digest())
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(provider),
        "scope": spec.scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "response_type": "code",
    }
    if provider == "google":
        params["prompt"] = "select_account"
    else:
        params["allow_signup"] = "true"
    payload = ".".join([provider, state, verifier, _b64(safe_next(next_path).encode())])
    cookie = f"{payload}.{sign_value(payload, 'oauth-state')}"
    return f"{spec.authorize_url}?{urlencode(params)}", cookie


def require_code(code: str | None, error: str | None) -> str:
    if error or not code:
        raise OAuthError("denied")
    return code


def read_state_cookie(cookie: str | None, provider: str, state: str | None) -> tuple[str, str]:
    """Verify the state cookie; return (code_verifier, next_path)."""
    if not cookie or not state:
        raise OAuthError("state")
    payload, _, signature = cookie.rpartition(".")
    if not payload or not verify_signed(payload, signature, "oauth-state"):
        raise OAuthError("state")
    parts = payload.split(".")
    if len(parts) != 4 or parts[0] != provider or not secrets.compare_digest(parts[1], state):
        raise OAuthError("state")
    next_path = base64.urlsafe_b64decode(parts[3] + "=" * (-len(parts[3]) % 4)).decode()
    return parts[2], safe_next(next_path)


async def exchange_and_identify(
    provider: str, code: str, verifier: str, client: httpx.AsyncClient | None = None
) -> ProviderIdentity:
    spec = PROVIDERS[provider]
    client_id, client_secret = credentials(provider)
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0))
    try:
        token_response = await http.post(
            spec.token_url,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri(provider),
                "code_verifier": verifier,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
        token_json: dict[str, Any] = token_response.json() if token_response.content else {}
        access_token = token_json.get("access_token")
        if token_response.status_code != 200 or not access_token:
            log.warning(
                "oauth_token_exchange_failed",
                provider=provider,
                status=token_response.status_code,
                error=token_json.get("error"),
            )
            raise OAuthError("exchange")
        auth = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
        if provider == "github":
            profile = (await http.get("https://api.github.com/user", headers=auth)).json()
            emails = (await http.get("https://api.github.com/user/emails", headers=auth)).json()
            verified = [e for e in emails if isinstance(e, dict) and e.get("verified")]
            primary = next(
                (e for e in verified if e.get("primary")), verified[0] if verified else None
            )
            if primary is None:
                raise OAuthError("email_unverified")
            return ProviderIdentity(
                provider="github",
                account_id=str(profile["id"]),
                email=str(primary["email"]),
                email_verified=True,
                name=profile.get("name"),
                login=profile.get("login"),
            )
        info = (
            await http.get("https://openidconnect.googleapis.com/v1/userinfo", headers=auth)
        ).json()
        if not info.get("email") or not info.get("email_verified"):
            raise OAuthError("email_unverified")
        return ProviderIdentity(
            provider="google",
            account_id=str(info["sub"]),
            email=str(info["email"]),
            email_verified=True,
            name=info.get("name"),
            login=None,
        )
    except httpx.HTTPError as exc:
        log.warning("oauth_provider_unreachable", provider=provider, error=type(exc).__name__)
        raise OAuthError("unreachable") from exc
    finally:
        if owns_client:
            await http.aclose()


async def sign_in_with(db: AsyncSession, identity: ProviderIdentity, locale: str) -> User:
    """Find the linked account, link by verified e-mail, or create the account."""
    linked = (
        await db.execute(
            select(OAuthAccount, User)
            .join(User, User.id == OAuthAccount.user_id)
            .where(
                OAuthAccount.provider == identity.provider,
                OAuthAccount.provider_account_id == identity.account_id,
            )
        )
    ).first()
    if linked is not None:
        account, user = linked[0], linked[1]
        account.email = identity.email
        account.login = identity.login
    else:
        existing = (
            await db.execute(select(User).where(User.email == identity.email))
        ).scalar_one_or_none()
        if existing is None:
            user = User(
                email=identity.email,
                display_name=(identity.name or identity.login or identity.email.split("@")[0])[:80],
                locale=locale,
                email_verified_at=utcnow(),
            )
            db.add(user)
            await db.flush()
            await record(
                db,
                "user.registered",
                actor_user_id=user.id,
                actor_label=user.email,
                target_type="user",
                target_id=user.id,
                data={"method": identity.provider},
            )
        else:
            user = existing
        if existing is not None and user.email_verified_at is None:
            # Someone may have pre-registered this address: drop their password and sessions.
            user.password_hash = None
            user.email_verified_at = utcnow()
            await revoke_all_sessions(db, user.id)
            await record(
                db,
                "user.oauth_takeover_protection",
                actor_user_id=user.id,
                actor_label=user.email,
                target_type="user",
                target_id=user.id,
                data={"provider": identity.provider},
            )
        db.add(
            OAuthAccount(
                user_id=user.id,
                provider=identity.provider,
                provider_account_id=identity.account_id,
                email=identity.email,
                login=identity.login,
            )
        )
        await record(
            db,
            "user.oauth_linked",
            actor_user_id=user.id,
            actor_label=user.email,
            target_type="user",
            target_id=user.id,
            data={"provider": identity.provider},
        )
    if user.status != UserStatus.ACTIVE:
        raise OAuthError("disabled")
    return user
