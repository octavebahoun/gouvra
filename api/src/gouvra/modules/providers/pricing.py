"""Cost of a model call, with an explicit source: provider_reported, estimated or unavailable."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

from gouvra.modules.providers.catalog import ModelInfo
from gouvra.modules.providers.gateway.types import Usage

MILLION = Decimal(1_000_000)
QUANTUM = Decimal("0.00000001")


class CostSource(StrEnum):
    PROVIDER_REPORTED = "provider_reported"
    ESTIMATED = "estimated"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class Cost:
    amount: Decimal | None
    currency: str | None
    source: CostSource
    pricing_as_of: date | None = None
    price_period: str | None = None  # peak / off_peak / standard
    # True when some of the aggregated calls had no price: the amount is a lower bound.
    partial: bool = False

    @classmethod
    def unavailable(cls) -> Cost:
        return cls(amount=None, currency=None, source=CostSource.UNAVAILABLE)


def estimate(model: ModelInfo | None, usage: Usage, at: datetime) -> Cost:
    if usage.provider_cost is not None:
        return Cost(
            usage.provider_cost.quantize(QUANTUM, ROUND_HALF_UP),
            usage.provider_cost_currency or "USD",
            CostSource.PROVIDER_REPORTED,
        )
    if model is None or model.pricing is None:
        return Cost.unavailable()
    price, period = model.pricing.price_at(at)
    cached = min(usage.cached_input_tokens, usage.input_tokens)
    writes = min(usage.cache_write_tokens, usage.input_tokens - cached)
    fresh = usage.input_tokens - cached - writes
    total = (
        Decimal(fresh) * price.input
        + Decimal(cached) * (price.cached_input if price.cached_input is not None else price.input)
        + Decimal(writes) * (price.cache_write if price.cache_write is not None else price.input)
        + Decimal(usage.output_tokens) * price.output
    ) / MILLION
    return Cost(
        total.quantize(QUANTUM, ROUND_HALF_UP),
        model.pricing.currency,
        CostSource.ESTIMATED,
        model.pricing.as_of,
        period,
    )


def combine(costs: list[Cost]) -> Cost:
    """Aggregate per-call costs.

    Reported if all were reported, estimated if any was priced, unavailable otherwise.
    """
    priced = [c for c in costs if c.amount is not None]
    if not priced:
        return Cost.unavailable()
    amount = sum((c.amount for c in priced if c.amount is not None), Decimal(0))
    source = (
        CostSource.PROVIDER_REPORTED
        if all(c.source == CostSource.PROVIDER_REPORTED for c in costs)
        else CostSource.ESTIMATED
    )
    return Cost(
        amount.quantize(QUANTUM, ROUND_HALF_UP),
        priced[0].currency,
        source,
        partial=len(priced) < len(costs) or any(c.partial for c in priced),
    )
