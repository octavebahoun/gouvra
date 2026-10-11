"""Workflow routes: definitions, drafts, versions, runs and their live stream (SSE)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Annotated, Any

import orjson
from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    EmailNotVerified,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.db import get_sessionmaker
from gouvra.core.errors import Unauthorized
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.core.redis import get_redis
from gouvra.modules.executions.service import _input_preview
from gouvra.modules.identity.models import User
from gouvra.modules.workflows import orchestrator, service
from gouvra.modules.workflows.graph import Graph
from gouvra.modules.workflows.models import (
    RUN_TERMINAL,
    Workflow,
    WorkflowRun,
    WorkflowStep,
    WorkflowVersion,
)
from gouvra.modules.workflows.schemas import (
    WorkflowCreateIn,
    WorkflowDraftIn,
    WorkflowIssueOut,
    WorkflowOut,
    WorkflowPublishIn,
    WorkflowRunCreateIn,
    WorkflowRunOut,
    WorkflowRunRef,
    WorkflowRunSummaryOut,
    WorkflowStepOut,
    WorkflowSummary,
    WorkflowUpdateIn,
    WorkflowVersionOut,
)

router = APIRouter(tags=["workflows"])

KEEPALIVE_S = 15
POLL_S = 5  # safety net: re-read the run if a live message was lost


async def _names(db: DbSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    wanted = [i for i in ids if i is not None]
    if not wanted:
        return {}
    rows = await db.execute(select(User.id, User.display_name).where(User.id.in_(wanted)))
    return {row[0]: row[1] for row in rows}


async def summary_out(db: DbSession, workflow: Workflow) -> WorkflowSummary:
    current = (
        await db.get(WorkflowVersion, workflow.current_version_id)
        if workflow.current_version_id
        else None
    )
    last = (
        await db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.workflow_id == workflow.id)
            .order_by(WorkflowRun.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    nodes = workflow.draft_graph.get("nodes", [])
    return WorkflowSummary(
        id=workflow.id,
        workspace_id=workflow.workspace_id,
        name=workflow.name,
        description=workflow.description,
        current_version=current.number if current else None,
        has_unpublished_changes=current is None or current.graph != workflow.draft_graph,
        node_count=len(nodes),
        agent_count=sum(1 for n in nodes if n.get("type") == "agent"),
        last_run=WorkflowRunRef(id=last.id, status=last.status, created_at=last.created_at)
        if last
        else None,
        archived=workflow.archived_at is not None,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


async def workflow_out(db: DbSession, workflow: Workflow) -> WorkflowOut:
    summary = await summary_out(db, workflow)
    graph = Graph.model_validate(workflow.draft_graph)
    issues = await service.validate(db, workflow.workspace_id, graph)
    blocking = any(i.severity == "error" for i in issues)
    return WorkflowOut(
        **summary.model_dump(),
        draft=workflow.draft_graph,
        draft_revision=workflow.draft_revision,
        issues=[WorkflowIssueOut(**i.as_dict()) for i in issues],
        can_publish=not blocking and summary.has_unpublished_changes,
    )


def _summary_fields(run: WorkflowRun, names: dict[uuid.UUID, str]) -> dict[str, Any]:
    return {
        "id": run.id,
        "workspace_id": run.workspace_id,
        "workflow_id": run.workflow_id,
        "workflow_name": run.workflow_name,
        "version": run.version_number,
        "trigger": run.trigger,
        "status": run.status,
        "input_preview": _input_preview(run.input),
        "error": run.error,
        "steps_total": run.steps_total,
        "steps_done": run.steps_done,
        "duration_ms": run.duration_ms,
        "cost_amount": run.cost_amount,
        "cost_source": run.cost_source,
        "cost_partial": run.cost_partial,
        "created_by": names.get(run.triggered_by_user_id) if run.triggered_by_user_id else None,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
    }


async def run_out(db: DbSession, run: WorkflowRun) -> WorkflowRunOut:
    steps = (
        await db.execute(
            select(WorkflowStep)
            .where(WorkflowStep.run_id == run.id)
            .order_by(WorkflowStep.position)
        )
    ).scalars()
    names = await _names(db, {run.triggered_by_user_id})
    return WorkflowRunOut(
        **_summary_fields(run, names),
        input=run.input,
        output=run.output,
        graph=run.graph,
        timeout_s=run.timeout_s,
        deadline_at=run.deadline_at,
        input_tokens=run.input_tokens,
        output_tokens=run.output_tokens,
        cancel_requested_at=run.cancel_requested_at,
        steps=[WorkflowStepOut.model_validate(s, from_attributes=True) for s in steps],
    )


# ---------------------------------------------------------------- definitions


@router.get("/workspaces/{workspace_id}/workflows", summary="List workflows")
async def list_workflows(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.WORKFLOWS_READ)],
    include_archived: Annotated[bool, Query()] = False,
    agent_id: Annotated[uuid.UUID | None, Query(description="Only workflows using it")] = None,
) -> list[WorkflowSummary]:
    query = (
        select(Workflow)
        .where(Workflow.workspace_id == ctx.workspace_id)
        .order_by(Workflow.updated_at.desc())
    )
    if not include_archived:
        query = query.where(Workflow.archived_at.is_(None))
    workflows = list((await db.execute(query)).scalars())
    if agent_id is not None:
        workflows = [
            w
            for w in workflows
            if any(
                n.get("type") == "agent" and n.get("agent_id") == str(agent_id)
                for n in w.draft_graph.get("nodes", [])
            )
        ]
    return [await summary_out(db, w) for w in workflows]


@router.post(
    "/workspaces/{workspace_id}/workflows",
    status_code=status.HTTP_201_CREATED,
    summary="Create a workflow",
)
async def create_workflow(
    payload: WorkflowCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.WORKFLOWS_WRITE)],
) -> WorkflowOut:
    return await workflow_out(db, await service.create_workflow(db, ctx, payload))


@router.get("/workflows/{workflow_id}", summary="Get a workflow with its draft and its problems")
async def get_workflow(workflow_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> WorkflowOut:
    workflow, _ = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_READ
    )
    return await workflow_out(db, workflow)


@router.patch("/workflows/{workflow_id}", summary="Rename a workflow or change its description")
async def update_workflow(
    workflow_id: uuid.UUID, payload: WorkflowUpdateIn, actor: CurrentActor, db: DbSession
) -> WorkflowOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE
    )
    updated = await service.rename(db, ctx, workflow, payload.name, payload.description)
    return await workflow_out(db, updated)


@router.put(
    "/workflows/{workflow_id}/draft",
    summary="Save the draft (409 if someone else saved since the given revision)",
)
async def save_draft(
    workflow_id: uuid.UUID, payload: WorkflowDraftIn, actor: CurrentActor, db: DbSession
) -> WorkflowOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE, for_update=True
    )
    return await workflow_out(db, await service.save_draft(db, ctx, workflow, payload))


@router.post(
    "/workflows/{workflow_id}/publish",
    status_code=status.HTTP_201_CREATED,
    summary="Publish the draft as a new version",
)
async def publish(
    workflow_id: uuid.UUID, payload: WorkflowPublishIn, actor: CurrentActor, db: DbSession
) -> WorkflowVersionOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE, for_update=True
    )
    version = await service.publish(db, ctx, workflow, payload.note)
    names = await _names(db, {version.created_by_id})
    return WorkflowVersionOut(
        number=version.number,
        note=version.note,
        graph=version.graph,
        created_by=names.get(version.created_by_id) if version.created_by_id else None,
        created_at=version.created_at,
        is_current=True,
    )


@router.get("/workflows/{workflow_id}/versions", summary="Published versions, newest first")
async def list_versions(
    workflow_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> list[WorkflowVersionOut]:
    workflow, _ = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_READ
    )
    versions = list(
        (
            await db.execute(
                select(WorkflowVersion)
                .where(WorkflowVersion.workflow_id == workflow.id)
                .order_by(WorkflowVersion.number.desc())
            )
        ).scalars()
    )
    names = await _names(db, {v.created_by_id for v in versions})
    return [
        WorkflowVersionOut(
            number=v.number,
            note=v.note,
            graph=v.graph,
            created_by=names.get(v.created_by_id) if v.created_by_id else None,
            created_at=v.created_at,
            is_current=v.id == workflow.current_version_id,
        )
        for v in versions
    ]


@router.post(
    "/workflows/{workflow_id}/versions/{number}/restore",
    summary="Load a published version into the draft",
)
async def restore_version(
    workflow_id: uuid.UUID, number: int, actor: CurrentActor, db: DbSession
) -> WorkflowOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE, for_update=True
    )
    return await workflow_out(db, await service.restore_version(db, ctx, workflow, number))


@router.post("/workflows/{workflow_id}/archive", summary="Archive a workflow")
async def archive_workflow(
    workflow_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> WorkflowOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE
    )
    return await workflow_out(db, await service.set_archived(db, ctx, workflow, archived=True))


@router.post("/workflows/{workflow_id}/restore", summary="Restore an archived workflow")
async def unarchive_workflow(
    workflow_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> WorkflowOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE
    )
    return await workflow_out(db, await service.set_archived(db, ctx, workflow, archived=False))


@router.delete(
    "/workflows/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a workflow that has never run",
)
async def delete_workflow(workflow_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.WORKFLOWS_WRITE
    )
    await service.delete_workflow(db, ctx, workflow)


# ---------------------------------------------------------------- runs


@router.post(
    "/workflows/{workflow_id}/runs",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Run a workflow (its current version, a given version, or the draft)",
    responses={200: {"description": "Idempotent replay: the run created with this key"}},
)
async def start_run(
    workflow_id: uuid.UUID,
    payload: WorkflowRunCreateIn,
    actor: CurrentActor,
    db: DbSession,
    response: Response,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> WorkflowRunOut:
    workflow, ctx = await load_in_workspace(
        db, Workflow, workflow_id, actor, Permission.EXECUTIONS_LAUNCH
    )
    run, created = await service.start_run(
        db, ctx, workflow, payload, idempotency_key=idempotency_key
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    return await run_out(db, run)


@router.get("/workspaces/{workspace_id}/workflow-runs", summary="List workflow runs")
async def list_runs(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.WORKFLOWS_READ)],
    params: Annotated[PageParams, Depends(page_params)],
    workflow_id: uuid.UUID | None = None,
    run_status: Annotated[str | None, Query(alias="status")] = None,
) -> Page[WorkflowRunSummaryOut]:
    query = select(WorkflowRun).where(WorkflowRun.workspace_id == ctx.workspace_id)
    if workflow_id:
        query = query.where(WorkflowRun.workflow_id == workflow_id)
    if run_status:
        query = query.where(WorkflowRun.status == run_status)
    rows = list(
        (
            await db.execute(paginate_desc(query, params, WorkflowRun.created_at, WorkflowRun.id))
        ).scalars()
    )
    names = await _names(db, {r.triggered_by_user_id for r in rows})
    return build_page(
        rows,
        params,
        lambda r: WorkflowRunSummaryOut(**_summary_fields(r, names)),
        lambda r: (r.created_at, r.id),
    )


@router.get("/workflow-runs/{run_id}", summary="A run with its steps")
async def get_run(run_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> WorkflowRunOut:
    run, _ = await load_in_workspace(db, WorkflowRun, run_id, actor, Permission.WORKFLOWS_READ)
    return await run_out(db, run)


@router.post("/workflow-runs/{run_id}/cancel", summary="Cancel a running workflow")
async def cancel_run(run_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> WorkflowRunOut:
    run, ctx = await load_in_workspace(
        db, WorkflowRun, run_id, actor, Permission.EXECUTIONS_CANCEL, for_update=True
    )
    return await run_out(db, await service.cancel_run(db, ctx, run))


# ---------------------------------------------------------------- live stream (SSE)


def _sse(event: str, data: object) -> bytes:
    return f"event: {event}\ndata: {orjson.dumps(data, default=str).decode()}\n\n".encode()


async def _snapshot(run_id: uuid.UUID) -> dict[str, Any] | None:
    async with get_sessionmaker()() as db:
        run = await db.get(WorkflowRun, run_id)
        if run is None:
            return None
        steps = list(
            (
                await db.execute(
                    select(WorkflowStep)
                    .where(WorkflowStep.run_id == run.id)
                    .order_by(WorkflowStep.position)
                )
            ).scalars()
        )
        return orchestrator.snapshot(run, steps)


@router.get(
    "/workflow-runs/{run_id}/stream",
    summary="Live run feed (Server-Sent Events)",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {"text/event-stream": {}},
            "description": "`snapshot` messages with the run and all its steps, then `end`",
        }
    },
)
async def stream_run(run_id: uuid.UUID, request: Request) -> StreamingResponse:
    from gouvra.modules.identity.auth import authenticate_request

    # Authenticate with a short-lived session: a stream must not pin a pool connection.
    async with get_sessionmaker()() as db:
        actor = await authenticate_request(request, db)
        if actor is None:
            raise Unauthorized()
        if actor.user is not None and not actor.user.email_verified:
            raise EmailNotVerified()
        await load_in_workspace(db, WorkflowRun, run_id, actor, Permission.WORKFLOWS_READ)

    async def generate() -> AsyncIterator[bytes]:
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(orchestrator.run_channel(run_id))
        try:
            # Subscribe first, then read: a change published in between is not missed.
            state = await _snapshot(run_id)
            if state is None:
                return
            sent = _sse("snapshot", state)
            yield sent
            if state["run"]["status"] in RUN_TERMINAL:
                yield _sse("end", {"status": state["run"]["status"]})
                return
            loop = asyncio.get_running_loop()
            last_poll = last_ping = loop.time()
            while not await request.is_disconnected():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                now = loop.time()
                state = None
                if message and message.get("type") == "message":
                    state = orjson.loads(message["data"])
                    last_poll = now
                elif now - last_poll >= POLL_S:
                    last_poll = now
                    state = await _snapshot(run_id)
                    if state is None:
                        return
                if state is not None:
                    frame = _sse("snapshot", state)
                    if frame != sent:  # the safety-net poll only sends real changes
                        sent = frame
                        yield frame
                    if state["run"]["status"] in RUN_TERMINAL:
                        yield _sse("end", {"status": state["run"]["status"]})
                        return
                if now - last_ping >= KEEPALIVE_S:
                    last_ping = now
                    yield b": keep-alive\n\n"
        finally:
            await pubsub.unsubscribe()
            await pubsub.aclose()  # type: ignore[no-untyped-call]

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
