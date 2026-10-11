"""Billing API contracts."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from gouvra.modules.billing.plans import Plan


class PlanOut(BaseModel):
    key: str
    name: str
    price_monthly: Decimal
    executions_per_month: int | None
    members: int | None
    agents: int | None
    automations: int | None
    concurrency: int
    retention_days_max: int
    paid: bool

    @classmethod
    def of(cls, plan: Plan) -> PlanOut:
        return cls(
            key=plan.key,
            name=plan.name,
            price_monthly=plan.price_monthly,
            executions_per_month=plan.executions_per_month,
            members=plan.members,
            agents=plan.agents,
            automations=plan.automations,
            concurrency=plan.concurrency,
            retention_days_max=plan.retention_days_max,
            paid=plan.lookup_key is not None,
        )


class PlansOut(BaseModel):
    enabled: bool
    plans: list[PlanOut]


class SubscriptionOut(BaseModel):
    status: str
    provider: str
    current_period_end: datetime | None
    cancel_at_period_end: bool
    granted_by_admin: bool


class UsageCounts(BaseModel):
    executions: int
    members: int
    agents: int
    automations: int
    period_start: datetime
    period_end: datetime


class BillingOut(BaseModel):
    enabled: bool
    provider: Literal["none", "simulated", "stripe"]
    test_mode: bool = Field(description="Stripe test keys: no real charge")
    plan: PlanOut
    subscription: SubscriptionOut | None
    usage: UsageCounts
    plans: list[PlanOut]
    can_manage: bool


class CheckoutIn(BaseModel):
    plan: Literal["team", "business"]


class SimulatedConfirmIn(BaseModel):
    plan: Literal["team", "business"]
    token: str = Field(max_length=200)


class RedirectOut(BaseModel):
    url: str
