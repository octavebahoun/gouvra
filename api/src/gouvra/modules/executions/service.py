"""Launch, cancel and retry executions; serialise them for the API."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any, Literal

import orjson
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core import ratelimit
from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import AppError, Conflict, PayloadTooLarge, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.agents.service import readiness
from gouvra.modules.executions.events import (
    EventEmitter,
    append_event,
    publish,
    publish_event,
    publish_status,
    workspace_channel,
)
from gouvra.modules.executions.models import TERMINAL, Execution, ExecutionStatus, Trigger
from gouvra.modules.executions.queue import notify_cancel, notify_queue
from gouvra.modules.executions.schemas import (
    AgentRef,
    CostOut,
    ErrorOut,
    ExecutionOut,
    ExecutionSummary,
    UsageOut,
)
from gouvra.modules.identity.models import User

IDEMPOTENCY_WINDOW = timedelta(hours=24)


class AgentNotReady(AppError):
    status_code = 409
    code = "agent_not_ready"
    title = "This agent cannot run yet"


def normalise_input(raw: str | dict[str, Any]) -> dict[str, Any]:
    payload = {"text": raw} if isinstance(raw, str) else {"json": raw}
    size = len(orjson.dumps(payload))
    limit = get_settings().max_execution_input_bytes
    if size > limit:
        raise PayloadTooLarge(
            f"The input is {size} bytes; the limit is {limit} bytes.",
            details={"limit_bytes": limit},
        )
    if isinstance(raw, str) and not raw.strip():
        raise ValidationFailed(
            errors=[
                {
                    "field": "input",
                    "code": "empty",
                    "message": "Give the agent something to work on.",
                }
            ]
        )
    return payload


def request_hash(agent_id: uuid.UUID, payload: dict[str, Any], timeout_s: int | None) -> str:
    canonical = json.dumps(
        {"agent": str(agent_id), "input": payload, "timeout": timeout_s},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


async def launch(
    db: AsyncSession,
    ctx: WorkspaceContext,
    agent: Agent,
    raw_input: str | dict[str, Any],
    *,
    trigger: Trigger,
    timeout_s: int | None = None,
    idempotency_key: str | None = None,
    metadata: dict[str, Any] | None = None,
    source_id: str | None = None,
    parent_execution_id: uuid.UUID | None = None,
    priority: int = 0,
) -> tuple[Execution, bool]:
    """Queue an execution. Returns (execution, created) — created=False on an idempotent replay."""
    ctx.require(Permission.EXECUTIONS_LAUNCH)
    payload = normalise_input(raw_input)
    digest = request_hash(agent.id, payload, timeout_s)
    if idempotency_key:
        existing = (
            await db.execute(
                select(Execution).where(
                    Execution.workspace_id == ctx.workspace_id,
                    Execution.idempotency_key == idempotency_key,
                    Execution.created_at > utcnow() - IDEMPOTENCY_WINDOW,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.request_hash != digest:
                raise ValidationFailed(
                    "This Idempotency-Key was already used with a different request.",
                    code="idempotency_mismatch",
                )
            return existing, False
    await ratelimit.hit(ratelimit.EXECUTIONS_PER_WORKSPACE, str(ctx.workspace_id))
    if agent.archived_at is not None:
        raise Conflict(
            "Archived agents cannot run. Restore the agent first.", code="agent_archived"
        )
    version = (
        await db.get(AgentVersion, agent.current_version_id) if agent.current_version_id else None
    )
    check = await readiness(db, version)
    if not check.ready or version is None:
        raise AgentNotReady(
            "Configure a provider and a model for this agent before running it.",
            details={"issues": check.issues},
        )
    from gouvra.modules.usage.guard import check_launch_allowed

    await check_launch_allowed(db, ctx.workspace_id)
    settings = get_settings()
    limit_timeout = int(
        (version.limits or {}).get("timeout_s", settings.default_execution_timeout_s)
    )
    effective_timeout = min(timeout_s or limit_timeout, settings.max_execution_timeout_s)
    from gouvra.modules.providers.models import ProviderConfig

    provider = (
        await db.get(ProviderConfig, version.provider_config_id)
        if version.provider_config_id
        else None
    )
    execution = Execution(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        agent_id=agent.id,
        agent_version_id=version.id,
        parent_execution_id=parent_execution_id,
        trigger=trigger,
        triggered_by_user_id=ctx.actor.user_id,
        api_key_id=ctx.actor.api_key_id,
        source_id=source_id,
        status=ExecutionStatus.QUEUED,
        input=payload,
        metadata_=metadata or {},
        priority=priority,
        timeout_s=effective_timeout,
        idempotency_key=idempotency_key,
        request_hash=digest,
        provider_kind=provider.kind if provider else None,
        model=version.model,
        cost_source="unavailable",
    )
    db.add(execution)
    await db.flush()
    await notify_queue(db)
    await db.commit()
    emitter = EventEmitter(execution.id, execution.workspace_id, 0)
    preview = (
        payload.get("text")
        if isinstance(payload.get("text"), str)
        else json.dumps(payload.get("json"))[:500]
    )
    await emitter.emit(
        "execution.queued",
        {
            "trigger": trigger.value,
            "agent": agent.name,
            "agent_version": version.number,
            "input_preview": (preview or "")[:500],
            "timeout_s": effective_timeout,
        },
    )
    await db.refresh(execution)
    await publish_status(execution)
    return execution, True


async def cancel(db: AsyncSession, ctx: WorkspaceContext, execution: Execution) -> Execution:
    if execution.status in TERMINAL:
        raise Conflict("This execution has already finished.", code="execution_finished")
    now = utcnow()
    # A queued run is cancelled on the spot; a running one is signalled to its worker.
    result = await db.execute(
        update(Execution)
        .where(Execution.id == execution.id, Execution.status == ExecutionStatus.QUEUED)
        .values(
            status=ExecutionStatus.CANCELLED,
            cancel_requested_at=now,
            cancel_requested_by_id=ctx.actor.user_id,
            finished_at=now,
            duration_ms=0,
            error={
                "code": "cancelled",
                "message": "Cancelled before it started.",
                "retryable": False,
            },
        )
        .returning(Execution.id)
    )
    cancelled_in_queue = result.scalar_one_or_none() is not None
    requested_event = None
    if not cancelled_in_queue:
        # Flag + trace event in one transaction, before the worker is notified (at commit).
        requested_event = await append_event(
            db,
            execution.id,
            execution.workspace_id,
            "execution.cancel_requested",
            {"by": ctx.actor.label},
            level="warning",
            extra_values={"cancel_requested_at": now, "cancel_requested_by_id": ctx.actor.user_id},
            only_if_status=ExecutionStatus.RUNNING,
        )
        if requested_event is not None:
            await notify_cancel(db, execution.id)
    await db.commit()
    await db.refresh(execution)
    if requested_event is not None:
        await publish_event(requested_event)
    if cancelled_in_queue:
        emitter = EventEmitter(execution.id, execution.workspace_id, execution.last_event_seq)
        await emitter.emit(
            "execution.cancelled", {"error": execution.error, "duration_ms": 0}, level="warning"
        )
        await publish_status(execution)
    return execution


async def retry(db: AsyncSession, ctx: WorkspaceContext, execution: Execution) -> Execution:
    if execution.status not in TERMINAL:
        raise Conflict("Only finished executions can be retried.", code="execution_not_finished")
    agent = await db.get(Agent, execution.agent_id) if execution.agent_id else None
    if agent is None:
        raise Conflict("The agent of this execution no longer exists.", code="agent_missing")
    text_input = execution.input.get("text")
    raw: str | dict[str, Any] = (
        text_input if isinstance(text_input, str) else dict(execution.input.get("json") or {})
    )
    new, _ = await launch(
        db,
        ctx,
        agent,
        raw,
        trigger=Trigger.RETRY,
        timeout_s=execution.timeout_s,
        parent_execution_id=execution.id,
        metadata={**(execution.metadata_ or {}), "retry_of": str(execution.id)},
    )
    return new


# ---------------------------------------------------------------- serialisation


def _cost_source(value: str) -> Literal["provider_reported", "estimated", "unavailable"]:
    if value == "provider_reported":
        return "provider_reported"
    if value == "estimated":
        return "estimated"
    return "unavailable"


def _input_preview(payload: dict[str, Any]) -> str:
    text = (
        payload.get("text")
        if isinstance(payload.get("text"), str)
        else json.dumps(payload.get("json", payload), ensure_ascii=False)
    )
    return (text or "")[:240]


async def _refs(
    db: AsyncSession, executions: list[Execution]
) -> tuple[dict[uuid.UUID, AgentRef], dict[uuid.UUID, str]]:
    agent_ids = {e.agent_id for e in executions if e.agent_id}
    version_ids = {e.agent_version_id for e in executions if e.agent_version_id}
    user_ids = {e.triggered_by_user_id for e in executions if e.triggered_by_user_id}
    agents = (
        {
            a.id: a
            for a in (await db.execute(select(Agent).where(Agent.id.in_(agent_ids)))).scalars()
        }
        if agent_ids
        else {}
    )
    versions = (
        {
            v.id: v.number
            for v in (
                await db.execute(select(AgentVersion).where(AgentVersion.id.in_(version_ids)))
            ).scalars()
        }
        if version_ids
        else {}
    )
    users = (
        {
            u.id: u.display_name
            for u in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars()
        }
        if user_ids
        else {}
    )
    refs: dict[uuid.UUID, AgentRef] = {}
    for e in executions:
        if e.agent_id and e.agent_id in agents:
            refs[e.id] = AgentRef(
                id=e.agent_id,
                name=agents[e.agent_id].name,
                version=versions.get(e.agent_version_id) if e.agent_version_id else None,
            )
    return refs, dict(users)


def _summary_fields(
    e: Execution, refs: dict[uuid.UUID, AgentRef], users: dict[uuid.UUID, str]
) -> dict[str, Any]:
    triggered_by = (
        users.get(e.triggered_by_user_id)
        if e.triggered_by_user_id
        else ("API key" if e.api_key_id else None)
    )
    return {
        "id": e.id,
        "workspace_id": e.workspace_id,
        "agent": refs.get(e.id),
        "status": e.status,
        "trigger": e.trigger,
        "triggered_by": triggered_by,
        "model": e.model,
        "provider_kind": e.provider_kind,
        "created_at": e.created_at,
        "started_at": e.started_at,
        "finished_at": e.finished_at,
        "duration_ms": e.duration_ms,
        "usage": UsageOut(
            input_tokens=e.input_tokens,
            output_tokens=e.output_tokens,
            cached_tokens=e.cached_tokens,
            reasoning_tokens=e.reasoning_tokens,
            total_tokens=e.input_tokens + e.output_tokens,
        ),
        "cost": CostOut(
            amount=e.cost_amount,
            currency=e.cost_currency,
            source=_cost_source(e.cost_source),
            partial=e.cost_partial,
        ),
        "error_code": (e.error or {}).get("code"),
        "input_preview": _input_preview(e.input),
    }


async def summaries(db: AsyncSession, executions: list[Execution]) -> list[ExecutionSummary]:
    refs, users = await _refs(db, executions)
    return [ExecutionSummary(**_summary_fields(e, refs, users)) for e in executions]


async def detail(db: AsyncSession, e: Execution) -> ExecutionOut:
    refs, users = await _refs(db, [e])
    error = ErrorOut(**{"details": {}, **e.error}) if e.error else None
    return ExecutionOut(
        **_summary_fields(e, refs, users),
        input=e.input,
        output=e.output,
        error=error,
        timeout_s=e.timeout_s,
        steps=e.steps,
        model_calls=e.model_calls,
        tool_calls=e.tool_calls,
        attempt=e.attempt,
        parent_execution_id=e.parent_execution_id,
        cancel_requested_at=e.cancel_requested_at,
        last_event_seq=e.last_event_seq,
        metadata=e.metadata_ or {},
    )


async def running_count(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Execution)
                .where(
                    Execution.workspace_id == workspace_id,
                    Execution.status == ExecutionStatus.RUNNING,
                )
            )
        ).scalar_one()
    )


__all__ = ["cancel", "detail", "launch", "publish", "retry", "summaries", "workspace_channel"]
