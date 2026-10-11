"""Agents and their immutable versions (every configuration change creates a version)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin, utcnow


class Agent(Base, IdMixin, TimestampMixin):
    __tablename__ = "agents"
    __table_args__ = (
        Index(
            "uq_agents_workspace_name_live",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
        Index("ix_agents_workspace_updated", "workspace_id", "updated_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(500), default="", server_default="")
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "agent_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_agents_current_version",
        )
    )
    latest_version_number: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_execution_at: Mapped[datetime | None]
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]


class AgentVersion(Base, IdMixin):
    __tablename__ = "agent_versions"
    __table_args__ = (UniqueConstraint("agent_id", "number"),)

    agent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)
    instructions: Mapped[str] = mapped_column(Text, default="")
    provider_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("provider_configs.id", ondelete="SET NULL")
    )
    model: Mapped[str] = mapped_column(String(120))
    parameters: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    tool_ids: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    limits: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    change_note: Mapped[str | None] = mapped_column(String(280))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow)
