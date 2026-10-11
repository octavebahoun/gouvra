"""Tool definitions: built-in, HTTP endpoint, or sandboxed code."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, LargeBinary, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class Tool(Base, IdMixin, TimestampMixin):
    __tablename__ = "tools"
    __table_args__ = (
        Index(
            "uq_tools_workspace_name_live",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    # Identifier the model sees (snake_case). Display name is for people.
    name: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(1024))
    kind: Mapped[str] = mapped_column(String(16))  # builtin | http | code
    builtin_key: Mapped[str | None] = mapped_column(String(40))
    input_schema: Mapped[dict[str, Any]] = mapped_column(JSONB)
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_key_id: Mapped[str | None] = mapped_column(String(40))
    secret_last4: Mapped[str | None] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active")
    timeout_ms: Mapped[int] = mapped_column(Integer, default=15_000, server_default="15000")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]
