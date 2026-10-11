"""Workspace limits: plan quotas, hard budgets and suspension, checked before work starts."""

from __future__ import annotations

import uuid
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.errors import Forbidden, QuotaExceeded

Capacity = Literal["members", "agents", "automations"]

LABELS: dict[Capacity, str] = {
    "members": "members",
    "agents": "agents",
    "automations": "automations",
}


async def _suspended(db: AsyncSession, workspace_id: uuid.UUID) -> bool:
    from gouvra.modules.workspaces.models import Workspace

    workspace = await db.get(Workspace, workspace_id)
    return workspace is not None and workspace.status == "suspended"


async def enforce_launch(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    """Raise when the workspace may not start another run (plan quota, spent budget, suspended)."""
    from gouvra.modules.billing.service import executions_this_period, plan_of
    from gouvra.modules.budgets.service import budget_of, spend_this_period

    if await _suspended(db, workspace_id):
        raise Forbidden(
            "This workspace is suspended. Contact the administrator of this instance.",
            code="workspace_suspended",
        )
    plan = await plan_of(db, workspace_id)
    if plan.executions_per_month is not None:
        used = await executions_this_period(db, workspace_id)
        if used >= plan.executions_per_month:
            raise QuotaExceeded(
                f"This workspace used the {plan.executions_per_month:,} runs included in the "
                f"{plan.name} plan this month. Upgrade the plan to keep going.",
                code="plan_limit",
                details={
                    "limit": "executions_per_month",
                    "cap": plan.executions_per_month,
                    "plan": plan.key,
                },
            )
    budget = await budget_of(db, workspace_id)
    if budget is not None and budget.hard_stop:
        spent = await spend_this_period(db, workspace_id)
        if spent >= budget.monthly_limit:
            raise QuotaExceeded(
                "The monthly budget of this workspace is spent: new runs are paused until next "
                "month, or until an admin raises the budget.",
                code="budget_reached",
                details={"spent": str(spent), "limit": str(budget.monthly_limit)},
            )


async def usage_count(db: AsyncSession, workspace_id: uuid.UUID, kind: Capacity) -> int:
    if kind == "members":
        from gouvra.modules.workspaces.models import Invitation, Membership

        members = (
            await db.execute(
                select(func.count())
                .select_from(Membership)
                .where(Membership.workspace_id == workspace_id)
            )
        ).scalar_one()
        pending = (
            await db.execute(
                select(func.count())
                .select_from(Invitation)
                .where(Invitation.workspace_id == workspace_id, Invitation.status == "pending")
            )
        ).scalar_one()
        return int(members) + int(pending)
    if kind == "agents":
        from gouvra.modules.agents.models import Agent

        return int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Agent)
                    .where(Agent.workspace_id == workspace_id, Agent.archived_at.is_(None))
                )
            ).scalar_one()
        )
    from gouvra.modules.automations.models import Automation

    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Automation)
                .where(Automation.workspace_id == workspace_id)
            )
        ).scalar_one()
    )


async def require_capacity(db: AsyncSession, workspace_id: uuid.UUID, kind: Capacity) -> None:
    """Raise when the plan does not allow one more member, agent or automation."""
    from gouvra.modules.billing.service import plan_of

    plan = await plan_of(db, workspace_id)
    cap: int | None = getattr(plan, kind)
    if cap is None:
        return
    if await usage_count(db, workspace_id, kind) >= cap:
        raise QuotaExceeded(
            f"The {plan.name} plan includes up to {cap} {LABELS[kind]}. Upgrade to add more.",
            code="plan_limit",
            details={"limit": kind, "cap": cap, "plan": plan.key},
        )
