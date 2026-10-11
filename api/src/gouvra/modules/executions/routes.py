"""Execution routes: launch, list, detail, events, live stream (SSE), cancel, retry."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated, Literal

import orjson
from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, select

from gouvra.core.authz import (
    Actor,
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
from gouvra.modules.agents.models import Agent
from gouvra.modules.executions import service
from gouvra.modules.executions.events import execution_channel, workspace_channel
from gouvra.modules.executions.models import TERMINAL, Execution, ExecutionEvent, Trigger
from gouvra.modules.executions.schemas import (
    EventPage,
    ExecutionEventOut,
    ExecutionLaunchIn,
    ExecutionOut,
    ExecutionSummary,
)

router = APIRouter(tags=["executions"])
KEEPALIVE_S = 15
POLL_S = 5
TERMINAL_EVENTS = frozenset(
    {"execution.succeeded", "execution.failed", "execution.cancelled", "execution.timed_out"}
)


@router.post(
    "/agents/{agent_id}/executions",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Launch an execution (asynchronous)",
    responses={
        200: {"description": "Idempotent replay: the execution created by the first request"}
    },
)
async def launch_execution(
    agent_id: uuid.UUID,
    payload: ExecutionLaunchIn,
    response: Response,
    actor: CurrentActor,
    db: DbSession,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> ExecutionOut:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.EXECUTIONS_LAUNCH)
    execution, created = await service.launch(
        db,
        ctx,
        agent,
        payload.input,
        trigger=Trigger.API if actor.is_service_key else Trigger.MANUAL,
        timeout_s=payload.timeout_s,
        idempotency_key=idempotency_key,
        metadata=dict(payload.metadata),
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    response.headers["Location"] = f"/api/v1/executions/{execution.id}"
    return await service.detail(db, execution)


@router.get("/workspaces/{workspace_id}/executions", summary="List executions (newest first)")
async def list_executions(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EXECUTIONS_READ)],
    params: Annotated[PageParams, Depends(page_params)],
    status_: Annotated[
        list[Literal["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]] | None,
        Query(alias="status"),
    ] = None,
    agent_id: uuid.UUID | None = None,
    trigger: Annotated[list[str] | None, Query()] = None,
    q: Annotated[
        str | None, Query(max_length=200, description="Search the ID, input or error code")
    ] = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> Page[ExecutionSummary]:
    query = select(Execution).where(Execution.workspace_id == ctx.workspace_id)
    if status_:
        query = query.where(Execution.status.in_(status_))
    if agent_id:
        query = query.where(Execution.agent_id == agent_id)
    if trigger:
        query = query.where(Execution.trigger.in_(trigger))
    if since:
        query = query.where(Execution.created_at >= since)
    if until:
        query = query.where(Execution.created_at < until)
    if q:
        term = q.strip()
        conditions = [
            Execution.input["text"].astext.ilike(f"%{term}%"),
            Execution.error["code"].astext == term,
        ]
        with contextlib.suppress(ValueError):
            conditions.append(Execution.id == uuid.UUID(term))
        query = query.where(or_(*conditions))
    rows = list(
        (
            await db.execute(paginate_desc(query, params, Execution.created_at, Execution.id))
        ).scalars()
    )
    page_items = rows[: params.limit]
    converted = {s.id: s for s in await service.summaries(db, page_items)}
    return build_page(rows, params, lambda e: converted[e.id], lambda e: (e.created_at, e.id))


@router.get("/executions/{execution_id}", summary="Execution state, input, output, usage and error")
async def get_execution(
    execution_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> ExecutionOut:
    execution, _ = await load_in_workspace(
        db, Execution, execution_id, actor, Permission.EXECUTIONS_READ
    )
    return await service.detail(db, execution)


@router.get(
    "/executions/{execution_id}/events", summary="Execution events in order (filtered, redacted)"
)
async def get_events(
    execution_id: uuid.UUID,
    actor: CurrentActor,
    db: DbSession,
    after: Annotated[int, Query(ge=0, description="Return events with seq > after")] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    type_: Annotated[list[str] | None, Query(alias="type")] = None,
) -> EventPage:
    await load_in_workspace(db, Execution, execution_id, actor, Permission.EXECUTIONS_READ)
    query = select(ExecutionEvent).where(
        ExecutionEvent.execution_id == execution_id, ExecutionEvent.seq > after
    )
    if type_:
        query = query.where(ExecutionEvent.type.in_(type_))
    rows = list((await db.execute(query.order_by(ExecutionEvent.seq).limit(limit + 1))).scalars())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return EventPage(
        data=[ExecutionEventOut.model_validate(r, from_attributes=True) for r in rows],
        next_after=rows[-1].seq if has_more and rows else None,
        has_more=has_more,
    )


@router.post("/executions/{execution_id}/cancel", summary="Cancel a queued or running execution")
async def cancel_execution(
    execution_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> ExecutionOut:
    execution, ctx = await load_in_workspace(
        db, Execution, execution_id, actor, Permission.EXECUTIONS_CANCEL
    )
    execution = await service.cancel(db, ctx, execution)
    return await service.detail(db, execution)


@router.post(
    "/executions/{execution_id}/retry",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Run again with the same input",
)
async def retry_execution(
    execution_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> ExecutionOut:
    execution, ctx = await load_in_workspace(
        db, Execution, execution_id, actor, Permission.EXECUTIONS_LAUNCH
    )
    new = await service.retry(db, ctx, execution)
    return await service.detail(db, new)


# ---------------------------------------------------------------- live streams (SSE)


def _sse(event: str, data: object, event_id: int | None = None) -> bytes:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {orjson.dumps(data, default=str).decode()}\n\n".encode()


async def _authorise_stream(
    request: Request, resource_id: uuid.UUID, permission: Permission
) -> tuple[Execution, Actor]:
    """Authenticate with a short-lived DB session (streams must not pin a pool connection)."""
    from gouvra.modules.identity.auth import authenticate_request

    async with get_sessionmaker()() as db:
        actor = await authenticate_request(request, db)
        if actor is None:
            raise Unauthorized()
        if actor.user is not None and not actor.user.email_verified:
            raise EmailNotVerified()
        resource, _ = await load_in_workspace(db, Execution, resource_id, actor, permission)
        return resource, actor


async def _events_after(execution_id: uuid.UUID, after: int) -> list[ExecutionEvent]:
    async with get_sessionmaker()() as db:
        return list(
            (
                await db.execute(
                    select(ExecutionEvent)
                    .where(ExecutionEvent.execution_id == execution_id, ExecutionEvent.seq > after)
                    .order_by(ExecutionEvent.seq)
                )
            ).scalars()
        )


@router.get(
    "/executions/{execution_id}/stream",
    summary="Live execution feed (Server-Sent Events)",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {"text/event-stream": {}},
            "description": "`event` / `delta` / `end` messages; resume with Last-Event-ID",
        }
    },
)
async def stream_execution(
    execution_id: uuid.UUID,
    request: Request,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    after: Annotated[int | None, Query(ge=0)] = None,
) -> StreamingResponse:
    await _authorise_stream(request, execution_id, Permission.EXECUTIONS_READ)
    start = (
        after
        if after is not None
        else (int(last_event_id) if last_event_id and last_event_id.isdigit() else 0)
    )

    async def generate() -> AsyncIterator[bytes]:
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(execution_channel(execution_id))
        last = start
        try:
            # Subscribe first, then replay: nothing published in between can be missed.
            for event in await _events_after(execution_id, last):
                last = event.seq
                yield _sse(
                    "event",
                    ExecutionEventOut.model_validate(event, from_attributes=True).model_dump(
                        mode="json"
                    ),
                    event.seq,
                )
                if event.type in TERMINAL_EVENTS:
                    yield _sse("end", {"last_seq": last})
                    return
            loop = asyncio.get_running_loop()
            last_poll = last_ping = loop.time()
            while True:
                if await request.is_disconnected():
                    return
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                now = loop.time()
                if message and message.get("type") == "message":
                    body = orjson.loads(message["data"])
                    if body.get("kind") == "delta":
                        yield _sse("delta", body)
                    elif body.get("kind") == "event":
                        event_data = body["event"]
                        if event_data["seq"] > last:
                            if (
                                event_data["seq"] > last + 1
                            ):  # gap: fetch the missing ones from the database
                                for missed in await _events_after(execution_id, last):
                                    if missed.seq >= event_data["seq"]:
                                        break
                                    last = missed.seq
                                    yield _sse(
                                        "event",
                                        ExecutionEventOut.model_validate(
                                            missed, from_attributes=True
                                        ).model_dump(mode="json"),
                                        missed.seq,
                                    )
                            last = event_data["seq"]
                            yield _sse("event", event_data, last)
                            if event_data["type"] in TERMINAL_EVENTS:
                                yield _sse("end", {"last_seq": last})
                                return
                if now - last_poll >= POLL_S:  # safety net if a live message was lost
                    last_poll = now
                    for event in await _events_after(execution_id, last):
                        last = event.seq
                        yield _sse(
                            "event",
                            ExecutionEventOut.model_validate(
                                event, from_attributes=True
                            ).model_dump(mode="json"),
                            event.seq,
                        )
                        if event.type in TERMINAL_EVENTS:
                            yield _sse("end", {"last_seq": last})
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


@router.get(
    "/workspaces/{workspace_id}/stream",
    summary="Live workspace feed: execution state changes (Server-Sent Events)",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def stream_workspace(workspace_id: uuid.UUID, request: Request) -> StreamingResponse:
    from gouvra.core.authz import resolve_workspace_access
    from gouvra.modules.identity.auth import authenticate_request

    async with get_sessionmaker()() as db:
        actor = await authenticate_request(request, db)
        if actor is None:
            raise Unauthorized()
        await resolve_workspace_access(db, actor, workspace_id, Permission.EXECUTIONS_READ)

    async def generate() -> AsyncIterator[bytes]:
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(workspace_channel(workspace_id))
        loop = asyncio.get_running_loop()
        last_ping = loop.time()
        try:
            yield _sse("ready", {"workspace_id": str(workspace_id)})
            while not await request.is_disconnected():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    body = orjson.loads(message["data"])
                    yield _sse(str(body.get("kind", "message")), body)
                if loop.time() - last_ping >= KEEPALIVE_S:
                    last_ping = loop.time()
                    yield b": keep-alive\n\n"
        finally:
            await pubsub.unsubscribe()
            await pubsub.aclose()  # type: ignore[no-untyped-call]

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


_ = TERMINAL
