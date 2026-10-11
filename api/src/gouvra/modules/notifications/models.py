"""Transactional e-mail outbox: written in the same transaction as the change that triggers it."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class OutboxStatus(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"


class EmailOutbox(Base, IdMixin, TimestampMixin):
    __tablename__ = "email_outbox"
    __table_args__ = (
        Index(
            "ix_email_outbox_due",
            "next_attempt_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )

    to_email: Mapped[str] = mapped_column(String(320))
    template: Mapped[str] = mapped_column(String(48))
    locale: Mapped[str] = mapped_column(String(8))
    subject: Mapped[str] = mapped_column(String(200))
    # Rendered bodies may contain one-time links: purged once sent (see dispatcher).
    html_body: Mapped[str | None] = mapped_column(Text)
    text_body: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(12), default=OutboxStatus.PENDING)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime]
    sent_at: Mapped[datetime | None]
    provider_message_id: Mapped[str | None] = mapped_column(String(128))
    last_error: Mapped[str | None] = mapped_column(String(500))
    meta: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
