"""Subscriptions (one per workspace) and the billing events already processed."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class Subscription(Base, IdMixin, TimestampMixin):
    __tablename__ = "subscriptions"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True
    )
    plan: Mapped[str] = mapped_column(String(16), default="free", server_default="free")
    # active | trialing | past_due | canceled | incomplete | unpaid
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")
    provider: Mapped[str] = mapped_column(String(16))  # stripe | simulated
    customer_id: Mapped[str | None] = mapped_column(String(64), index=True)
    subscription_id: Mapped[str | None] = mapped_column(String(64), index=True)
    current_period_end: Mapped[datetime | None]
    cancel_at_period_end: Mapped[bool] = mapped_column(default=False, server_default="false")
    # Instance administrators may grant a plan without payment (e.g. partners, tests).
    granted_by_admin: Mapped[bool] = mapped_column(default=False, server_default="false")


class BillingEvent(Base):
    """Provider events already handled: a re-sent event changes nothing."""

    __tablename__ = "billing_events"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    type: Mapped[str] = mapped_column(String(80))
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="SET NULL")
    )
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    received_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
