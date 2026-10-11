"""Workspace limits applied at launch time (plans and budgets extend this module)."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession


async def enforce_launch(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    """No plan limits are configured on a self-hosted instance by default."""
