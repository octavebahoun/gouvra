"""Overview, Usage and per-agent statistics."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import BadRequest
from gouvra.modules.agents.models import Agent
from gouvra.modules.executions import service as executions_service
from gouvra.modules.executions.models import Execution, ExecutionStatus
from gouvra.modules.executions.schemas import ExecutionSummary
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.usage import service

router = APIRouter(tags=["usage"])


class CostSummary(BaseModel):
    amount: Decimal | None
    currency: str | None
    source: Literal["provider_reported", "estimated", "unavailable"]
    partial: bool
    priced_calls: int
    unpriced_calls: int
    by_source: dict[str, Decimal]


class TokenSummary(BaseModel):
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    model_calls: int


class OverviewOut(BaseModel):
    generated_at: datetime
    agents_active: int
    providers_configured: int
    providers_in_error: int
    running_now: int
    queued_now: int
    executions_24h: dict[str, int]
    executions_7d: dict[str, int]
    success_rate_7d: float | None
    duration_7d: dict[str, int | None]
    month_tokens: TokenSummary
    month_cost: CostSummary
    recent_executions: list[ExecutionSummary]
    recent_failures: list[ExecutionSummary]


class TimePoint(BaseModel):
    start: datetime
    input_tokens: int
    output_tokens: int
    cost: Decimal | None
    unpriced_calls: int
    model_calls: int
    executions: int
    succeeded: int
    failed: int


class BreakdownRow(BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    agent_id: uuid.UUID | None = None
    agent_name: str | None = None
    provider_kind: str | None = None
    model: str | None = None
    input_tokens: int
    output_tokens: int
    cost: Decimal | None
    currency: str | None
    cost_source: Literal["provider_reported", "estimated", "unavailable"]
    partial: bool
    model_calls: int


class LimitsOut(BaseModel):
    max_concurrent_executions: int
    executions_per_minute: int
    max_execution_timeout_s: int
    max_input_bytes: int


class UsageReportOut(BaseModel):
    since: datetime
    until: datetime
    granularity: Literal["hour", "day", "week"]
    tokens: TokenSummary
    cost: CostSummary
    executions: dict[str, int]
    series: list[TimePoint]
    by_agent: list[BreakdownRow]
    by_model: list[BreakdownRow]
    limits: LimitsOut


class AgentStatsOut(BaseModel):
    window_days: int
    executions: dict[str, int]
    success_rate: float | None
    duration: dict[str, int | None]
    tokens: TokenSummary
    cost: CostSummary
    series: list[TimePoint]


def _cost(totals: service.CostTotals) -> CostSummary:
    return CostSummary(
        amount=totals.amount,
        currency=totals.currency,
        source=totals.source,  # type: ignore[arg-type]
        partial=totals.partial,
        priced_calls=totals.priced_calls,
        unpriced_calls=totals.unpriced_calls,
        by_source=totals.by_source,
    )


@router.get("/workspaces/{workspace_id}/overview", summary="Workspace overview")
async def overview(
    db: DbSession, ctx: Annotated[WorkspaceContext, workspace_access(Permission.WORKSPACE_READ)]
) -> OverviewOut:
    now = utcnow()
    ws = ctx.workspace_id
    agents_active = (
        await db.execute(
            select(func.count())
            .select_from(Agent)
            .where(Agent.workspace_id == ws, Agent.archived_at.is_(None))
        )
    ).scalar_one()
    provider_rows = (
        await db.execute(
            select(ProviderConfig.status, func.count())
            .where(ProviderConfig.workspace_id == ws, ProviderConfig.archived_at.is_(None))
            .group_by(ProviderConfig.status)
        )
    ).all()
    providers = {status: int(count) for status, count in provider_rows}
    counts_24h = await service.execution_counts(db, ws, now - timedelta(hours=24))
    counts_7d = await service.execution_counts(db, ws, now - timedelta(days=7))
    live = (
        await db.execute(
            select(Execution.status, func.count())
            .where(
                Execution.workspace_id == ws,
                Execution.status.in_([ExecutionStatus.RUNNING, ExecutionStatus.QUEUED]),
            )
            .group_by(Execution.status)
        )
    ).all()
    live_counts = {status: int(count) for status, count in live}
    recent = list(
        (
            await db.execute(
                select(Execution)
                .where(Execution.workspace_id == ws)
                .order_by(Execution.created_at.desc())
                .limit(6)
            )
        ).scalars()
    )
    failures = list(
        (
            await db.execute(
                select(Execution)
                .where(
                    Execution.workspace_id == ws,
                    Execution.status.in_([ExecutionStatus.FAILED, ExecutionStatus.TIMED_OUT]),
                )
                .order_by(Execution.created_at.desc())
                .limit(5)
            )
        ).scalars()
    )
    month = service.month_start(now)
    return OverviewOut(
        generated_at=now,
        agents_active=int(agents_active),
        providers_configured=sum(providers.values()),
        providers_in_error=providers.get("error", 0),
        running_now=live_counts.get("running", 0),
        queued_now=live_counts.get("queued", 0),
        executions_24h=counts_24h,
        executions_7d=counts_7d,
        success_rate_7d=service.success_rate(counts_7d),
        duration_7d=await service.duration_stats(db, ws, now - timedelta(days=7)),
        month_tokens=TokenSummary(
            **await service.token_totals(db, ws, month, now + timedelta(seconds=1))
        ),
        month_cost=_cost(await service.cost_totals(db, ws, month, now + timedelta(seconds=1))),
        recent_executions=await executions_service.summaries(db, recent),
        recent_failures=await executions_service.summaries(db, failures),
    )


@router.get(
    "/workspaces/{workspace_id}/usage", summary="Tokens, costs and executions over a period"
)
async def usage(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.USAGE_READ)],
    since: datetime | None = None,
    until: datetime | None = None,
    granularity: Annotated[Literal["hour", "day", "week"], Query()] = "day",
) -> UsageReportOut:
    now = utcnow()
    until = until or now + timedelta(seconds=1)
    since = since or service.month_start(now)
    if since >= until:
        raise BadRequest("`since` must be before `until`.", code="invalid_period")
    if until - since > timedelta(days=400):
        raise BadRequest("The period cannot exceed 400 days.", code="invalid_period")
    if granularity == "hour" and until - since > timedelta(days=14):
        granularity = "day"
    ws = ctx.workspace_id
    settings = get_settings()
    from gouvra.core import ratelimit
    from gouvra.modules.executions.queue import workspace_concurrency_limit

    return UsageReportOut(
        since=since,
        until=until,
        granularity=granularity,
        tokens=TokenSummary(**await service.token_totals(db, ws, since, until)),
        cost=_cost(await service.cost_totals(db, ws, since, until)),
        executions=await service.execution_counts(db, ws, since),
        series=[
            TimePoint(**p) for p in await service.timeseries(db, ws, since, until, granularity)
        ],
        by_agent=[
            BreakdownRow(**row) for row in await service.breakdown(db, ws, since, until, "agent")
        ],
        by_model=[
            BreakdownRow(**row) for row in await service.breakdown(db, ws, since, until, "model")
        ],
        limits=LimitsOut(
            max_concurrent_executions=await workspace_concurrency_limit(db, ws),
            executions_per_minute=ratelimit.EXECUTIONS_PER_WORKSPACE.limit,
            max_execution_timeout_s=settings.max_execution_timeout_s,
            max_input_bytes=settings.max_execution_input_bytes,
        ),
    )


@router.get("/agents/{agent_id}/stats", summary="Agent statistics over the last days")
async def agent_stats(
    agent_id: uuid.UUID,
    actor: CurrentActor,
    db: DbSession,
    days: Annotated[int, Query(ge=1, le=90)] = 30,
) -> AgentStatsOut:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_READ)
    now = utcnow()
    since = now - timedelta(days=days)
    counts = await service.execution_counts(db, ctx.workspace_id, since, agent_id=agent.id)
    return AgentStatsOut(
        window_days=days,
        executions=counts,
        success_rate=service.success_rate(counts),
        duration=await service.duration_stats(db, ctx.workspace_id, since, agent_id=agent.id),
        tokens=TokenSummary(
            **await service.token_totals(
                db, ctx.workspace_id, since, now + timedelta(seconds=1), agent_id=agent.id
            )
        ),
        cost=_cost(
            await service.cost_totals(
                db, ctx.workspace_id, since, now + timedelta(seconds=1), agent_id=agent.id
            )
        ),
        series=[
            TimePoint(**p)
            for p in await service.timeseries(
                db, ctx.workspace_id, since, now + timedelta(seconds=1), "day", agent_id=agent.id
            )
        ],
    )
