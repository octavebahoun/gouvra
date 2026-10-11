"""Connections: a connector of the library, installed in a workspace with its credentials."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, LargeBinary, String, text
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class Connection(Base, IdMixin, TimestampMixin):
    __tablename__ = "connections"
    __table_args__ = (
        Index(
            "uq_connections_workspace_name_live",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    connector: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(80))
    # Every credential field, as one encrypted JSON document; never sent back to the browser.
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_key_id: Mapped[str | None] = mapped_column(String(40))
    secret_hint: Mapped[str | None] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(
        String(16), default="unverified", server_default="unverified"
    )
    status_message: Mapped[str | None] = mapped_column(String(300))
    last_checked_at: Mapped[datetime | None]
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]
