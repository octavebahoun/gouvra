"""Workflows: an editable draft, immutable published versions, runs and their steps."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class Workflow(Base, IdMixin, TimestampMixin):
    __tablename__ = "workflows"
    __table_args__ = (
        Index(
            "uq_workflows_workspace_name_live",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
        Index("ix_workflows_workspace_updated", "workspace_id", "updated_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(500), default="", server_default="")
    draft_graph: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # Optimistic concurrency for the editor: a save must name the revision it started from.
    draft_revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "workflow_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_workflows_current_version",
        )
    )
    latest_version_number: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_run_at: Mapped[datetime | None]
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]


class WorkflowVersion(Base, IdMixin):
    __tablename__ = "workflow_versions"
    __table_args__ = (UniqueConstraint("workflow_id", "number"),)

    workflow_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflows.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB)
    note: Mapped[str | None] = mapped_column(String(280))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)


class RunStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


RUN_TERMINAL = frozenset(
    {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.TIMED_OUT}
)


class StepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


STEP_TERMINAL = frozenset(
    {StepStatus.SUCCEEDED, StepStatus.FAILED, StepStatus.SKIPPED, StepStatus.CANCELLED}
)


class WorkflowRun(Base, IdMixin, TimestampMixin):
    __tablename__ = "workflow_runs"
    __table_args__ = (
        Index("ix_workflow_runs_workspace_created", "workspace_id", "created_at"),
        Index("ix_workflow_runs_workflow_created", "workflow_id", "created_at"),
        Index("ix_workflow_runs_due", "wake_at", postgresql_where=text("status = 'running'")),
        Index(
            "uq_workflow_runs_idempotency",
            "workspace_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflows.id", ondelete="SET NULL")
    )
    workflow_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_versions.id", ondelete="SET NULL")
    )
    version_number: Mapped[int | None] = mapped_column(Integer)  # None: a draft test run
    workflow_name: Mapped[str] = mapped_column(String(80))
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB)  # what ran, frozen
    trigger: Mapped[str] = mapped_column(String(16))
    triggered_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    source_id: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default=RunStatus.RUNNING)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    timeout_s: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime | None]
    deadline_at: Mapped[datetime]
    finished_at: Mapped[datetime | None]
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    cancel_requested_at: Mapped[datetime | None]
    cancel_requested_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Scheduling of the orchestrator: woken by step changes, re-checked at `wake_at` anyway.
    needs_advance: Mapped[bool] = mapped_column(default=True, server_default="true")
    wake_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    # Totals over the steps.
    steps_total: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    steps_done: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
    cost_currency: Mapped[str | None] = mapped_column(String(3))
    cost_source: Mapped[str] = mapped_column(
        String(20), default="unavailable", server_default="unavailable"
    )
    cost_partial: Mapped[bool] = mapped_column(default=False, server_default="false")


class WorkflowStep(Base, IdMixin, TimestampMixin):
    __tablename__ = "workflow_steps"
    __table_args__ = (UniqueConstraint("run_id", "node_id"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_runs.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    node_id: Mapped[str] = mapped_column(String(40))
    node_type: Mapped[str] = mapped_column(String(16))
    label: Mapped[str] = mapped_column(String(80))
    position: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default=StepStatus.PENDING)
    input: Mapped[Any | None] = mapped_column(JSONB)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    branch: Mapped[str | None] = mapped_column(String(8))
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("executions.id", ondelete="SET NULL"), index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    deadline_at: Mapped[datetime | None]
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
    cost_source: Mapped[str] = mapped_column(
        String(20), default="unavailable", server_default="unavailable"
    )
