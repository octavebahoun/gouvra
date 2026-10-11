"""Executions (the run queue lives in this table), their events and usage records."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class ExecutionStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


TERMINAL = frozenset(
    {
        ExecutionStatus.SUCCEEDED,
        ExecutionStatus.FAILED,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.TIMED_OUT,
    }
)


class Trigger(StrEnum):
    MANUAL = "manual"
    API = "api"
    RETRY = "retry"
    SCHEDULE = "schedule"
    WEBHOOK = "webhook"
    EVALUATION = "evaluation"
    WORKFLOW = "workflow"
    AGENT = "agent"


class Execution(Base, IdMixin, TimestampMixin):
    __tablename__ = "executions"
    __table_args__ = (
        Index("ix_executions_workspace_created", "workspace_id", "created_at"),
        Index("ix_executions_agent_created", "agent_id", "created_at"),
        Index(
            "ix_executions_queue",
            "priority",
            "created_at",
            postgresql_where=text("status = 'queued'"),
        ),
        Index("ix_executions_running", "workspace_id", postgresql_where=text("status = 'running'")),
        Index(
            "uq_executions_idempotency",
            "workspace_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    agent_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_versions.id", ondelete="SET NULL")
    )
    parent_execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("executions.id", ondelete="SET NULL"), index=True
    )
    workflow_run_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    trigger: Mapped[str] = mapped_column(String(16))
    triggered_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    source_id: Mapped[str | None] = mapped_column(String(64))  # schedule / webhook / evaluation id
    status: Mapped[str] = mapped_column(String(16), default=ExecutionStatus.QUEUED)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Evaluation variants: model, provider, instructions or parameters applied over the version.
    config_overrides: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    priority: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    available_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    timeout_s: Mapped[int] = mapped_column(Integer)
    cancel_requested_at: Mapped[datetime | None]
    cancel_requested_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    worker_id: Mapped[str | None] = mapped_column(String(128))
    lease_expires_at: Mapped[datetime | None]
    attempt: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    # Snapshot of what ran (the agent version may change later).
    provider_kind: Mapped[str | None] = mapped_column(String(32))
    model: Mapped[str | None] = mapped_column(String(120))
    # Aggregated usage.
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cached_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    reasoning_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
    cost_currency: Mapped[str | None] = mapped_column(String(3))
    cost_source: Mapped[str] = mapped_column(
        String(20), default="unavailable", server_default="unavailable"
    )
    cost_partial: Mapped[bool] = mapped_column(default=False, server_default="false")
    model_calls: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    tool_calls: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    steps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_event_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class ExecutionEvent(Base):
    __tablename__ = "execution_events"
    __table_args__ = (UniqueConstraint("execution_id", "seq"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    execution_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("executions.id", ondelete="CASCADE"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(40))
    level: Mapped[str] = mapped_column(String(10), default="info")
    step: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)


class UsageRecord(Base, IdMixin):
    __tablename__ = "usage_records"
    __table_args__ = (Index("ix_usage_records_workspace_recorded", "workspace_id", "recorded_at"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("executions.id", ondelete="SET NULL"), index=True
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), index=True
    )
    provider_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("provider_configs.id", ondelete="SET NULL")
    )
    provider_kind: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(20), default="model_call")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
    cost_currency: Mapped[str | None] = mapped_column(String(3))
    cost_source: Mapped[str] = mapped_column(String(20))
    price_period: Mapped[str | None] = mapped_column(String(12))
    recorded_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
