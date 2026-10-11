"""Tool routes: built-in catalogue, workspace tools, controlled test runs."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select

from gouvra.core import ratelimit
from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.modules.tools import service
from gouvra.modules.tools.builtins import BUILTINS
from gouvra.modules.tools.models import Tool
from gouvra.modules.tools.runtime import run_tool
from gouvra.modules.tools.schemas import (
    BuiltinToolOut,
    ToolCreateIn,
    ToolOut,
    ToolTestIn,
    ToolTestOut,
    ToolUpdateIn,
)

router = APIRouter(tags=["tools"])
TOOL_TESTS = ratelimit.Limit("tools:test", 30, 60)


async def agent_count(db: DbSession, tool_id: uuid.UUID) -> int:
    from gouvra.modules.agents.models import Agent, AgentVersion

    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Agent)
                .join(AgentVersion, AgentVersion.id == Agent.current_version_id)
                .where(Agent.archived_at.is_(None), AgentVersion.tool_ids.contains([str(tool_id)]))
            )
        ).scalar_one()
    )


async def tool_out(db: DbSession, tool: Tool) -> ToolOut:
    builtin = BUILTINS.get(tool.builtin_key or "")
    return ToolOut(
        id=tool.id,
        workspace_id=tool.workspace_id,
        name=tool.name,
        display_name=tool.display_name,
        description=tool.description,
        kind=tool.kind,
        builtin_key=tool.builtin_key,
        input_schema=tool.input_schema,
        config=tool.config or {},
        secret_set=tool.secret_ciphertext is not None,
        secret_hint=f"••••{tool.secret_last4}"
        if tool.secret_last4
        else ("••••" if tool.secret_ciphertext else None),
        status="archived" if tool.archived_at else tool.status,
        timeout_ms=tool.timeout_ms,
        uses_network=bool(builtin and builtin.uses_network)
        or tool.kind == "http"
        or bool(tool.kind == "code" and (tool.config or {}).get("network")),
        agent_count=await agent_count(db, tool.id),
        created_at=tool.created_at,
        updated_at=tool.updated_at,
    )


@router.get("/tools/builtins", summary="Built-in tools catalogue")
async def builtin_tools(_: CurrentActor) -> list[BuiltinToolOut]:
    return [
        BuiltinToolOut(
            key=b.key,
            name=b.name,
            display_name=b.display_name,
            description=b.description,
            input_schema=b.input_schema,
            config_schema=b.config_schema,
            uses_network=b.uses_network,
        )
        for b in BUILTINS.values()
    ]


@router.get("/workspaces/{workspace_id}/tools", summary="List tools")
async def list_tools(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.TOOLS_READ)],
    include_archived: Annotated[bool, Query()] = False,
) -> list[ToolOut]:
    query = select(Tool).where(Tool.workspace_id == ctx.workspace_id).order_by(Tool.name)
    if not include_archived:
        query = query.where(Tool.archived_at.is_(None))
    return [await tool_out(db, t) for t in (await db.execute(query)).scalars()]


@router.post(
    "/workspaces/{workspace_id}/tools", status_code=status.HTTP_201_CREATED, summary="Create a tool"
)
async def create_tool(
    payload: ToolCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.TOOLS_WRITE)],
) -> ToolOut:
    return await tool_out(db, await service.create_tool(db, ctx, payload))


@router.get("/tools/{tool_id}", summary="Get a tool")
async def get_tool(tool_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> ToolOut:
    tool, _ = await load_in_workspace(db, Tool, tool_id, actor, Permission.TOOLS_READ)
    return await tool_out(db, tool)


@router.patch("/tools/{tool_id}", summary="Update a tool")
async def update_tool(
    tool_id: uuid.UUID, payload: ToolUpdateIn, actor: CurrentActor, db: DbSession
) -> ToolOut:
    tool, ctx = await load_in_workspace(db, Tool, tool_id, actor, Permission.TOOLS_WRITE)
    return await tool_out(db, await service.update_tool(db, ctx, tool, payload))


@router.delete("/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Archive a tool")
async def archive_tool(tool_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    tool, ctx = await load_in_workspace(db, Tool, tool_id, actor, Permission.TOOLS_WRITE)
    await service.archive_tool(db, ctx, tool)


@router.post(
    "/tools/{tool_id}/test", summary="Run the tool once with test arguments (controlled test)"
)
async def test_tool(
    tool_id: uuid.UUID, payload: ToolTestIn, actor: CurrentActor, db: DbSession
) -> ToolTestOut:
    tool, ctx = await load_in_workspace(db, Tool, tool_id, actor, Permission.TOOLS_WRITE)
    await ratelimit.hit(TOOL_TESTS, str(ctx.workspace_id))
    result = await run_tool(tool, payload.arguments)
    result.for_model()  # applies the same truncation the model would see
    return ToolTestOut(**result.as_dict())


class ToolCallOut(BaseModel):
    execution_id: uuid.UUID
    agent_name: str | None
    called_at: datetime
    ok: bool | None
    error_code: str | None
    duration_ms: int | None


@router.get("/tools/{tool_id}/calls", summary="Recent calls of this tool (usage history)")
async def tool_calls(
    tool_id: uuid.UUID,
    actor: CurrentActor,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> list[ToolCallOut]:
    from gouvra.modules.agents.models import Agent
    from gouvra.modules.executions.models import Execution, ExecutionEvent

    tool, ctx = await load_in_workspace(db, Tool, tool_id, actor, Permission.TOOLS_READ)
    calls = list(
        (
            await db.execute(
                select(ExecutionEvent)
                .where(
                    ExecutionEvent.workspace_id == ctx.workspace_id,
                    ExecutionEvent.type == "tool.call",
                    ExecutionEvent.data["tool_id"].astext == str(tool.id),
                )
                .order_by(ExecutionEvent.id.desc())
                .limit(limit)
            )
        ).scalars()
    )
    if not calls:
        return []
    execution_ids = {c.execution_id for c in calls}
    results = {
        (r.execution_id, r.data.get("call_id")): r
        for r in (
            await db.execute(
                select(ExecutionEvent).where(
                    ExecutionEvent.execution_id.in_(execution_ids),
                    ExecutionEvent.type == "tool.result",
                )
            )
        ).scalars()
    }
    agents = dict(
        (
            await db.execute(
                select(Execution.id, Agent.name)
                .join(Agent, Agent.id == Execution.agent_id)
                .where(Execution.id.in_(execution_ids))
            )
        ).all()
    )
    out: list[ToolCallOut] = []
    for call in calls:
        result = results.get((call.execution_id, call.data.get("call_id")))
        out.append(
            ToolCallOut(
                execution_id=call.execution_id,
                agent_name=agents.get(call.execution_id),
                called_at=call.created_at,
                ok=result.data.get("ok") if result else None,
                error_code=result.data.get("error_code") if result else None,
                duration_ms=result.duration_ms if result else None,
            )
        )
    return out
