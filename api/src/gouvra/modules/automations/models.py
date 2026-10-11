"""Automations: schedules (cron) and signed inbound webhooks that start agents or workflows."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class AutomationKind(StrEnum):
    SCHEDULE = "schedule"
    WEBHOOK = "webhook"


class FireStatus(StrEnum):
    PENDING = "pending"
    LAUNCHED = "launched"
    SKIPPED = "skipped"
    REJECTED = "rejected"
    FAILED = "failed"


class Automation(Base, IdMixin, TimestampMixin):
    __tablename__ = "automations"
    __table_args__ = (
        Index("ix_automations_workspace_created", "workspace_id", "created_at"),
        Index(
            "ix_automations_due",
            "next_run_at",
            postgresql_where=text("kind = 'schedule' AND enabled"),
        ),
        Index(
            "uq_automations_hook_token",
            "hook_token",
            unique=True,
            postgresql_where=text("hook_token IS NOT NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(500), default="", server_default="")
    kind: Mapped[str] = mapped_column(String(16))
    target_type: Mapped[str] = mapped_column(String(16))  # agent | workflow
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), index=True
    )
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflows.id", ondelete="SET NULL"), index=True
    )
    # Schedules: the input of every run. Webhooks: the payload, optionally through a template.
    input: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    input_template: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(default=True, server_default="true")
    paused_reason: Mapped[str | None] = mapped_column(String(200))
    # Schedule
    cron: Mapped[str | None] = mapped_column(String(120))
    timezone: Mapped[str | None] = mapped_column(String(64))
    next_run_at: Mapped[datetime | None]
    overlap: Mapped[str] = mapped_column(String(8), default="skip", server_default="skip")
    # Webhook: the URL token is public; the signing secret is encrypted at rest.
    hook_token: Mapped[str | None] = mapped_column(String(64))
    signature_format: Mapped[str] = mapped_column(
        String(16), default="gouvra", server_default="gouvra"
    )
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_key_id: Mapped[str | None] = mapped_column(String(40))
    secret_hint: Mapped[str | None] = mapped_column(String(8))
    # Outcome
    last_fired_at: Mapped[datetime | None]
    last_status: Mapped[str | None] = mapped_column(String(16))
    fire_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class AutomationFire(Base, IdMixin):
    """One trigger: a scheduled tick, a webhook delivery, a manual run or a test."""

    __tablename__ = "automation_fires"
    __table_args__ = (
        UniqueConstraint("automation_id", "delivery_id"),
        Index("ix_automation_fires_automation_created", "automation_id", "created_at"),
        Index(
            "ix_automation_fires_pending", "created_at", postgresql_where=text("status = 'pending'")
        ),
    )

    automation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("automations.id", ondelete="CASCADE")
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    source: Mapped[str] = mapped_column(String(16))  # schedule | webhook | manual | test
    scheduled_for: Mapped[datetime | None]
    delivery_id: Mapped[str | None] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(16), default=FireStatus.PENDING)
    reason: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("executions.id", ondelete="SET NULL")
    )
    workflow_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_runs.id", ondelete="SET NULL")
    )
    request_meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    payload_preview: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
