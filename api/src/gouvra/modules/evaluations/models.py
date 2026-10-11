"""Evaluation suites, cases, runs and per-case results."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class EvalSuite(Base, IdMixin, TimestampMixin):
    __tablename__ = "eval_suites"
    __table_args__ = (
        Index(
            "uq_eval_suites_workspace_name_live",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    # Graders applied to every case unless the case defines its own.
    default_graders: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    pass_threshold: Mapped[float] = mapped_column(Float, default=1.0, server_default="1.0")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]


class EvalCase(Base, IdMixin, TimestampMixin):
    __tablename__ = "eval_cases"
    __table_args__ = (Index("ix_eval_cases_suite_position", "suite_id", "position"),)

    suite_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("eval_suites.id", ondelete="CASCADE"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    input: Mapped[dict[str, Any]] = mapped_column(JSONB)
    expected: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    graders: Mapped[list[Any] | None] = mapped_column(JSONB)
    tags: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class EvalRun(Base, IdMixin, TimestampMixin):
    __tablename__ = "eval_runs"
    __table_args__ = (Index("ix_eval_runs_workspace_created", "workspace_id", "created_at"),)

    suite_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("eval_suites.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(16), default="running")
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    agent_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_versions.id", ondelete="SET NULL")
    )
    agent_version_number: Mapped[int | None] = mapped_column(Integer)
    overrides: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    model: Mapped[str | None] = mapped_column(String(120))
    pass_threshold: Mapped[float] = mapped_column(Float, default=1.0)
    summary: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]


class EvalResult(Base, IdMixin, TimestampMixin):
    __tablename__ = "eval_results"
    __table_args__ = (UniqueConstraint("run_id", "case_id"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("eval_runs.id", ondelete="CASCADE"), index=True
    )
    case_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("eval_cases.id", ondelete="SET NULL")
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("executions.id", ondelete="SET NULL"), index=True
    )
    case_name: Mapped[str] = mapped_column(String(200))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # pending -> grading -> passed | failed | errored | cancelled
    status: Mapped[str] = mapped_column(String(16), default="pending")
    score: Mapped[float | None] = mapped_column(Float)
    grader_results: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    output_text: Mapped[str | None] = mapped_column(Text)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
    cost_source: Mapped[str] = mapped_column(
        String(20), default="unavailable", server_default="unavailable"
    )
    judge_cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 8))
