"""Billing: the plan each workspace is on, checkout and portal, and provider events.

The provider (Stripe in test or live mode, or a simulated one for demos) is chosen per
instance with BILLING_PROVIDER. With `none`, billing is off and every workspace is on the
self-hosted plan (no limit). Subscriptions are only ever changed by verified provider events
(or an instance administrator), never by the browser.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.config import BillingProviderKind, get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.logging import get_logger
from gouvra.modules.audit.service import record, record_for
from gouvra.modules.billing import stripe_gateway as gateway
from gouvra.modules.billing.models import BillingEvent, Subscription
from gouvra.modules.billing.plans import FREE, PLANS, SELF_HOSTED, Plan, plan_for_lookup_key
from gouvra.modules.executions.models import Execution
from gouvra.modules.identity.models import User
from gouvra.modules.workspaces.models import Workspace

log = get_logger(__name__)

PAID_STATUSES = {"active", "trialing", "past_due"}  # past_due: a grace period while Stripe retries
SIMULATED_PERIOD = timedelta(days=30)
TOKEN_TTL_S = 3600


def provider() -> BillingProviderKind:
    return get_settings().billing_provider


def billing_enabled() -> bool:
    return provider() is not BillingProviderKind.NONE


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


async def subscription_of(db: AsyncSession, workspace_id: uuid.UUID) -> Subscription | None:
    return (
        await db.execute(select(Subscription).where(Subscription.workspace_id == workspace_id))
    ).scalar_one_or_none()


def effective_plan(subscription: Subscription | None) -> Plan:
    if not billing_enabled():
        return SELF_HOSTED
    if subscription is None or subscription.status not in PAID_STATUSES:
        return FREE
    return PLANS.get(subscription.plan, FREE)


async def plan_of(db: AsyncSession, workspace_id: uuid.UUID) -> Plan:
    return effective_plan(await subscription_of(db, workspace_id))


def period_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """Quotas count per calendar month (UTC)."""
    now = now or utcnow()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start + timedelta(days=32)).replace(day=1)
    return start, end


async def executions_this_period(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    start, _ = period_bounds()
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Execution)
                .where(Execution.workspace_id == workspace_id, Execution.created_at >= start)
            )
        ).scalar_one()
    )


async def _owner_email(db: AsyncSession, workspace: Workspace) -> str:
    owner = await db.get(User, workspace.owner_id)
    return owner.email if owner else ""


async def _ensure_row(db: AsyncSession, workspace_id: uuid.UUID) -> Subscription:
    current = await subscription_of(db, workspace_id)
    if current is None:
        current = Subscription(
            workspace_id=workspace_id, plan=FREE.key, status="active", provider=provider().value
        )
        db.add(current)
        await db.flush()
    return current


def _billing_page(workspace: Workspace) -> str:
    return f"{get_settings().app_url.rstrip('/')}/w/{workspace.slug}/settings/billing"


# ---------------------------------------------------------------- checkout & portal


async def start_checkout(db: AsyncSession, ctx: WorkspaceContext, plan_key: str) -> str:
    """Where to send the browser to subscribe to a paid plan."""
    ctx.require(Permission.BILLING_MANAGE)
    if not billing_enabled():
        raise Conflict("Billing is not enabled on this instance.", code="billing_disabled")
    plan = PLANS.get(plan_key)
    if plan is None or plan.lookup_key is None:
        raise _invalid("plan", "Choose a paid plan.", "unknown_plan")
    current = await subscription_of(db, ctx.workspace_id)
    if current and effective_plan(current).key == plan.key and not current.cancel_at_period_end:
        raise Conflict("This workspace is already on this plan.", code="already_subscribed")
    if (
        current
        and current.subscription_id
        and current.status in PAID_STATUSES
        and provider() is BillingProviderKind.STRIPE
    ):
        raise Conflict(
            "Change or cancel the current subscription from the billing portal.",
            code="use_portal",
        )
    workspace = ctx.workspace
    page = _billing_page(workspace)
    if provider() is BillingProviderKind.SIMULATED:
        return f"{page}/checkout?plan={plan.key}&token={simulated_token(workspace.id, plan.key)}"
    row = await _ensure_row(db, ctx.workspace_id)
    row.customer_id = await gateway.ensure_customer(
        row.customer_id,
        email=await _owner_email(db, workspace),
        name=workspace.name,
        workspace_id=str(workspace.id),
    )
    row.provider = BillingProviderKind.STRIPE.value
    url = await gateway.checkout_url(
        customer_id=row.customer_id,
        plan=plan,
        workspace_id=str(workspace.id),
        success_url=f"{page}?checkout=success",
        cancel_url=f"{page}?checkout=cancelled",
    )
    await record_for(
        db,
        ctx.actor,
        "billing.checkout_started",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
        data={"plan": plan.key},
    )
    await db.commit()
    return url


async def open_portal(db: AsyncSession, ctx: WorkspaceContext) -> str:
    ctx.require(Permission.BILLING_MANAGE)
    if provider() is not BillingProviderKind.STRIPE:
        raise Conflict("The billing portal needs Stripe.", code="portal_unavailable")
    row = await subscription_of(db, ctx.workspace_id)
    if row is None or row.customer_id is None:
        raise Conflict("Subscribe to a plan first.", code="no_customer")
    return await gateway.portal_url(
        customer_id=row.customer_id, return_url=_billing_page(ctx.workspace)
    )


# ---------------------------------------------------------------- simulated provider


def simulated_token(workspace_id: uuid.UUID, plan: str, expires: int | None = None) -> str:
    """A signed, short-lived proof that this instance offered this checkout."""
    expires = expires or int(time.time()) + TOKEN_TTL_S
    key = get_settings().session_secret.get_secret_value().encode()
    digest = hmac.new(key, f"checkout:{workspace_id}:{plan}:{expires}".encode(), hashlib.sha256)
    return f"{expires}.{digest.hexdigest()}"


def _token_valid(workspace_id: uuid.UUID, plan: str, token: str) -> bool:
    expires_text, _, _ = token.partition(".")
    if not expires_text.isdigit() or int(expires_text) < time.time():
        return False
    return hmac.compare_digest(token, simulated_token(workspace_id, plan, int(expires_text)))


async def simulated_confirm(
    db: AsyncSession, ctx: WorkspaceContext, plan_key: str, token: str
) -> Subscription:
    ctx.require(Permission.BILLING_MANAGE)
    if provider() is not BillingProviderKind.SIMULATED:
        raise Conflict("Simulated payments are disabled.", code="simulation_disabled")
    plan = PLANS.get(plan_key)
    if (
        plan is None
        or plan.lookup_key is None
        or not _token_valid(ctx.workspace_id, plan_key, token)
    ):
        raise _invalid("token", "This checkout link expired. Start again.", "invalid_token")
    row = await _ensure_row(db, ctx.workspace_id)
    row.plan, row.status, row.provider = plan.key, "active", BillingProviderKind.SIMULATED.value
    row.current_period_end = utcnow() + SIMULATED_PERIOD
    row.cancel_at_period_end = False
    await record_for(
        db,
        ctx.actor,
        "billing.subscribed",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
        data={"plan": plan.key, "provider": "simulated"},
    )
    await db.commit()
    return row


async def simulated_cancel(db: AsyncSession, ctx: WorkspaceContext) -> Subscription:
    ctx.require(Permission.BILLING_MANAGE)
    if provider() is not BillingProviderKind.SIMULATED:
        raise Conflict("Use the billing portal to cancel.", code="use_portal")
    row = await subscription_of(db, ctx.workspace_id)
    if row is None or row.plan == FREE.key:
        raise Conflict("There is no paid subscription to cancel.", code="nothing_to_cancel")
    row.cancel_at_period_end = True
    await record_for(
        db,
        ctx.actor,
        "billing.cancel_requested",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
    )
    await db.commit()
    return row


async def expire_simulated(db: AsyncSession) -> int:
    """Simulated subscriptions cancelled at period end drop to Free when the period ends."""
    rows = list(
        (
            await db.execute(
                select(Subscription).where(
                    Subscription.provider == BillingProviderKind.SIMULATED.value,
                    Subscription.cancel_at_period_end.is_(True),
                    Subscription.current_period_end < utcnow(),
                )
            )
        ).scalars()
    )
    for row in rows:
        row.plan, row.status, row.cancel_at_period_end = FREE.key, "canceled", False
    await db.commit()
    return len(rows)


# ---------------------------------------------------------------- Stripe events


async def _workspace_for(
    db: AsyncSession, metadata: Any, customer_id: str | None
) -> uuid.UUID | None:
    workspace_id = (metadata or {}).get("workspace_id") if metadata else None
    if workspace_id:
        try:
            return uuid.UUID(str(workspace_id))
        except ValueError:
            return None
    if customer_id:
        row = (
            await db.execute(select(Subscription).where(Subscription.customer_id == customer_id))
        ).scalar_one_or_none()
        return row.workspace_id if row else None
    return None


async def sync_subscription(db: AsyncSession, workspace_id: uuid.UUID, sub: Any) -> Subscription:
    """Mirror a Stripe subscription: plan (from its price's lookup key), status, period."""
    row = await _ensure_row(db, workspace_id)
    plan = plan_for_lookup_key(gateway.lookup_key_of(sub))
    before = (row.plan, row.status)
    row.provider = BillingProviderKind.STRIPE.value
    row.subscription_id = sub.get("id")
    row.customer_id = sub.get("customer") or row.customer_id
    row.status = sub.get("status") or row.status
    row.plan = plan.key if plan and row.status != "canceled" else FREE.key
    row.current_period_end = gateway.period_end(sub)
    row.cancel_at_period_end = bool(sub.get("cancel_at_period_end"))
    if (row.plan, row.status) != before:
        await record(
            db,
            "billing.subscription_changed",
            actor_label="stripe",
            workspace_id=workspace_id,
            target_type="workspace",
            target_id=workspace_id,
            data={"plan": row.plan, "status": row.status, "previous": list(before)},
        )
    return row


async def handle_stripe_event(db: AsyncSession, event: Any) -> str:
    """Apply one verified event, once. Returns what happened (for logs and tests)."""
    if await db.get(BillingEvent, event["id"]) is not None:
        return "duplicate"
    kind: str = event["type"]
    obj = event["data"]["object"]
    workspace_id: uuid.UUID | None = None
    outcome = "ignored"
    if kind == "checkout.session.completed":
        workspace_id = await _workspace_for(db, obj.get("metadata"), obj.get("customer"))
        if workspace_id is None and obj.get("client_reference_id"):
            workspace_id = uuid.UUID(str(obj["client_reference_id"]))
        if workspace_id and obj.get("subscription"):
            await sync_subscription(
                db, workspace_id, await gateway.subscription(obj["subscription"])
            )
            outcome = "subscribed"
    elif kind.startswith("customer.subscription."):
        workspace_id = await _workspace_for(db, obj.get("metadata"), obj.get("customer"))
        if workspace_id:
            await sync_subscription(db, workspace_id, obj)
            outcome = "synced"
    elif kind in ("invoice.payment_failed", "invoice.paid"):
        workspace_id = await _workspace_for(db, None, obj.get("customer"))
        if workspace_id:
            row = await _ensure_row(db, workspace_id)
            row.status = "past_due" if kind == "invoice.payment_failed" else "active"
            outcome = "payment_failed" if kind == "invoice.payment_failed" else "paid"
            if kind == "invoice.payment_failed":
                from gouvra.modules.budgets.service import raise_alert

                await raise_alert(
                    db,
                    workspace_id,
                    kind="payment_failed",
                    key=f"payment_failed:{obj.get('id')}",
                    level="danger",
                    data={"plan": PLANS.get(row.plan, FREE).name},
                )
    db.add(
        BillingEvent(
            id=event["id"],
            type=kind,
            workspace_id=workspace_id,
            summary={"outcome": outcome, "livemode": bool(event.get("livemode"))},
        )
    )
    await db.commit()
    log.info("stripe_event", type=kind, outcome=outcome)
    return outcome


# ---------------------------------------------------------------- administration


async def grant_plan(
    db: AsyncSession, workspace_id: uuid.UUID, plan_key: str, actor: Any
) -> Subscription:
    """An instance administrator puts a workspace on a plan without payment (or back to Free)."""
    plan = PLANS.get(plan_key)
    if plan is None:
        raise _invalid("plan", "Unknown plan.", "unknown_plan")
    row = await _ensure_row(db, workspace_id)
    row.plan, row.status, row.granted_by_admin = plan.key, "active", plan.key != FREE.key
    row.cancel_at_period_end = False
    await record_for(
        db,
        actor,
        "admin.plan_granted",
        workspace_id=workspace_id,
        target_type="workspace",
        target_id=workspace_id,
        data={"plan": plan.key},
    )
    await db.commit()
    return row
