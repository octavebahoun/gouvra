"""Launch guard: the one check every launch path makes before queueing work.

Executions (API, automations), workflow runs and each of their steps, and evaluation runs all
call it; the rules themselves (suspension, plan quota, budget hard stop) live in `limits`.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession


async def check_launch_allowed(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    """Raise (403 suspended, 402 quota or budget) when the workspace may not start more work."""
    from gouvra.modules.usage import limits

    await limits.enforce_launch(db, workspace_id)
