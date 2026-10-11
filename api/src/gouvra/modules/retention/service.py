"""Retention: old runs, deliveries, alerts and audit entries are deleted on a schedule.

Each workspace keeps its runs (executions with their traces, workflow runs, automation
deliveries) for `retention_days` (bounded by its plan) and its audit log for
`audit_retention_days`. Usage records are kept: they hold no content, only counts and costs,
and the usage history stays complete. Evaluations keep their results (the executions they
point to may go).
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.logging import get_logger
from gouvra.modules.billing.plans import Plan
from gouvra.modules.workspaces.models import Workspace

log = get_logger(__name__)

DEFAULT_DAYS = 365
DEFAULT_AUDIT_DAYS = 365
BATCH = 500


def retention_of(workspace: Workspace, plan: Plan) -> tuple[int, int]:
    """(days runs are kept, days audit entries are kept) for this workspace."""
    settings = workspace.settings or {}
    keep = int(settings.get("retention_days") or min(DEFAULT_DAYS, plan.retention_days_max))
    audit = int(settings.get("audit_retention_days") or DEFAULT_AUDIT_DAYS)
    return min(keep, plan.retention_days_max), audit


async def _purge(
    db: AsyncSession, model: Any, workspace_id: uuid.UUID, column: Any, before: Any
) -> int:
    """Delete in small batches (short transactions, no long locks)."""
    removed = 0
    while True:
        ids = list(
            (
                await db.execute(
                    select(model.id)
                    .where(model.workspace_id == workspace_id, column < before)
                    .limit(BATCH)
                )
            ).scalars()
        )
        if not ids:
            return removed
        await db.execute(delete(model).where(model.id.in_(ids)))
        await db.commit()
        removed += len(ids)


async def purge_workspace(db: AsyncSession, workspace: Workspace, plan: Plan) -> dict[str, int]:
    from gouvra.modules.audit.models import AuditEvent
    from gouvra.modules.automations.models import AutomationFire
    from gouvra.modules.budgets.models import Alert
    from gouvra.modules.executions.models import Execution
    from gouvra.modules.workflows.models import WorkflowRun

    keep, audit = retention_of(workspace, plan)
    cutoff = utcnow() - timedelta(days=keep)
    counts = {
        "executions": await _purge(db, Execution, workspace.id, Execution.created_at, cutoff),
        "workflow_runs": await _purge(
            db, WorkflowRun, workspace.id, WorkflowRun.created_at, cutoff
        ),
        "deliveries": await _purge(
            db, AutomationFire, workspace.id, AutomationFire.created_at, cutoff
        ),
        "alerts": await _purge(db, Alert, workspace.id, Alert.created_at, cutoff),
        "audit_events": await _purge(
            db, AuditEvent, workspace.id, AuditEvent.created_at, utcnow() - timedelta(days=audit)
        ),
    }
    return {key: value for key, value in counts.items() if value}


async def purge_all() -> int:
    from gouvra.modules.audit.service import record
    from gouvra.modules.billing.service import plan_of

    total = 0
    async with get_sessionmaker()() as db:
        workspaces = list((await db.execute(select(Workspace))).scalars())
        for workspace in workspaces:
            counts = await purge_workspace(db, workspace, await plan_of(db, workspace.id))
            if counts:
                await record(
                    db,
                    "retention.purged",
                    actor_label="retention",
                    workspace_id=workspace.id,
                    target_type="workspace",
                    target_id=workspace.id,
                    data=counts,
                )
                await db.commit()
                total += sum(counts.values())
                log.info("retention_purged", workspace_id=str(workspace.id), **counts)
    return total
