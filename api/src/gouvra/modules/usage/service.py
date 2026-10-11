"""Aggregates for Overview and Usage: only metrics whose provenance is known.

Costs are reported per source (provider_reported / estimated / unavailable) and totals carry a
`partial` flag whenever some calls had no price — never a misleading zero.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.db import utcnow
from gouvra.modules.agents.models import Agent
from gouvra.modules.executions.models import Execution, ExecutionStatus, UsageRecord

Granularity = Literal["hour", "day", "week"]


@dataclass
class CostTotals:
    amount: Decimal | None
    currency: str | None
    priced_calls: int
    unpriced_calls: int
    by_source: dict[str, Decimal]

    @property
    def partial(self) -> bool:
        return self.unpriced_calls > 0 and self.priced_calls > 0

    @property
    def source(self) -> str:
        if self.priced_calls == 0:
            return "unavailable"
        if set(self.by_source) == {"provider_reported"} and self.unpriced_calls == 0:
            return "provider_reported"
        return "estimated"


async def cost_totals(
    db: AsyncSession, workspace_id: uuid.UUID, since: datetime, until: datetime, **filters: Any
) -> CostTotals:
    query = (
        select(
            UsageRecord.cost_source,
            UsageRecord.cost_currency,
            func.count(),
            func.coalesce(func.sum(UsageRecord.cost_amount), 0),
        )
        .where(
            UsageRecord.workspace_id == workspace_id,
            UsageRecord.recorded_at >= since,
            UsageRecord.recorded_at < until,
        )
        .group_by(UsageRecord.cost_source, UsageRecord.cost_currency)
    )
    for column, value in filters.items():
        if value is not None:
            query = query.where(getattr(UsageRecord, column) == value)
    priced = unpriced = 0
    by_source: dict[str, Decimal] = {}
    currency: str | None = None
    for source, cur, count, amount in (await db.execute(query)).all():
        if source == "unavailable":
            unpriced += int(count)
            continue
        priced += int(count)
        currency = currency or cur
        by_source[source] = by_source.get(source, Decimal(0)) + Decimal(amount or 0)
    total = sum(by_source.values(), Decimal(0)) if priced else None
    return CostTotals(
        amount=total,
        currency=currency,
        priced_calls=priced,
        unpriced_calls=unpriced,
        by_source=by_source,
    )


async def execution_counts(
    db: AsyncSession, workspace_id: uuid.UUID, since: datetime, agent_id: uuid.UUID | None = None
) -> dict[str, int]:
    query = select(Execution.status, func.count()).where(
        Execution.workspace_id == workspace_id, Execution.created_at >= since
    )
    if agent_id is not None:
        query = query.where(Execution.agent_id == agent_id)
    rows = (await db.execute(query.group_by(Execution.status))).all()
    counts = {status.value: 0 for status in ExecutionStatus}
    counts.update({status: int(count) for status, count in rows})
    return counts


def success_rate(counts: dict[str, int]) -> float | None:
    """Succeeded / finished (cancelled runs are excluded: they are a user decision)."""
    finished = counts["succeeded"] + counts["failed"] + counts["timed_out"]
    return round(counts["succeeded"] / finished, 4) if finished else None


async def duration_stats(
    db: AsyncSession, workspace_id: uuid.UUID, since: datetime, agent_id: uuid.UUID | None = None
) -> dict[str, int | None]:
    query = select(
        func.percentile_cont(0.5).within_group(Execution.duration_ms),
        func.percentile_cont(0.95).within_group(Execution.duration_ms),
    ).where(
        Execution.workspace_id == workspace_id,
        Execution.created_at >= since,
        Execution.status == ExecutionStatus.SUCCEEDED,
        Execution.duration_ms.is_not(None),
    )
    if agent_id is not None:
        query = query.where(Execution.agent_id == agent_id)
    p50, p95 = (await db.execute(query)).one()
    return {
        "p50_ms": int(p50) if p50 is not None else None,
        "p95_ms": int(p95) if p95 is not None else None,
    }


async def token_totals(
    db: AsyncSession, workspace_id: uuid.UUID, since: datetime, until: datetime, **filters: Any
) -> dict[str, int]:
    query = select(
        func.coalesce(func.sum(UsageRecord.input_tokens), 0),
        func.coalesce(func.sum(UsageRecord.output_tokens), 0),
        func.coalesce(func.sum(UsageRecord.cached_tokens), 0),
        func.coalesce(func.sum(UsageRecord.reasoning_tokens), 0),
        func.count(),
    ).where(
        UsageRecord.workspace_id == workspace_id,
        UsageRecord.recorded_at >= since,
        UsageRecord.recorded_at < until,
    )
    for column, value in filters.items():
        if value is not None:
            query = query.where(getattr(UsageRecord, column) == value)
    inp, out, cached, reasoning, calls = (await db.execute(query)).one()
    return {
        "input_tokens": int(inp),
        "output_tokens": int(out),
        "cached_tokens": int(cached),
        "reasoning_tokens": int(reasoning),
        "model_calls": int(calls),
    }


async def timeseries(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    since: datetime,
    until: datetime,
    granularity: Granularity,
    agent_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    bucket = func.date_trunc(granularity, UsageRecord.recorded_at)
    query = (
        select(
            bucket.label("bucket"),
            func.sum(UsageRecord.input_tokens),
            func.sum(UsageRecord.output_tokens),
            func.sum(
                case(
                    (UsageRecord.cost_source != "unavailable", UsageRecord.cost_amount), else_=None
                )
            ),
            func.sum(case((UsageRecord.cost_source == "unavailable", 1), else_=0)),
            func.count(),
        )
        .where(
            UsageRecord.workspace_id == workspace_id,
            UsageRecord.recorded_at >= since,
            UsageRecord.recorded_at < until,
        )
        .group_by(bucket)
        .order_by(bucket)
    )
    if agent_id is not None:
        query = query.where(UsageRecord.agent_id == agent_id)
    usage_rows = {row[0]: row for row in (await db.execute(query)).all()}
    run_bucket = func.date_trunc(granularity, Execution.created_at)
    run_query = (
        select(
            run_bucket,
            func.count(),
            func.sum(case((Execution.status == ExecutionStatus.SUCCEEDED, 1), else_=0)),
            func.sum(
                case(
                    (Execution.status.in_([ExecutionStatus.FAILED, ExecutionStatus.TIMED_OUT]), 1),
                    else_=0,
                )
            ),
        )
        .where(
            Execution.workspace_id == workspace_id,
            Execution.created_at >= since,
            Execution.created_at < until,
        )
        .group_by(run_bucket)
    )
    if agent_id is not None:
        run_query = run_query.where(Execution.agent_id == agent_id)
    run_rows = {row[0]: row for row in (await db.execute(run_query)).all()}
    step = {"hour": timedelta(hours=1), "day": timedelta(days=1), "week": timedelta(weeks=1)}[
        granularity
    ]
    start = since.replace(minute=0, second=0, microsecond=0)
    if granularity in ("day", "week"):
        start = start.replace(hour=0)
    if granularity == "week":
        start -= timedelta(days=start.weekday())
    points: list[dict[str, Any]] = []
    cursor = start
    while cursor < until and len(points) < 400:
        usage = usage_rows.get(cursor)
        runs = run_rows.get(cursor)
        points.append(
            {
                "start": cursor,
                "input_tokens": int(usage[1] or 0) if usage else 0,
                "output_tokens": int(usage[2] or 0) if usage else 0,
                "cost": Decimal(usage[3]) if usage and usage[3] is not None else None,
                "unpriced_calls": int(usage[4] or 0) if usage else 0,
                "model_calls": int(usage[5] or 0) if usage else 0,
                "executions": int(runs[1]) if runs else 0,
                "succeeded": int(runs[2] or 0) if runs else 0,
                "failed": int(runs[3] or 0) if runs else 0,
            }
        )
        cursor += step
    return points


async def breakdown(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    since: datetime,
    until: datetime,
    by: Literal["agent", "model"],
) -> list[dict[str, Any]]:
    keys = (
        (UsageRecord.agent_id,) if by == "agent" else (UsageRecord.provider_kind, UsageRecord.model)
    )
    query = (
        select(
            *keys,
            func.sum(UsageRecord.input_tokens),
            func.sum(UsageRecord.output_tokens),
            func.sum(
                case(
                    (UsageRecord.cost_source != "unavailable", UsageRecord.cost_amount), else_=None
                )
            ),
            func.sum(case((UsageRecord.cost_source == "unavailable", 1), else_=0)),
            func.count(),
            func.max(UsageRecord.cost_currency),
            func.bool_or(UsageRecord.cost_source == "provider_reported"),
        )
        .where(
            UsageRecord.workspace_id == workspace_id,
            UsageRecord.recorded_at >= since,
            UsageRecord.recorded_at < until,
        )
        .group_by(*keys)
    )
    rows = (await db.execute(query)).all()
    names: dict[uuid.UUID, str] = {}
    if by == "agent":
        ids = [r[0] for r in rows if r[0] is not None]
        if ids:
            names = {
                a.id: a.name
                for a in (await db.execute(select(Agent).where(Agent.id.in_(ids)))).scalars()
            }
    out: list[dict[str, Any]] = []
    for row in rows:
        offset = len(keys)
        inp, outp, cost, unpriced, calls, currency, reported = row[offset:]
        entry: dict[str, Any] = {
            "input_tokens": int(inp or 0),
            "output_tokens": int(outp or 0),
            "cost": Decimal(cost) if cost is not None else None,
            "currency": currency,
            "cost_source": ("provider_reported" if reported else "estimated")
            if cost is not None
            else "unavailable",
            "partial": cost is not None and int(unpriced or 0) > 0,
            "model_calls": int(calls),
        }
        if by == "agent":
            entry["agent_id"] = row[0]
            entry["agent_name"] = names.get(row[0], "Deleted agent") if row[0] else "Deleted agent"
        else:
            entry["provider_kind"], entry["model"] = row[0], row[1]
        out.append(entry)
    out.sort(
        key=lambda e: (
            e["cost"] is None,
            -(e["cost"] or 0),
            -(e["input_tokens"] + e["output_tokens"]),
        )
    )
    return out


def month_start(now: datetime | None = None) -> datetime:
    moment = now or utcnow()
    return moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
