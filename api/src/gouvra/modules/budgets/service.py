"""Budgets and alerts: spend per month, thresholds, plan quotas, and who is told (once)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.errors import ValidationFailed
from gouvra.core.logging import get_logger
from gouvra.modules.audit.service import record_for
from gouvra.modules.budgets.models import Alert, Budget
from gouvra.modules.executions.models import Execution, UsageRecord
from gouvra.modules.identity.models import User
from gouvra.modules.notifications.service import queue_email
from gouvra.modules.workspaces.models import Membership, Role, Workspace

log = get_logger(__name__)

QUOTA_THRESHOLDS = (80, 100)
RECENT = timedelta(minutes=3)

# What an alert says, per kind and language (e-mails; the interface has its own copy).
COPY: dict[str, dict[str, tuple[str, str]]] = {
    "budget": {
        "en": (
            "{workspace} used {percent}% of its monthly budget",
            "{workspace} has spent {spent} of its {limit} budget for {month}.",
        ),
        "fr": (
            "{workspace} a utilisé {percent} % de son budget mensuel",
            "{workspace} a dépensé {spent} sur son budget de {limit} pour {month}.",
        ),
    },
    "quota": {
        "en": (
            "{workspace} used {percent}% of its monthly runs",
            "{used} of the {limit} runs included in the {plan} plan this month. "
            "New runs are refused at 100%: upgrade the plan to keep going.",
        ),
        "fr": (
            "{workspace} a utilisé {percent} % de ses runs du mois",
            "{used} des {limit} runs inclus dans l'offre {plan} ce mois-ci. "
            "Les nouveaux runs sont refusés à 100 % : passez à l'offre supérieure pour continuer.",
        ),
    },
    "payment_failed": {
        "en": (
            "A payment failed for {workspace}",
            "Update the payment method in the billing portal to keep the {plan} plan.",
        ),
        "fr": (
            "Un paiement a échoué pour {workspace}",
            "Mettez à jour le moyen de paiement dans le portail de facturation pour garder "
            "l'offre {plan}.",
        ),
    },
}


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


class _Values(dict[str, str]):
    """Missing placeholders render empty rather than failing the alert."""

    def __missing__(self, key: str) -> str:
        return ""


def _money(amount: Decimal, currency: str = "USD") -> str:
    return f"${amount:,.2f}" if currency == "USD" else f"{amount:,.2f} {currency}"


async def budget_of(db: AsyncSession, workspace_id: uuid.UUID) -> Budget | None:
    return (
        await db.execute(select(Budget).where(Budget.workspace_id == workspace_id))
    ).scalar_one_or_none()


async def spend_this_period(db: AsyncSession, workspace_id: uuid.UUID) -> Decimal:
    """What this calendar month cost so far (reported and estimated costs, in USD)."""
    from gouvra.modules.billing.service import period_bounds

    start, _ = period_bounds()
    total = (
        await db.execute(
            select(func.coalesce(func.sum(UsageRecord.cost_amount), 0)).where(
                UsageRecord.workspace_id == workspace_id,
                UsageRecord.recorded_at >= start,
                UsageRecord.cost_currency == "USD",
            )
        )
    ).scalar_one()
    return Decimal(total or 0)


async def set_budget(
    db: AsyncSession,
    ctx: WorkspaceContext,
    *,
    monthly_limit: Decimal | None,
    thresholds: list[int],
    hard_stop: bool,
) -> Budget | None:
    ctx.require(Permission.BUDGETS_MANAGE)
    budget = await budget_of(db, ctx.workspace_id)
    if monthly_limit is None:
        if budget is not None:
            await db.delete(budget)
        await record_for(
            db,
            ctx.actor,
            "budget.removed",
            workspace_id=ctx.workspace_id,
            target_type="workspace",
            target_id=ctx.workspace_id,
        )
        await db.commit()
        return None
    if monthly_limit <= 0:
        raise _invalid("monthly_limit", "Set an amount above zero.", "too_small")
    clean = sorted({t for t in thresholds if 1 <= t <= 100})
    if not clean:
        raise _invalid("thresholds", "Choose at least one alert threshold.", "required")
    if budget is None:
        budget = Budget(workspace_id=ctx.workspace_id, monthly_limit=monthly_limit)
        db.add(budget)
    budget.monthly_limit = monthly_limit
    budget.thresholds = clean
    budget.hard_stop = hard_stop
    budget.updated_by_id = ctx.actor.user_id
    await record_for(
        db,
        ctx.actor,
        "budget.updated",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
        data={"monthly_limit": str(monthly_limit), "hard_stop": hard_stop, "thresholds": clean},
    )
    await db.commit()
    await evaluate(db, ctx.workspace_id)
    return budget


async def _admins(db: AsyncSession, workspace_id: uuid.UUID) -> list[User]:
    return list(
        (
            await db.execute(
                select(User)
                .join(Membership, Membership.user_id == User.id)
                .where(
                    Membership.workspace_id == workspace_id,
                    Membership.role.in_([Role.OWNER, Role.ADMIN]),
                    User.email_verified_at.is_not(None),
                )
            )
        ).scalars()
    )


async def raise_alert(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    kind: str,
    key: str,
    level: str,
    data: dict[str, Any] | None = None,
) -> bool:
    """Record an alert once per key and e-mail the owners and admins. True when it is new."""
    inserted = (
        await db.execute(
            insert(Alert)
            .values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                kind=kind,
                key=key,
                level=level,
                data=data or {},
                created_at=utcnow(),
            )
            .on_conflict_do_nothing(index_elements=["workspace_id", "key"])
            .returning(Alert.id)
        )
    ).scalar_one_or_none()
    if inserted is None:
        return False
    workspace = await db.get(Workspace, workspace_id)
    if workspace is None or kind not in COPY:
        return True
    values = _Values(workspace=workspace.name, **{k: str(v) for k, v in (data or {}).items()})
    url = f"{get_settings().app_url.rstrip('/')}/w/{workspace.slug}/usage"
    for user in await _admins(db, workspace_id):
        lang = "fr" if (user.locale or "").startswith("fr") else "en"
        title, body = COPY[kind][lang]
        await queue_email(
            db,
            to=user.email,
            template="alert",
            locale=lang,
            context={
                "title": title.format_map(values),
                "body": body.format_map(values),
                "workspace": workspace.name,
            },
            action_url=url,
            meta={"alert": key},
        )
    log.info("alert_raised", kind=kind, key=key)
    return True


async def evaluate(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    """Raise the alerts this workspace now deserves (each at most once per month)."""
    from gouvra.modules.billing.service import executions_this_period, period_bounds, plan_of

    start, _ = period_bounds()
    month = start.strftime("%Y-%m")
    raised = 0
    budget = await budget_of(db, workspace_id)
    if budget is not None and budget.monthly_limit > 0:
        spent = await spend_this_period(db, workspace_id)
        share = spent / budget.monthly_limit * 100
        for threshold in budget.thresholds:
            if share >= threshold:
                raised += await raise_alert(
                    db,
                    workspace_id,
                    kind="budget",
                    key=f"budget:{month}:{threshold}",
                    level="danger" if threshold >= 100 else "warning",
                    data={
                        "percent": threshold,
                        "spent": _money(spent),
                        "limit": _money(budget.monthly_limit),
                        "month": month,
                    },
                )
    plan = await plan_of(db, workspace_id)
    if plan.executions_per_month:
        used = await executions_this_period(db, workspace_id)
        for threshold in QUOTA_THRESHOLDS:
            if used * 100 >= plan.executions_per_month * threshold:
                raised += await raise_alert(
                    db,
                    workspace_id,
                    kind="quota",
                    key=f"quota:{month}:{threshold}",
                    level="danger" if threshold >= 100 else "warning",
                    data={
                        "percent": threshold,
                        "used": used,
                        "limit": plan.executions_per_month,
                        "plan": plan.name,
                    },
                )
    await db.commit()
    return raised


async def evaluate_recent() -> int:
    """Look at the workspaces that ran something recently (cheap enough every minute)."""
    since = utcnow() - RECENT
    async with get_sessionmaker()() as db:
        workspace_ids = set(
            (
                await db.execute(
                    select(Execution.workspace_id).where(Execution.created_at >= since).distinct()
                )
            ).scalars()
        )
        raised = 0
        for workspace_id in workspace_ids:
            raised += await evaluate(db, workspace_id)
        return raised


async def dismiss(db: AsyncSession, ctx: WorkspaceContext, alert: Alert) -> Alert:
    ctx.require(Permission.BUDGETS_MANAGE)
    alert.dismissed_at = alert.dismissed_at or utcnow()
    await db.commit()
    return alert
