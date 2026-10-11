"""PostgreSQL-backed run queue: claim with SKIP LOCKED, per-workspace concurrency, leases.

Claiming takes a transaction-scoped advisory lock per workspace before counting running
executions, so two workers can never both start the N+1th run of a workspace (DECISIONS D-012).
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import and_, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.executions.models import Execution, ExecutionStatus

LEASE = timedelta(seconds=45)
QUEUE_CHANNEL = "gouvra_executions"
CANCEL_CHANNEL = "gouvra_execution_cancel"


def workspace_lock_key(workspace_id: uuid.UUID) -> int:
    return int.from_bytes(workspace_id.bytes[:8], "big", signed=True)


async def workspace_concurrency_limit(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    """Running executions allowed at once for a workspace (plans may lower or raise it)."""
    from gouvra.modules.billing.service import plan_of
    from gouvra.modules.workspaces.models import Workspace

    workspace = await db.get(Workspace, workspace_id)
    configured = (workspace.settings or {}).get("max_concurrent_executions") if workspace else None
    wanted = int(configured or get_settings().default_workspace_concurrency)
    return min(wanted, (await plan_of(db, workspace_id)).concurrency)


async def notify_queue(db: AsyncSession) -> None:
    await db.execute(text("SELECT pg_notify(:c, '')"), {"c": QUEUE_CHANNEL})


async def notify_cancel(db: AsyncSession, execution_id: uuid.UUID) -> None:
    await db.execute(
        text("SELECT pg_notify(:c, :p)"), {"c": CANCEL_CHANNEL, "p": str(execution_id)}
    )


async def claim_next(worker_id: str) -> uuid.UUID | None:
    async with get_sessionmaker()() as db, db.begin():
        candidates = (
            await db.execute(
                select(Execution.id, Execution.workspace_id)
                .where(
                    Execution.status == ExecutionStatus.QUEUED, Execution.available_at <= func.now()
                )
                .order_by(Execution.priority.desc(), Execution.created_at)
                .limit(10)
                .with_for_update(skip_locked=True)
            )
        ).all()
        for execution_id, workspace_id in candidates:
            await db.execute(select(func.pg_advisory_xact_lock(workspace_lock_key(workspace_id))))
            running = (
                await db.execute(
                    select(func.count())
                    .select_from(Execution)
                    .where(
                        Execution.workspace_id == workspace_id,
                        Execution.status == ExecutionStatus.RUNNING,
                    )
                )
            ).scalar_one()
            if running >= await workspace_concurrency_limit(db, workspace_id):
                continue
            now = utcnow()
            await db.execute(
                update(Execution)
                .where(Execution.id == execution_id)
                .values(
                    status=ExecutionStatus.RUNNING,
                    started_at=now,
                    worker_id=worker_id,
                    lease_expires_at=now + LEASE,
                    attempt=Execution.attempt + 1,
                )
            )
            return execution_id
    return None


async def renew_leases(execution_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Extend leases of runs still owned here; return those whose cancellation was requested."""
    if not execution_ids:
        return []
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Execution)
            .where(Execution.id.in_(execution_ids), Execution.status == ExecutionStatus.RUNNING)
            .values(lease_expires_at=utcnow() + LEASE)
        )
        cancelled = (
            await db.execute(
                select(Execution.id).where(
                    Execution.id.in_(execution_ids), Execution.cancel_requested_at.is_not(None)
                )
            )
        ).scalars()
        result = list(cancelled)
        await db.commit()
        return result


async def reap_expired() -> list[dict[str, Any]]:
    """Fail runs whose worker stopped renewing its lease (crash, kill -9, lost host)."""
    error = {
        "code": "worker_lost",
        "message": "The worker running this execution stopped responding. Retry the execution.",
        "retryable": True,
    }
    async with get_sessionmaker()() as db:
        rows = (
            await db.execute(
                update(Execution)
                .where(
                    and_(
                        Execution.status == ExecutionStatus.RUNNING,
                        Execution.lease_expires_at < utcnow(),
                    )
                )
                .values(status=ExecutionStatus.FAILED, error=error, finished_at=utcnow())
                .returning(Execution.id, Execution.workspace_id, Execution.last_event_seq)
            )
        ).all()
        await db.commit()
    return [{"id": r[0], "workspace_id": r[1], "last_seq": r[2]} for r in rows]
