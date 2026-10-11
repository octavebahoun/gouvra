"""Model provider configurations (one per workspace credential)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Integer, LargeBinary, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from gouvra.core.db import Base, IdMixin, TimestampMixin


class ProviderConfig(Base, IdMixin, TimestampMixin):
    __tablename__ = "provider_configs"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(32))
    base_url: Mapped[str | None] = mapped_column(String(500))
    # AES-256-GCM ciphertext; the plaintext key never leaves the server after it is saved.
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_key_id: Mapped[str | None] = mapped_column(String(40))
    secret_last4: Mapped[str | None] = mapped_column(String(8))
    secret_updated_at: Mapped[datetime | None]
    default_model: Mapped[str | None] = mapped_column(String(120))
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(String(16), default="untested", server_default="untested")
    last_tested_at: Mapped[datetime | None]
    last_test_latency_ms: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    models: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    models_fetched_at: Mapped[datetime | None]
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None]
