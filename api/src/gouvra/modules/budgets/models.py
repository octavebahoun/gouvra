"""Monthly budgets per workspace, and the alerts raised (once each) for owners and admins."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ForeignKey, Index, Numeric, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class Budget(Base, IdMixin, TimestampMixin):
    __tablename__ = "budgets"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True
    )
    monthly_limit: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="USD", server_default="USD")
    thresholds: Mapped[list[int]] = mapped_column(
        JSONB, default=lambda: [50, 80, 100], server_default=text("'[50, 80, 100]'::jsonb")
    )
    # Refuse new runs once the budget is spent (otherwise: alerts only).
    hard_stop: Mapped[bool] = mapped_column(default=False, server_default="false")
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class Alert(Base, IdMixin):
    __tablename__ = "alerts"
    __table_args__ = (
        UniqueConstraint("workspace_id", "key"),
        Index("ix_alerts_workspace_created", "workspace_id", "created_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))  # budget | quota | payment_failed
    key: Mapped[str] = mapped_column(String(120))  # one alert per key (e.g. budget:2026-10:80)
    level: Mapped[str] = mapped_column(String(16))  # info | warning | danger
    data: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
    dismissed_at: Mapped[datetime | None]
