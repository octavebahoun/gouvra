"""Identity business rules: registration, verification, sign-in, sessions, passwords, profile.

Security notes (see DECISIONS D-060…D-067):
- registration, sign-in and recovery never reveal whether an address has an account;
- tokens are random 256-bit values stored as SHA-256 digests, single-use and short-lived;
- password changes revoke the other sessions and notify the account owner.
"""

from __future__ import annotations

import unicodedata
import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import AppError, Conflict, Gone, NotFound, ValidationFailed
from gouvra.core.ids import hash_token, new_token
from gouvra.core.security import hash_password, needs_rehash, password_problems, verify_password
from gouvra.modules.audit.service import record
from gouvra.modules.identity.models import (
    EmailToken,
    EmailTokenPurpose,
    OAuthAccount,
    User,
    UserSession,
    UserStatus,
)
from gouvra.modules.notifications.service import queue_email

VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(hours=1)
CHANGE_EMAIL_TTL = timedelta(hours=24)

PASSWORD_MESSAGES = {
    "too_short": "Use at least 10 characters.",
    "too_long": "Use at most 128 characters.",
    "blank": "The password cannot be blank.",
    "too_common": "This password is too common — choose a less predictable one.",
    "contains_email": "Don't reuse your e-mail address in your password.",
}


class InvalidCredentials(AppError):
    status_code = 401
    code = "invalid_credentials"
    title = "Invalid e-mail or password"


def normalize_email(email: str) -> str:
    return unicodedata.normalize("NFKC", email).strip()


def check_password_policy(password: str, email: str | None, field: str = "password") -> None:
    problems = password_problems(password, email)
    if problems:
        raise ValidationFailed(
            "The password does not meet the policy.",
            errors=[{"field": field, "code": p, "message": PASSWORD_MESSAGES[p]} for p in problems],
        )


def app_link(path: str, token: str | None = None) -> str:
    """Links sent by e-mail. Tokens go in the fragment: never sent to any server or logged."""
    base = get_settings().app_url + path
    return f"{base}#token={token}" if token else base


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    return (
        await db.execute(select(User).where(User.email == normalize_email(email)))
    ).scalar_one_or_none()


async def issue_email_token(
    db: AsyncSession,
    user: User,
    purpose: EmailTokenPurpose,
    ttl: timedelta,
    email: str | None = None,
) -> str:
    # A new token for the same purpose voids the previous ones.
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == purpose,
            EmailToken.used_at.is_(None),
        )
        .values(used_at=utcnow())
    )
    token = new_token()
    now = utcnow()
    db.add(
        EmailToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=hash_token(token),
            email=email or user.email,
            created_at=now,
            expires_at=now + ttl,
        )
    )
    return token


async def consume_email_token(
    db: AsyncSession, token: str, purpose: EmailTokenPurpose
) -> tuple[User, EmailToken]:
    """Validate and burn a token. Every failure looks the same (410)."""
    row = (
        await db.execute(
            select(EmailToken, User)
            .join(User, User.id == EmailToken.user_id)
            .where(EmailToken.token_hash == hash_token(token), EmailToken.purpose == purpose)
            .with_for_update(of=EmailToken)
        )
    ).first()
    now = utcnow()
    if row is None:
        raise Gone("This link is invalid or has expired.", code="token_invalid")
    email_token, user = row[0], row[1]
    stale_address = (
        purpose != EmailTokenPurpose.CHANGE_EMAIL
        and email_token.email.lower() != user.email.lower()
    )
    if email_token.used_at is not None or email_token.expires_at <= now or stale_address:
        raise Gone("This link is invalid or has expired.", code="token_invalid")
    if user.status != UserStatus.ACTIVE:
        raise Gone("This link is invalid or has expired.", code="token_invalid")
    email_token.used_at = now
    return user, email_token


# ---------------------------------------------------------------- registration & verification


async def register(
    db: AsyncSession, *, email: str, password: str, display_name: str, locale: str
) -> None:
    email = normalize_email(email)
    check_password_policy(password, email)
    existing = await get_user_by_email(db, email)
    if existing is not None:
        # Same cost as a real sign-up, so timing does not reveal the account either.
        hash_password(password)
        if existing.email_verified:
            await queue_email(
                db,
                to=existing.email,
                template="account_exists",
                locale=existing.locale,
                context={"email": existing.email},
                action_url=app_link("/login"),
            )
        else:
            token = await issue_email_token(
                db, existing, EmailTokenPurpose.VERIFY_EMAIL, VERIFY_TTL
            )
            await queue_email(
                db,
                to=existing.email,
                template="verify_email",
                locale=existing.locale,
                context={"name": existing.display_name, "email": existing.email},
                action_url=app_link("/verify-email", token),
            )
        await db.commit()
        return
    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
        locale=locale,
        password_changed_at=utcnow(),
    )
    db.add(user)
    await db.flush()
    token = await issue_email_token(db, user, EmailTokenPurpose.VERIFY_EMAIL, VERIFY_TTL)
    await queue_email(
        db,
        to=user.email,
        template="verify_email",
        locale=user.locale,
        context={"name": user.display_name, "email": user.email},
        action_url=app_link("/verify-email", token),
    )
    await record(
        db,
        "user.registered",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="user",
        target_id=user.id,
    )
    await db.commit()


async def verify_email(db: AsyncSession, token: str) -> User:
    user, _ = await consume_email_token(db, token, EmailTokenPurpose.VERIFY_EMAIL)
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        await record(
            db,
            "user.email_verified",
            actor_user_id=user.id,
            actor_label=user.email,
            target_type="user",
            target_id=user.id,
        )
    return user


async def resend_verification(db: AsyncSession, user: User) -> None:
    if user.email_verified:
        return
    token = await issue_email_token(db, user, EmailTokenPurpose.VERIFY_EMAIL, VERIFY_TTL)
    await queue_email(
        db,
        to=user.email,
        template="verify_email",
        locale=user.locale,
        context={"name": user.display_name, "email": user.email},
        action_url=app_link("/verify-email", token),
    )
    await db.commit()


# ---------------------------------------------------------------- sign-in & sessions


async def authenticate_password(db: AsyncSession, email: str, password: str) -> User:
    user = await get_user_by_email(db, email)
    valid = verify_password(user.password_hash if user else None, password)
    if user is None or not valid or user.status != UserStatus.ACTIVE:
        raise InvalidCredentials("Invalid e-mail or password.")
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    return user


async def create_session(
    db: AsyncSession,
    user: User,
    *,
    ip_address: str | None,
    user_agent: str | None,
    auth_method: str,
) -> tuple[str, UserSession]:
    settings = get_settings()
    now = utcnow()
    token = new_token()
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(token),
        created_at=now,
        last_seen_at=now,
        rotated_at=now,
        expires_at=now + timedelta(hours=settings.session_idle_hours),
        absolute_expires_at=now + timedelta(days=settings.session_absolute_days),
        ip_address=ip_address,
        user_agent=(user_agent or "")[:255] or None,
        auth_method=auth_method,
    )
    db.add(session)
    user.last_login_at = now
    await record(
        db,
        "user.signed_in",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="user",
        target_id=user.id,
        data={"method": auth_method},
    )
    await db.flush()
    return token, session


def session_max_age(session: UserSession) -> int:
    return max(0, int((session.absolute_expires_at - utcnow()).total_seconds()))


async def revoke_session(db: AsyncSession, user: User, session_id: uuid.UUID) -> None:
    result = await db.execute(
        update(UserSession)
        .where(
            UserSession.id == session_id,
            UserSession.user_id == user.id,
            UserSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise NotFound("Session not found")
    await record(
        db,
        "user.session_revoked",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="session",
        target_id=session_id,
    )


async def revoke_all_sessions(
    db: AsyncSession, user_id: uuid.UUID, *, except_id: uuid.UUID | None = None
) -> int:
    query = update(UserSession).where(
        UserSession.user_id == user_id, UserSession.revoked_at.is_(None)
    )
    if except_id is not None:
        query = query.where(UserSession.id != except_id)
    result = await db.execute(query.values(revoked_at=utcnow()))
    return int(result.rowcount)  # type: ignore[attr-defined]


async def list_sessions(db: AsyncSession, user: User) -> list[UserSession]:
    now = utcnow()
    return list(
        (
            await db.execute(
                select(UserSession)
                .where(
                    UserSession.user_id == user.id,
                    UserSession.revoked_at.is_(None),
                    UserSession.expires_at > now,
                    UserSession.absolute_expires_at > now,
                )
                .order_by(UserSession.last_seen_at.desc())
            )
        ).scalars()
    )


# ---------------------------------------------------------------- passwords


async def forgot_password(db: AsyncSession, email: str) -> None:
    user = await get_user_by_email(db, email)
    if user is None or user.status != UserStatus.ACTIVE:
        return
    token = await issue_email_token(db, user, EmailTokenPurpose.RESET_PASSWORD, RESET_TTL)
    await queue_email(
        db,
        to=user.email,
        template="reset_password",
        locale=user.locale,
        context={"name": user.display_name, "email": user.email},
        action_url=app_link("/reset-password", token),
    )
    await db.commit()


async def _set_password(
    db: AsyncSession, user: User, password: str, *, keep_session: uuid.UUID | None
) -> None:
    user.password_hash = hash_password(password)
    user.password_changed_at = utcnow()
    await revoke_all_sessions(db, user.id, except_id=keep_session)
    await queue_email(
        db,
        to=user.email,
        template="password_changed",
        locale=user.locale,
        context={
            "name": user.display_name,
            "email": user.email,
            "when": utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        },
    )


async def reset_password(db: AsyncSession, token: str, password: str) -> User:
    user, _ = await consume_email_token(db, token, EmailTokenPurpose.RESET_PASSWORD)
    check_password_policy(password, user.email)
    await _set_password(db, user, password, keep_session=None)
    # Following the e-mailed link proves ownership of the address.
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
    await record(
        db,
        "user.password_reset",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="user",
        target_id=user.id,
    )
    await db.commit()
    return user


async def change_password(
    db: AsyncSession, user: User, session: UserSession | None, current: str | None, new: str
) -> None:
    if user.password_hash is not None and not verify_password(user.password_hash, current or ""):
        raise ValidationFailed(
            errors=[
                {
                    "field": "current_password",
                    "code": "invalid",
                    "message": "The current password is incorrect.",
                }
            ]
        )
    check_password_policy(new, user.email, field="new_password")
    await _set_password(db, user, new, keep_session=session.id if session else None)
    await record(
        db,
        "user.password_changed",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="user",
        target_id=user.id,
    )
    await db.commit()


# ---------------------------------------------------------------- profile & e-mail change


async def update_profile(
    db: AsyncSession, user: User, *, display_name: str | None, locale: str | None, theme: str | None
) -> User:
    if display_name is not None:
        user.display_name = display_name
    if locale is not None:
        user.locale = locale
    if theme is not None:
        user.theme = theme
    await db.commit()
    return user


async def request_email_change(
    db: AsyncSession, user: User, new_email: str, password: str | None
) -> None:
    if user.password_hash is None:
        raise Conflict(
            "Set a password before changing your sign-in address.", code="password_required"
        )
    if not verify_password(user.password_hash, password or ""):
        raise ValidationFailed(
            errors=[
                {"field": "password", "code": "invalid", "message": "The password is incorrect."}
            ]
        )
    new_email = normalize_email(new_email)
    if new_email.lower() == user.email.lower():
        raise ValidationFailed(
            errors=[
                {
                    "field": "new_email",
                    "code": "unchanged",
                    "message": "This is already your address.",
                }
            ]
        )
    # Always e-mail the new address: whether it is taken is only revealed to its owner.
    token = await issue_email_token(
        db, user, EmailTokenPurpose.CHANGE_EMAIL, CHANGE_EMAIL_TTL, email=new_email
    )
    await queue_email(
        db,
        to=new_email,
        template="change_email",
        locale=user.locale,
        context={"name": user.display_name, "email": new_email},
        action_url=app_link("/confirm-email", token),
    )
    await db.commit()


async def confirm_email_change(db: AsyncSession, token: str) -> User:
    user, email_token = await consume_email_token(db, token, EmailTokenPurpose.CHANGE_EMAIL)
    taken = (
        await db.execute(
            select(func.count())
            .select_from(User)
            .where(User.email == email_token.email, User.id != user.id)
        )
    ).scalar_one()
    if taken:
        raise Conflict("This address is already used by another account.", code="email_taken")
    old_email = user.email
    user.email = email_token.email
    user.email_verified_at = utcnow()
    await revoke_all_sessions(db, user.id)
    await queue_email(
        db,
        to=old_email,
        template="email_changed_notice",
        locale=user.locale,
        context={"name": user.display_name, "email": user.email},
    )
    await record(
        db,
        "user.email_changed",
        actor_user_id=user.id,
        actor_label=user.email,
        target_type="user",
        target_id=user.id,
    )
    await db.commit()
    return user


async def oauth_providers_of(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    return list(
        (
            await db.execute(
                select(OAuthAccount.provider)
                .where(OAuthAccount.user_id == user_id)
                .order_by(OAuthAccount.provider)
            )
        ).scalars()
    )
