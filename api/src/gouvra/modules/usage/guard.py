"""Launch guard: plan quotas and hard budgets are enforced here before an execution is queued.

Phase 9 (SaaS) plugs plan limits and budget checks into this single entry point.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession


async def check_launch_allowed(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    """Raise QuotaExceeded when the workspace may not start another execution."""
    from gouvra.modules.usage import limits

    await limits.enforce_launch(db, workspace_id)
