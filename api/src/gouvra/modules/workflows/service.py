"""Workflows: drafts edited with optimistic concurrency, immutable published versions, runs."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any

from jsonschema import Draft202012Validator
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core import ratelimit
from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.agents.service import readiness
from gouvra.modules.audit.service import record_for
from gouvra.modules.executions.models import Trigger
from gouvra.modules.executions.service import IDEMPOTENCY_WINDOW, normalise_input
from gouvra.modules.tools.models import Tool
from gouvra.modules.workflows.graph import (
    AgentNode,
    Graph,
    Issue,
    StartNode,
    ToolNode,
    analyse,
    starter_graph,
)
from gouvra.modules.workflows.models import (
    RunStatus,
    StepStatus,
    Workflow,
    WorkflowRun,
    WorkflowStep,
    WorkflowVersion,
)
from gouvra.modules.workflows.schemas import WorkflowCreateIn, WorkflowDraftIn, WorkflowRunCreateIn

WF_CHANNEL = "gouvra_workflows"


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


def dump_graph(graph: Graph) -> dict[str, Any]:
    return graph.model_dump(mode="json")


async def reference_issues(db: AsyncSession, workspace_id: uuid.UUID, graph: Graph) -> list[Issue]:
    """Agents and tools a graph points at must exist in the workspace and be able to run."""
    issues: list[Issue] = []
    agent_nodes = [n for n in graph.nodes if isinstance(n, AgentNode)]
    tool_nodes = [n for n in graph.nodes if isinstance(n, ToolNode)]
    agents = {
        a.id: a
        for a in (
            await db.execute(
                select(Agent).where(
                    Agent.id.in_([n.agent_id for n in agent_nodes]),
                    Agent.workspace_id == workspace_id,
                )
            )
        ).scalars()
    }
    for node in agent_nodes:
        agent = agents.get(node.agent_id)
        if agent is None:
            issues.append(Issue("unknown_agent", "This agent no longer exists.", node_id=node.id))
            continue
        if agent.archived_at is not None:
            issues.append(Issue("agent_archived", f"“{agent.name}” is archived.", node_id=node.id))
            continue
        version = await _agent_version(db, agent, node.version)
        if version is None:
            issues.append(
                Issue("unknown_version", f"Version {node.version} does not exist.", node_id=node.id)
            )
            continue
        check = await readiness(db, version)
        if not check.ready:
            issues.append(
                Issue("agent_not_ready", f"“{agent.name}” cannot run yet.", node_id=node.id)
            )
    tools = {
        t.id: t
        for t in (
            await db.execute(
                select(Tool).where(
                    Tool.id.in_([n.tool_id for n in tool_nodes]), Tool.workspace_id == workspace_id
                )
            )
        ).scalars()
    }
    for tool_node in tool_nodes:
        tool = tools.get(tool_node.tool_id)
        if tool is None or tool.archived_at is not None:
            issues.append(
                Issue("unknown_tool", "This tool no longer exists.", node_id=tool_node.id)
            )
        elif tool.status != "active":
            issues.append(
                Issue("tool_disabled", f"“{tool.display_name}” is disabled.", node_id=tool_node.id)
            )
    return issues


async def _agent_version(db: AsyncSession, agent: Agent, number: int | None) -> AgentVersion | None:
    if number is None:
        return (
            await db.get(AgentVersion, agent.current_version_id)
            if agent.current_version_id
            else None
        )
    return (
        await db.execute(
            select(AgentVersion).where(
                AgentVersion.agent_id == agent.id, AgentVersion.number == number
            )
        )
    ).scalar_one_or_none()


async def validate(db: AsyncSession, workspace_id: uuid.UUID, graph: Graph) -> list[Issue]:
    return analyse(graph).issues + await reference_issues(db, workspace_id, graph)


def _blocking(issues: list[Issue]) -> list[Issue]:
    return [i for i in issues if i.severity == "error"]


# ---------------------------------------------------------------- definitions


async def create_workflow(
    db: AsyncSession, ctx: WorkspaceContext, payload: WorkflowCreateIn
) -> Workflow:
    ctx.require(Permission.WORKFLOWS_WRITE)
    workflow = Workflow(
        workspace_id=ctx.workspace_id,
        name=payload.name,
        description=payload.description,
        draft_graph=dump_graph(payload.graph or starter_graph()),
        created_by_id=ctx.actor.user_id,
    )
    db.add(workflow)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A workflow with this name already exists.", "taken") from exc
    await record_for(
        db,
        ctx.actor,
        "workflow.created",
        workspace_id=ctx.workspace_id,
        target_type="workflow",
        target_id=workflow.id,
    )
    await db.commit()
    return workflow


async def rename(
    db: AsyncSession,
    ctx: WorkspaceContext,
    workflow: Workflow,
    name: str | None,
    description: str | None,
) -> Workflow:
    ctx.require(Permission.WORKFLOWS_WRITE)
    if name:
        workflow.name = name
    if description is not None:
        workflow.description = description
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A workflow with this name already exists.", "taken") from exc
    await db.commit()
    return workflow


async def save_draft(
    db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow, payload: WorkflowDraftIn
) -> Workflow:
    """Save the editor's draft — only on top of the revision the editor started from."""
    ctx.require(Permission.WORKFLOWS_WRITE)
    if workflow.archived_at is not None:
        raise Conflict("Restore the workflow before editing it.", code="workflow_archived")
    if payload.revision != workflow.draft_revision:
        raise Conflict(
            "Someone else saved this workflow meanwhile. Reload to see their changes.",
            code="draft_conflict",
            details={"revision": workflow.draft_revision},
        )
    workflow.draft_graph = dump_graph(payload.graph)
    workflow.draft_revision += 1
    workflow.updated_at = utcnow()
    await db.commit()
    return workflow


async def publish(
    db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow, note: str | None
) -> WorkflowVersion:
    ctx.require(Permission.WORKFLOWS_WRITE)
    current = (
        await db.get(WorkflowVersion, workflow.current_version_id)
        if workflow.current_version_id
        else None
    )
    if current is not None and current.graph == workflow.draft_graph:
        raise Conflict("The draft is identical to the current version.", code="nothing_to_publish")
    graph = Graph.model_validate(workflow.draft_graph)
    errors = _blocking(await validate(db, ctx.workspace_id, graph))
    if errors:
        raise Conflict(
            "Fix the problems shown in the editor before publishing.",
            code="workflow_invalid",
            details={"issues": [i.as_dict() for i in errors]},
        )
    number = workflow.latest_version_number + 1
    version = WorkflowVersion(
        workflow_id=workflow.id,
        workspace_id=ctx.workspace_id,
        number=number,
        graph=dump_graph(graph),
        note=note,
        created_by_id=ctx.actor.user_id,
    )
    db.add(version)
    await db.flush()
    workflow.current_version_id = version.id
    workflow.latest_version_number = number
    await record_for(
        db,
        ctx.actor,
        "workflow.published",
        workspace_id=ctx.workspace_id,
        target_type="workflow",
        target_id=workflow.id,
        data={"version": number},
    )
    await db.commit()
    return version


async def restore_version(
    db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow, number: int
) -> Workflow:
    ctx.require(Permission.WORKFLOWS_WRITE)
    version = (
        await db.execute(
            select(WorkflowVersion).where(
                WorkflowVersion.workflow_id == workflow.id, WorkflowVersion.number == number
            )
        )
    ).scalar_one_or_none()
    if version is None:
        raise _invalid("number", "This version does not exist.", "not_found")
    workflow.draft_graph = version.graph
    workflow.draft_revision += 1
    await db.commit()
    return workflow


async def set_archived(
    db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow, archived: bool
) -> Workflow:
    ctx.require(Permission.WORKFLOWS_WRITE)
    workflow.archived_at = utcnow() if archived else None
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict(
            "Another workflow now uses this name: rename one of them first.", code="name_taken"
        ) from exc
    await record_for(
        db,
        ctx.actor,
        "workflow.archived" if archived else "workflow.restored",
        workspace_id=ctx.workspace_id,
        target_type="workflow",
        target_id=workflow.id,
    )
    await db.commit()
    return workflow


async def run_count(db: AsyncSession, workflow_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(WorkflowRun)
                .where(WorkflowRun.workflow_id == workflow_id)
            )
        ).scalar_one()
    )


async def delete_workflow(db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow) -> None:
    ctx.require(Permission.WORKFLOWS_WRITE)
    if await run_count(db, workflow.id):
        raise Conflict(
            "This workflow has runs in its history. Archive it instead to keep them.",
            code="workflow_has_history",
        )
    workflow.current_version_id = None
    await db.flush()
    await record_for(
        db,
        ctx.actor,
        "workflow.deleted",
        workspace_id=ctx.workspace_id,
        target_type="workflow",
        target_id=workflow.id,
        data={"name": workflow.name},
    )
    await db.delete(workflow)
    await db.commit()


# ---------------------------------------------------------------- runs


def _request_hash(workflow_id: uuid.UUID, payload: WorkflowRunCreateIn) -> str:
    body = json.dumps(
        {"w": str(workflow_id), **payload.model_dump(mode="json")}, sort_keys=True, default=str
    )
    return hashlib.sha256(body.encode()).hexdigest()


async def _replay(
    db: AsyncSession, ctx: WorkspaceContext, key: str, digest: str
) -> WorkflowRun | None:
    existing = (
        await db.execute(
            select(WorkflowRun).where(
                WorkflowRun.workspace_id == ctx.workspace_id,
                WorkflowRun.idempotency_key == key,
                WorkflowRun.created_at > utcnow() - IDEMPOTENCY_WINDOW,
            )
        )
    ).scalar_one_or_none()
    if existing is not None and existing.request_hash != digest:
        raise ValidationFailed(
            "This Idempotency-Key was already used with a different request.",
            code="idempotency_mismatch",
        )
    return existing


async def _graph_to_run(
    db: AsyncSession, ctx: WorkspaceContext, workflow: Workflow, payload: WorkflowRunCreateIn
) -> tuple[WorkflowVersion | None, Graph]:
    """The draft (editors only), a given version, or the current one."""
    if payload.draft:
        ctx.require(Permission.WORKFLOWS_WRITE)
        return None, Graph.model_validate(workflow.draft_graph)
    version: WorkflowVersion | None = None
    if payload.version is not None:
        version = (
            await db.execute(
                select(WorkflowVersion).where(
                    WorkflowVersion.workflow_id == workflow.id,
                    WorkflowVersion.number == payload.version,
                )
            )
        ).scalar_one_or_none()
        if version is None:
            raise _invalid("version", "This version does not exist.", "not_found")
    elif workflow.current_version_id:
        version = await db.get(WorkflowVersion, workflow.current_version_id)
    if version is None:
        raise Conflict(
            "Publish the workflow first, or test the draft.", code="workflow_not_published"
        )
    return version, Graph.model_validate(version.graph)


def _checked_input(graph: Graph, raw: str | dict[str, Any]) -> dict[str, Any]:
    run_input = normalise_input(raw)
    if len(json.dumps(run_input)) > get_settings().max_execution_input_bytes:
        raise _invalid("input", "The input is too large.", "too_large")
    start = next(n for n in graph.nodes if isinstance(n, StartNode))
    if start.input_schema is not None:
        value = run_input["json"] if "json" in run_input else run_input.get("text")
        problems = list(Draft202012Validator(start.input_schema).iter_errors(value))
        if problems:
            raise _invalid("input", f"The input does not match the workflow: {problems[0].message}")
    return run_input


async def start_run(
    db: AsyncSession,
    ctx: WorkspaceContext,
    workflow: Workflow,
    payload: WorkflowRunCreateIn,
    *,
    trigger: Trigger = Trigger.MANUAL,
    source_id: str | None = None,
    idempotency_key: str | None = None,
) -> tuple[WorkflowRun, bool]:
    """Start a run. Returns (run, created) — created=False on an idempotent replay."""
    ctx.require(Permission.EXECUTIONS_LAUNCH)
    digest = _request_hash(workflow.id, payload)
    if idempotency_key:
        existing = await _replay(db, ctx, idempotency_key, digest)
        if existing is not None:
            return existing, False
    if workflow.archived_at is not None:
        raise Conflict("Restore the workflow before running it.", code="workflow_archived")
    version, graph = await _graph_to_run(db, ctx, workflow, payload)
    errors = _blocking(await validate(db, ctx.workspace_id, graph))
    if errors:
        raise Conflict(
            "This workflow cannot run until its problems are fixed.",
            code="workflow_invalid",
            details={"issues": [i.as_dict() for i in errors]},
        )
    run_input = _checked_input(graph, payload.input)
    await ratelimit.hit(ratelimit.EXECUTIONS_PER_WORKSPACE, str(ctx.workspace_id))
    from gouvra.modules.usage.guard import check_launch_allowed

    await check_launch_allowed(db, ctx.workspace_id)
    now = utcnow()
    timeout = graph.settings.timeout_s  # bounded by the graph schema (10 s to 1 h)
    analysis = analyse(graph)
    run = WorkflowRun(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        workflow_id=workflow.id,
        workflow_version_id=version.id if version else None,
        version_number=version.number if version else None,
        workflow_name=workflow.name,
        graph=dump_graph(graph),
        trigger=trigger,
        triggered_by_user_id=ctx.actor.user_id,
        api_key_id=ctx.actor.api_key_id,
        source_id=source_id,
        status=RunStatus.RUNNING,
        input=run_input,
        timeout_s=timeout,
        started_at=now,
        deadline_at=now + timedelta(seconds=timeout),
        needs_advance=True,
        wake_at=now,
        idempotency_key=idempotency_key,
        request_hash=digest,
        steps_total=len(analysis.order),
    )
    db.add(run)
    try:
        await db.flush()
    except IntegrityError as exc:  # the same key, sent twice at the same moment
        await db.rollback()
        raise Conflict(
            "A run with this Idempotency-Key is already being created.",
            code="idempotency_conflict",
        ) from exc
    for position, node_id in enumerate(analysis.order):
        node = analysis.nodes[node_id]
        db.add(
            WorkflowStep(
                run_id=run.id,
                workspace_id=ctx.workspace_id,
                node_id=node_id,
                node_type=node.type,
                label=node.label,
                position=position,
                status=StepStatus.PENDING,
            )
        )
    workflow.last_run_at = now
    await record_for(
        db,
        ctx.actor,
        "workflow.run_started",
        workspace_id=ctx.workspace_id,
        target_type="workflow_run",
        target_id=run.id,
        data={"workflow": workflow.name, "version": run.version_number, "draft": payload.draft},
    )
    await db.execute(text("SELECT pg_notify(:c, :p)"), {"c": WF_CHANNEL, "p": str(run.id)})
    await db.commit()
    return run, True


async def cancel_run(db: AsyncSession, ctx: WorkspaceContext, run: WorkflowRun) -> WorkflowRun:
    ctx.require(Permission.EXECUTIONS_CANCEL)
    if run.status != RunStatus.RUNNING:
        raise Conflict("This run has already finished.", code="run_finished")
    if run.cancel_requested_at is None:
        run.cancel_requested_at = utcnow()
        run.cancel_requested_by_id = ctx.actor.user_id
    run.needs_advance = True
    await db.execute(text("SELECT pg_notify(:c, :p)"), {"c": WF_CHANNEL, "p": str(run.id)})
    await db.commit()
    return run
