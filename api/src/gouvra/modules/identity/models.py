"""Identity: users, sessions, e-mail tokens, OAuth identities."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class UserStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class User(Base, IdMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(CITEXT, unique=True)
    email_verified_at: Mapped[datetime | None]
    # Nullable: accounts created through OAuth have no password until they set one.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(80))
    locale: Mapped[str] = mapped_column(String(8), default="en", server_default="en")
    theme: Mapped[str] = mapped_column(String(8), default="system", server_default="system")
    status: Mapped[str] = mapped_column(
        String(16), default=UserStatus.ACTIVE, server_default="active"
    )
    is_superadmin: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    last_login_at: Mapped[datetime | None]
    password_changed_at: Mapped[datetime | None]

    @property
    def email_verified(self) -> bool:
        return self.email_verified_at is not None


class UserSession(Base, IdMixin):
    """Server-side session. The cookie carries a random token; only its SHA-256 is stored."""

    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # Previous token stays valid for a few seconds after a rotation (requests already in flight).
    previous_token_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    previous_valid_until: Mapped[datetime | None]
    created_at: Mapped[datetime]
    last_seen_at: Mapped[datetime]
    rotated_at: Mapped[datetime]
    expires_at: Mapped[datetime]
    absolute_expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    auth_method: Mapped[str] = mapped_column(
        String(16), default="password", server_default="password"
    )


class EmailTokenPurpose(StrEnum):
    VERIFY_EMAIL = "verify_email"
    RESET_PASSWORD = "reset_password"  # noqa: S105 - token purpose, not a secret
    CHANGE_EMAIL = "change_email"


class EmailToken(Base, IdMixin):
    __tablename__ = "email_tokens"
    __table_args__ = (Index("ix_email_tokens_user_purpose", "user_id", "purpose"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    purpose: Mapped[str] = mapped_column(String(24))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # Address the token was issued for: a token is void if the user's address changed since.
    email: Mapped[str] = mapped_column(CITEXT)
    created_at: Mapped[datetime]
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]


class OAuthAccount(Base, IdMixin, TimestampMixin):
    __tablename__ = "oauth_accounts"
    __table_args__ = (UniqueConstraint("provider", "provider_account_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(16))
    provider_account_id: Mapped[str] = mapped_column(String(128))
    email: Mapped[str] = mapped_column(CITEXT)
    login: Mapped[str | None] = mapped_column(String(128))
