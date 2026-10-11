"""Billing routes: the workspace's plan and usage, checkout, portal, and Stripe's webhook."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Request
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import DbSession, Permission, WorkspaceContext, workspace_access
from gouvra.core.config import BillingProviderKind, get_settings
from gouvra.core.errors import BadRequest
from gouvra.core.logging import get_logger
from gouvra.modules.billing import service
from gouvra.modules.billing import stripe_gateway as gateway
from gouvra.modules.billing.plans import PLANS
from gouvra.modules.billing.schemas import (
    BillingOut,
    CheckoutIn,
    PlanOut,
    PlansOut,
    RedirectOut,
    SimulatedConfirmIn,
    SubscriptionOut,
    UsageCounts,
)
from gouvra.modules.usage.limits import usage_count

log = get_logger(__name__)
router = APIRouter(tags=["billing"])


async def billing_out(db: AsyncSession, ctx: WorkspaceContext) -> BillingOut:
    subscription = await service.subscription_of(db, ctx.workspace_id)
    start, end = service.period_bounds()
    key = get_settings().stripe_secret_key.get_secret_value()
    return BillingOut(
        enabled=service.billing_enabled(),
        provider=service.provider().value,
        test_mode=service.provider() is not BillingProviderKind.STRIPE
        or key.startswith("sk_test_"),
        plan=PlanOut.of(service.effective_plan(subscription)),
        subscription=SubscriptionOut(
            status=subscription.status,
            provider=subscription.provider,
            current_period_end=subscription.current_period_end,
            cancel_at_period_end=subscription.cancel_at_period_end,
            granted_by_admin=subscription.granted_by_admin,
        )
        if subscription
        else None,
        usage=UsageCounts(
            executions=await service.executions_this_period(db, ctx.workspace_id),
            members=await usage_count(db, ctx.workspace_id, "members"),
            agents=await usage_count(db, ctx.workspace_id, "agents"),
            automations=await usage_count(db, ctx.workspace_id, "automations"),
            period_start=start,
            period_end=end,
        ),
        plans=[PlanOut.of(plan) for plan in PLANS.values()],
        can_manage=ctx.can(Permission.BILLING_MANAGE),
    )


@router.get("/billing/plans", summary="Plans offered by this instance")
async def plans() -> PlansOut:
    return PlansOut(
        enabled=service.billing_enabled(), plans=[PlanOut.of(plan) for plan in PLANS.values()]
    )


@router.get("/workspaces/{workspace_id}/billing", summary="Plan, subscription and usage")
async def billing(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BILLING_READ)],
) -> BillingOut:
    return await billing_out(db, ctx)


@router.post(
    "/workspaces/{workspace_id}/billing/checkout",
    summary="Start subscribing to a paid plan (returns where to send the browser)",
)
async def checkout(
    payload: CheckoutIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BILLING_MANAGE)],
) -> RedirectOut:
    return RedirectOut(url=await service.start_checkout(db, ctx, payload.plan))


@router.post(
    "/workspaces/{workspace_id}/billing/portal",
    summary="Open the billing portal (payment method, invoices, plan changes, cancellation)",
)
async def portal(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BILLING_MANAGE)],
) -> RedirectOut:
    return RedirectOut(url=await service.open_portal(db, ctx))


@router.post(
    "/workspaces/{workspace_id}/billing/simulated/confirm",
    summary="Confirm a simulated payment (instances without a payment provider)",
)
async def simulated_confirm(
    payload: SimulatedConfirmIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BILLING_MANAGE)],
) -> BillingOut:
    await service.simulated_confirm(db, ctx, payload.plan, payload.token)
    return await billing_out(db, ctx)


@router.post(
    "/workspaces/{workspace_id}/billing/simulated/cancel",
    summary="Cancel a simulated subscription at the end of its period",
)
async def simulated_cancel(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.BILLING_MANAGE)],
) -> BillingOut:
    await service.simulated_cancel(db, ctx)
    return await billing_out(db, ctx)


@router.post(
    "/billing/stripe/webhook",
    summary="Stripe events (signature verified; each event applied once)",
    responses={400: {"description": "Missing or invalid Stripe-Signature"}},
)
async def stripe_webhook(request: Request, db: DbSession) -> dict[str, str]:
    import stripe

    payload = await request.body()
    try:
        event = gateway.construct_event(payload, request.headers.get("stripe-signature"))
    except (ValueError, stripe.SignatureVerificationError) as exc:
        log.warning("stripe_webhook_rejected", reason=type(exc).__name__)
        raise BadRequest("Invalid Stripe signature.", code="invalid_signature") from exc
    outcome = await service.handle_stripe_event(db, event)
    return {"received": "true", "outcome": outcome}
