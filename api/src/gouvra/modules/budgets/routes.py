"""Budget and alert routes."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.db import utcnow
from gouvra.modules.billing.service import period_bounds
from gouvra.modules.budgets import service
from gouvra.modules.budgets.models import Alert

router = APIRouter(tags=["budgets"])


class BudgetIn(BaseModel):
    monthly_limit: Decimal | None = Field(
        default=None, ge=0, max_digits=12, decimal_places=2, description="None removes the budget"
    )
    thresholds: list[int] = Field(default_factory=lambda: [50, 80, 100], max_length=10)
    hard_stop: bool = False


class BudgetSettings(BaseModel):
    monthly_limit: Decimal
    currency: str
    thresholds: list[int]
    hard_stop: bool


class BudgetOut(BaseModel):
    budget: BudgetSettings | None
    spent: Decimal
    period_start: datetime
    period_end: datetime


class AlertOut(BaseModel):
    id: uuid.UUID
    kind: str
    level: str
    data: dict[str, Any]
    created_at: datetime
    dismissed_at: datetime | None


async def budget_out(db: DbSession, workspace_id: uuid.UUID) -> BudgetOut:
    budget = await service.budget_of(db, workspace_id)
    start, end = period_bounds()
    return BudgetOut(
        budget=BudgetSettings(
            monthly_limit=budget.monthly_limit,
            currency=budget.currency,
            thresholds=budget.thresholds,
            hard_stop=budget.hard_stop,
        )
        if budget
        else None,
        spent=await service.spend_this_period(db, workspace_id),
        period_start=start,
        period_end=end,
    )


@router.get("/workspaces/{workspace_id}/budget", summary="Monthly budget and what was spent")
async def get_budget(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.USAGE_READ)],
) -> BudgetOut:
    return await budget_out(db, ctx.workspace_id)


@router.put("/workspaces/{workspace_id}/budget", summary="Set, change or remove the budget")
async def put_budget(
    payload: BudgetIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BUDGETS_MANAGE)],
) -> BudgetOut:
    await service.set_budget(
        db,
        ctx,
        monthly_limit=payload.monthly_limit,
        thresholds=payload.thresholds,
        hard_stop=payload.hard_stop,
    )
    return await budget_out(db, ctx.workspace_id)


@router.get("/workspaces/{workspace_id}/alerts", summary="Recent alerts (budget, quota, payment)")
async def list_alerts(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.USAGE_READ)],
) -> list[AlertOut]:
    rows = (
        await db.execute(
            select(Alert)
            .where(
                Alert.workspace_id == ctx.workspace_id,
                Alert.created_at >= utcnow() - timedelta(days=45),
            )
            .order_by(Alert.created_at.desc())
            .limit(50)
        )
    ).scalars()
    return [AlertOut.model_validate(row, from_attributes=True) for row in rows]


@router.post("/alerts/{alert_id}/dismiss", summary="Dismiss an alert")
async def dismiss_alert(alert_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> AlertOut:
    alert, ctx = await load_in_workspace(db, Alert, alert_id, actor, Permission.BUDGETS_MANAGE)
    return AlertOut.model_validate(await service.dismiss(db, ctx, alert), from_attributes=True)
