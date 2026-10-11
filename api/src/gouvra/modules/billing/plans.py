"""Plans: what a subscription allows. Self-hosted instances without billing have no limits."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    price_monthly: Decimal
    executions_per_month: int | None  # None: unlimited
    members: int | None
    agents: int | None
    automations: int | None
    concurrency: int
    retention_days_max: int
    lookup_key: str | None  # the Stripe price, found by lookup key
    rank: int

    def allows(self, limit: str, current: int) -> bool:
        cap: int | None = getattr(self, limit)
        return cap is None or current < cap


FREE = Plan(
    key="free",
    name="Free",
    price_monthly=Decimal(0),
    executions_per_month=1_000,
    members=3,
    agents=5,
    automations=3,
    concurrency=2,
    retention_days_max=30,
    lookup_key=None,
    rank=0,
)
TEAM = Plan(
    key="team",
    name="Team",
    price_monthly=Decimal(49),
    executions_per_month=20_000,
    members=20,
    agents=50,
    automations=50,
    concurrency=10,
    retention_days_max=180,
    lookup_key="gouvra_team_monthly",
    rank=1,
)
BUSINESS = Plan(
    key="business",
    name="Business",
    price_monthly=Decimal(249),
    executions_per_month=200_000,
    members=None,
    agents=None,
    automations=None,
    concurrency=50,
    retention_days_max=730,
    lookup_key="gouvra_business_monthly",
    rank=2,
)
# Billing disabled (self-hosted): everything the instance allows.
SELF_HOSTED = Plan(
    key="self_hosted",
    name="Self-hosted",
    price_monthly=Decimal(0),
    executions_per_month=None,
    members=None,
    agents=None,
    automations=None,
    concurrency=10_000,
    retention_days_max=3_650,
    lookup_key=None,
    rank=99,
)

PLANS: dict[str, Plan] = {plan.key: plan for plan in (FREE, TEAM, BUSINESS)}
PAID = (TEAM, BUSINESS)


def plan_for_lookup_key(lookup_key: str | None) -> Plan | None:
    return next((plan for plan in PAID if plan.lookup_key == lookup_key), None)
