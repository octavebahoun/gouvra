"""Exports: the workspace's configuration as JSON, its runs and usage as CSV.

Never a secret: provider keys, tool credentials, connection credentials and webhook secrets
stay out. CSV cells that a spreadsheet would read as formulas are neutralised.
"""

from __future__ import annotations

import csv
import io
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Any

import orjson
from fastapi import APIRouter, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from gouvra.core.authz import DbSession, Permission, WorkspaceContext, workspace_access
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.audit.service import record_for

router = APIRouter(tags=["exports"])

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
BATCH = 1000


def cell(value: Any) -> str:
    """A CSV cell that cannot run as a spreadsheet formula (CSV injection)."""
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(FORMULA_PREFIXES) else text


def _range(since: date | None, until: date | None) -> tuple[datetime, datetime]:
    end = datetime.combine(until, time.max, tzinfo=UTC) if until else utcnow()
    start = datetime.combine(since, time.min, tzinfo=UTC) if since else end - timedelta(days=30)
    return start, end


def _filename(ctx: WorkspaceContext, kind: str, extension: str) -> str:
    return f"gouvra-{ctx.workspace.slug}-{kind}-{utcnow():%Y%m%d}.{extension}"


async def _audit(db: DbSession, ctx: WorkspaceContext, kind: str, data: dict[str, Any]) -> None:
    await record_for(
        db,
        ctx.actor,
        "export.created",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
        data={"kind": kind, **data},
    )
    await db.commit()


@router.get(
    "/workspaces/{workspace_id}/exports/configuration",
    summary="Agents, tools, workflows, evaluations and automations as JSON (no secret)",
    responses={200: {"content": {"application/json": {}}}},
)
async def export_configuration(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EXPORTS_CREATE)],
) -> Response:
    from gouvra.modules.agents.models import Agent, AgentVersion
    from gouvra.modules.automations.models import Automation
    from gouvra.modules.evaluations.models import EvalCase, EvalSuite
    from gouvra.modules.providers.models import ProviderConfig
    from gouvra.modules.tools.models import Tool
    from gouvra.modules.workflows.models import Workflow, WorkflowVersion

    ws = ctx.workspace_id
    tools = list(
        (
            await db.execute(
                select(Tool).where(Tool.workspace_id == ws, Tool.archived_at.is_(None))
            )
        ).scalars()
    )
    tool_names = {str(t.id): t.name for t in tools}
    providers = {
        p.id: p.name
        for p in (
            await db.execute(select(ProviderConfig).where(ProviderConfig.workspace_id == ws))
        ).scalars()
    }
    agents = []
    for agent in (
        await db.execute(
            select(Agent)
            .where(Agent.workspace_id == ws, Agent.archived_at.is_(None))
            .order_by(Agent.name)
        )
    ).scalars():
        version = (
            await db.get(AgentVersion, agent.current_version_id)
            if agent.current_version_id
            else None
        )
        agents.append(
            {
                "name": agent.name,
                "description": agent.description,
                "version": version.number if version else None,
                "provider": providers.get(version.provider_config_id)
                if version and version.provider_config_id
                else None,
                "model": version.model if version else None,
                "instructions": version.instructions if version else None,
                "parameters": version.parameters if version else None,
                "limits": version.limits if version else None,
                "tools": [
                    tool_names.get(str(i), str(i)) for i in (version.tool_ids if version else [])
                ],
            }
        )
    workflows = []
    for workflow in (
        await db.execute(
            select(Workflow)
            .where(Workflow.workspace_id == ws, Workflow.archived_at.is_(None))
            .order_by(Workflow.name)
        )
    ).scalars():
        published = (
            await db.get(WorkflowVersion, workflow.current_version_id)
            if workflow.current_version_id
            else None
        )
        workflows.append(
            {
                "name": workflow.name,
                "description": workflow.description,
                "published_version": published.number if published else None,
                "published_graph": published.graph if published else None,
                "draft_graph": workflow.draft_graph,
            }
        )
    suites = []
    for suite in (
        await db.execute(
            select(EvalSuite)
            .where(EvalSuite.workspace_id == ws, EvalSuite.archived_at.is_(None))
            .order_by(EvalSuite.name)
        )
    ).scalars():
        cases = (
            await db.execute(
                select(EvalCase).where(EvalCase.suite_id == suite.id).order_by(EvalCase.created_at)
            )
        ).scalars()
        suites.append(
            {
                "name": suite.name,
                "description": suite.description,
                "default_graders": suite.default_graders,
                "pass_threshold": suite.pass_threshold,
                "cases": [
                    {
                        "name": c.name,
                        "input": c.input,
                        "expected": c.expected,
                        "graders": c.graders,
                        "tags": c.tags,
                    }
                    for c in cases
                ],
            }
        )
    automations = [
        {
            "name": a.name,
            "kind": a.kind,
            "target_type": a.target_type,
            "cron": a.cron,
            "timezone": a.timezone,
            "input": a.input,
            "input_template": a.input_template,
            "signature_format": a.signature_format if a.kind == "webhook" else None,
            "enabled": a.enabled,
        }
        for a in (
            await db.execute(
                select(Automation).where(Automation.workspace_id == ws).order_by(Automation.name)
            )
        ).scalars()
    ]
    document = {
        "format": "gouvra.export/v1",
        "exported_at": utcnow().isoformat(),
        "workspace": {"name": ctx.workspace.name},
        "agents": agents,
        "tools": [
            {
                "name": t.name,
                "display_name": t.display_name,
                "description": t.description,
                "kind": t.kind,
                "builtin_key": t.builtin_key,
                "input_schema": t.input_schema,
                # HTTP and code tools keep their settings; credentials are never exported.
                "config": t.config if t.kind in ("http", "code", "builtin") else {},
                "timeout_ms": t.timeout_ms,
            }
            for t in tools
        ],
        "workflows": workflows,
        "evaluation_suites": suites,
        "automations": automations,
    }
    await _audit(db, ctx, "configuration", {})
    filename = _filename(ctx, "configuration", "json")
    return Response(
        content=orjson.dumps(document, option=orjson.OPT_INDENT_2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _csv_stream(header: list[str], rows: AsyncIterator[list[Any]]) -> AsyncIterator[bytes]:
    async def generate() -> AsyncIterator[bytes]:
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        yield buffer.getvalue().encode()
        async for row in rows:
            buffer.seek(0)
            buffer.truncate(0)
            writer.writerow([cell(value) for value in row])
            yield buffer.getvalue().encode()

    return generate()


@router.get(
    "/workspaces/{workspace_id}/exports/executions.csv",
    summary="Executions as CSV (default: the last 30 days)",
    responses={200: {"content": {"text/csv": {}}}},
)
async def export_executions(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EXPORTS_CREATE)],
    since: Annotated[date | None, Query()] = None,
    until: Annotated[date | None, Query()] = None,
) -> StreamingResponse:
    from gouvra.modules.agents.models import Agent, AgentVersion
    from gouvra.modules.executions.models import Execution

    start, end = _range(since, until)
    await _audit(db, ctx, "executions", {"since": start.isoformat(), "until": end.isoformat()})
    workspace_id = ctx.workspace_id

    async def rows() -> AsyncIterator[list[Any]]:
        async with get_sessionmaker()() as session:
            cursor: tuple[datetime, Any] | None = None
            while True:
                query = (
                    select(Execution, Agent.name, AgentVersion.number)
                    .outerjoin(Agent, Agent.id == Execution.agent_id)
                    .outerjoin(AgentVersion, AgentVersion.id == Execution.agent_version_id)
                    .where(
                        Execution.workspace_id == workspace_id,
                        Execution.created_at >= start,
                        Execution.created_at <= end,
                    )
                    .order_by(Execution.created_at, Execution.id)
                    .limit(BATCH)
                )
                if cursor is not None:
                    query = query.where(
                        (Execution.created_at > cursor[0])
                        | ((Execution.created_at == cursor[0]) & (Execution.id > cursor[1]))
                    )
                batch = (await session.execute(query)).all()
                if not batch:
                    return
                for execution, agent_name, version in batch:
                    yield [
                        execution.id,
                        execution.created_at.isoformat(),
                        agent_name,
                        version,
                        execution.trigger,
                        execution.status,
                        execution.duration_ms,
                        execution.input_tokens,
                        execution.output_tokens,
                        execution.cost_amount,
                        execution.cost_currency,
                        execution.cost_source,
                        (execution.error or {}).get("code"),
                    ]
                last = batch[-1][0]
                cursor = (last.created_at, last.id)

    header = [
        "id",
        "created_at",
        "agent",
        "agent_version",
        "trigger",
        "status",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "cost_amount",
        "cost_currency",
        "cost_source",
        "error_code",
    ]
    return StreamingResponse(
        _csv_stream(header, rows()),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(ctx, "executions", "csv")}"'
        },
    )


@router.get(
    "/workspaces/{workspace_id}/exports/usage.csv",
    summary="Usage per day, agent and model as CSV (default: the last 30 days)",
    responses={200: {"content": {"text/csv": {}}}},
)
async def export_usage(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EXPORTS_CREATE)],
    since: Annotated[date | None, Query()] = None,
    until: Annotated[date | None, Query()] = None,
) -> StreamingResponse:
    from gouvra.modules.agents.models import Agent
    from gouvra.modules.executions.models import UsageRecord

    start, end = _range(since, until)
    day = func.date_trunc("day", UsageRecord.recorded_at).label("day")
    result = (
        await db.execute(
            select(
                day,
                Agent.name,
                UsageRecord.provider_kind,
                UsageRecord.model,
                func.count(),
                func.sum(UsageRecord.input_tokens),
                func.sum(UsageRecord.output_tokens),
                func.sum(UsageRecord.cost_amount),
            )
            .outerjoin(Agent, Agent.id == UsageRecord.agent_id)
            .where(
                UsageRecord.workspace_id == ctx.workspace_id,
                UsageRecord.recorded_at >= start,
                UsageRecord.recorded_at <= end,
            )
            .group_by(day, Agent.name, UsageRecord.provider_kind, UsageRecord.model)
            .order_by(day, Agent.name, UsageRecord.model)
        )
    ).all()
    await _audit(db, ctx, "usage", {"since": start.isoformat(), "until": end.isoformat()})

    async def rows() -> AsyncIterator[list[Any]]:
        for when, agent, provider, model, calls, tokens_in, tokens_out, cost in result:
            yield [
                when.date().isoformat(),
                agent,
                provider,
                model,
                calls,
                tokens_in,
                tokens_out,
                cost,
            ]

    header = [
        "date",
        "agent",
        "provider",
        "model",
        "model_calls",
        "input_tokens",
        "output_tokens",
        "cost_usd",
    ]
    return StreamingResponse(
        _csv_stream(header, rows()),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{_filename(ctx, "usage", "csv")}"'},
    )
