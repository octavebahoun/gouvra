"""Request authentication: session cookie (+ CSRF, rotation, sliding expiry) or service key."""

from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import Request, Response
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Actor
from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import AppError, Unauthorized
from gouvra.core.ids import hash_token, new_token
from gouvra.core.security import cookie_names, csrf_matches, set_session_cookies
from gouvra.modules.identity.models import User, UserSession, UserStatus

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
ROTATION_GRACE = timedelta(seconds=60)
TOUCH_EVERY = timedelta(minutes=5)


class CsrfFailed(AppError):
    status_code = 403
    code = "csrf_failed"
    title = "Security check failed — reload the page and retry"


def _origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def allowed_origins() -> set[str]:
    settings = get_settings()
    origins = {_origin_of(settings.app_url), _origin_of(settings.api_public_url)}
    origins.update(_origin_of(o) for o in settings.cors_origins)
    return origins


def check_origin(request: Request) -> None:
    """Unsafe browser requests must come from our own origin (blocks cross-site and login CSRF).

    Browsers always send `Origin` on cross-origin POSTs; requests without it (server-side
    clients, curl) carry no ambient browser credentials worth protecting here.
    """
    if request.method not in UNSAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is not None and origin.lower() not in allowed_origins():
        raise CsrfFailed(details={"reason": "origin"})


async def _load_session(db: AsyncSession, token: str) -> tuple[UserSession, User, bool] | None:
    digest = hash_token(token)
    now = utcnow()
    row = (
        await db.execute(
            select(UserSession, User)
            .join(User, User.id == UserSession.user_id)
            .where(
                or_(
                    UserSession.token_hash == digest,
                    (UserSession.previous_token_hash == digest)
                    & (UserSession.previous_valid_until > now),
                ),
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > now,
                UserSession.absolute_expires_at > now,
            )
        )
    ).first()
    if row is None:
        return None
    session, user = row[0], row[1]
    if user.status != UserStatus.ACTIVE:
        return None
    return session, user, session.token_hash != digest


async def authenticate_request(
    request: Request, db: AsyncSession, response: Response | None = None
) -> Actor | None:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        from gouvra.modules.api_keys.service import authenticate_service_key

        actor = await authenticate_service_key(db, authorization[7:].strip())
        if actor is None:
            raise Unauthorized("Invalid or revoked service key", code="invalid_api_key")
        return actor

    token = request.cookies.get(cookie_names().session)
    if not token:
        return None
    loaded = await _load_session(db, token)
    if loaded is None:
        return None
    session, user, used_previous = loaded

    if request.method in UNSAFE_METHODS:
        check_origin(request)
        provided = request.headers.get("x-csrf-token")
        valid = csrf_matches(session.token_hash, provided) or (
            session.previous_token_hash is not None
            and csrf_matches(session.previous_token_hash, provided)
        )
        if not valid:
            raise CsrfFailed(details={"reason": "token"})

    settings = get_settings()
    now = utcnow()
    changes: dict[str, object] = {}
    if now - session.last_seen_at > TOUCH_EVERY:
        changes["last_seen_at"] = now
        changes["expires_at"] = min(
            now + timedelta(hours=settings.session_idle_hours), session.absolute_expires_at
        )
    rotate = (
        not used_previous
        and response is not None
        and now - session.rotated_at > timedelta(hours=settings.session_rotation_hours)
    )
    if rotate and response is not None:
        fresh = new_token()
        changes.update(
            previous_token_hash=session.token_hash,
            previous_valid_until=now + ROTATION_GRACE,
            token_hash=hash_token(fresh),
            rotated_at=now,
        )
        max_age = int((session.absolute_expires_at - now).total_seconds())
        set_session_cookies(response, fresh, hash_token(fresh), max_age)
    if changes:
        await db.execute(update(UserSession).where(UserSession.id == session.id).values(**changes))
        await db.commit()
        for key, value in changes.items():
            setattr(session, key, value)
    request.state.session_id = session.id
    return Actor(user=user, session=session)
