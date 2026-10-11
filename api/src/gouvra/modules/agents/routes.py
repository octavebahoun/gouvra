"""Agent routes: list/search, create, edit (versioned), duplicate, archive, versions."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_, select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.db import utcnow
from gouvra.core.errors import NotFound
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.modules.agents import service
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.agents.schemas import (
    AgentCreateIn,
    AgentDuplicateIn,
    AgentLimits,
    AgentOut,
    AgentParameters,
    AgentUpdateIn,
    AgentVersionOut,
    LastExecution,
    ToolRef,
)
from gouvra.modules.executions.models import Execution
from gouvra.modules.identity.models import User
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.tools.models import Tool

router = APIRouter(tags=["agents"])


async def _tools_by_id(db: DbSession, tool_ids: set[uuid.UUID]) -> dict[uuid.UUID, Tool]:
    if not tool_ids:
        return {}
    return {
        t.id: t for t in (await db.execute(select(Tool).where(Tool.id.in_(tool_ids)))).scalars()
    }


async def version_out(
    db: DbSession,
    version: AgentVersion,
    current_id: uuid.UUID | None,
    tools: dict[uuid.UUID, Tool] | None = None,
) -> AgentVersionOut:
    """`tools` may be loaded once for many versions; providers and authors come from the session
    identity map after their first load."""
    provider = (
        await db.get(ProviderConfig, version.provider_config_id)
        if version.provider_config_id
        else None
    )
    tool_ids = [uuid.UUID(t) for t in version.tool_ids or []]
    if tools is None:
        tools = await _tools_by_id(db, set(tool_ids))
    author = await db.get(User, version.created_by_id) if version.created_by_id else None
    return AgentVersionOut(
        id=version.id,
        number=version.number,
        instructions=version.instructions,
        provider_id=version.provider_config_id,
        provider_name=provider.name if provider else None,
        provider_kind=provider.kind if provider else None,
        model=version.model,
        parameters=AgentParameters.model_validate(version.parameters or {}),
        tools=[
            ToolRef(
                id=tid,
                name=tools[tid].name if tid in tools else "deleted",
                display_name=tools[tid].display_name if tid in tools else "Deleted tool",
                available=tid in tools
                and tools[tid].archived_at is None
                and tools[tid].status == "active",
            )
            for tid in tool_ids
        ],
        limits=AgentLimits.model_validate(version.limits or {}),
        change_note=version.change_note,
        created_by=author.display_name if author else None,
        created_at=version.created_at,
        is_current=version.id == current_id,
    )


async def agent_out(db: DbSession, agent: Agent) -> AgentOut:
    version = await service.current_version(db, agent)
    last = (
        await db.execute(
            select(Execution)
            .where(Execution.agent_id == agent.id)
            .order_by(Execution.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    recent = (
        await db.execute(
            select(func.count())
            .select_from(Execution)
            .where(
                Execution.agent_id == agent.id, Execution.created_at > utcnow() - timedelta(days=30)
            )
        )
    ).scalar_one()
    check = await service.readiness(db, version)
    return AgentOut(
        id=agent.id,
        workspace_id=agent.workspace_id,
        name=agent.name,
        description=agent.description,
        status="archived" if agent.archived_at else "active",
        version=await version_out(db, version, agent.current_version_id) if version else None,
        latest_version_number=agent.latest_version_number,
        last_execution=LastExecution(
            id=last.id, status=last.status, created_at=last.created_at, duration_ms=last.duration_ms
        )
        if last
        else None,
        executions_30d=int(recent),
        ready=check.ready,
        readiness_issues=check.issues,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


@router.get("/workspaces/{workspace_id}/agents", summary="List and search agents")
async def list_agents(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AGENTS_READ)],
    params: Annotated[PageParams, Depends(page_params)],
    q: Annotated[str | None, Query(max_length=120)] = None,
    status_: Annotated[Literal["active", "archived", "all"], Query(alias="status")] = "active",
    provider_id: uuid.UUID | None = None,
) -> Page[AgentOut]:
    query = select(Agent).where(Agent.workspace_id == ctx.workspace_id)
    if status_ == "active":
        query = query.where(Agent.archived_at.is_(None))
    elif status_ == "archived":
        query = query.where(Agent.archived_at.is_not(None))
    if q:
        term = f"%{q.strip()}%"
        query = query.where(or_(Agent.name.ilike(term), Agent.description.ilike(term)))
    if provider_id:
        query = query.join(AgentVersion, AgentVersion.id == Agent.current_version_id).where(
            AgentVersion.provider_config_id == provider_id
        )
    rows = list(
        (await db.execute(paginate_desc(query, params, Agent.updated_at, Agent.id))).scalars()
    )
    outs = {a.id: await agent_out(db, a) for a in rows[: params.limit]}
    return build_page(rows, params, lambda a: outs[a.id], lambda a: (a.updated_at, a.id))


@router.post(
    "/workspaces/{workspace_id}/agents",
    status_code=status.HTTP_201_CREATED,
    summary="Create an agent",
)
async def create_agent(
    payload: AgentCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AGENTS_WRITE)],
) -> AgentOut:
    return await agent_out(db, await service.create_agent(db, ctx, payload))


@router.get("/agents/{agent_id}", summary="Get an agent with its current version")
async def get_agent(agent_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> AgentOut:
    agent, _ = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_READ)
    return await agent_out(db, agent)


@router.patch(
    "/agents/{agent_id}", summary="Edit an agent (configuration changes create a new version)"
)
async def update_agent(
    agent_id: uuid.UUID, payload: AgentUpdateIn, actor: CurrentActor, db: DbSession
) -> AgentOut:
    agent, ctx = await load_in_workspace(
        db, Agent, agent_id, actor, Permission.AGENTS_WRITE, for_update=True
    )
    return await agent_out(db, await service.update_agent(db, ctx, agent, payload))


@router.delete(
    "/agents/{agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an agent without history",
)
async def delete_agent(agent_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_WRITE)
    await service.delete_agent(db, ctx, agent)


@router.post(
    "/agents/{agent_id}/duplicate",
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate an agent",
)
async def duplicate_agent(
    agent_id: uuid.UUID, payload: AgentDuplicateIn, actor: CurrentActor, db: DbSession
) -> AgentOut:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_WRITE)
    return await agent_out(db, await service.duplicate_agent(db, ctx, agent, payload.name))


@router.post("/agents/{agent_id}/archive", summary="Archive an agent")
async def archive_agent(agent_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> AgentOut:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_WRITE)
    return await agent_out(db, await service.set_archived(db, ctx, agent, True))


@router.post("/agents/{agent_id}/restore", summary="Restore an archived agent")
async def restore_agent(agent_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> AgentOut:
    agent, ctx = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_WRITE)
    return await agent_out(db, await service.set_archived(db, ctx, agent, False))


@router.get("/agents/{agent_id}/versions", summary="Version history")
async def list_versions(
    agent_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> list[AgentVersionOut]:
    agent, _ = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_READ)
    versions = list(
        (
            await db.execute(
                select(AgentVersion)
                .where(AgentVersion.agent_id == agent.id)
                .order_by(AgentVersion.number.desc())
            )
        ).scalars()
    )
    tools = await _tools_by_id(db, {uuid.UUID(t) for v in versions for t in v.tool_ids or []})
    return [await version_out(db, v, agent.current_version_id, tools) for v in versions]


@router.get("/agents/{agent_id}/versions/{number}", summary="One version")
async def get_version(
    agent_id: uuid.UUID, number: int, actor: CurrentActor, db: DbSession
) -> AgentVersionOut:
    agent, _ = await load_in_workspace(db, Agent, agent_id, actor, Permission.AGENTS_READ)
    version = (
        await db.execute(
            select(AgentVersion).where(
                AgentVersion.agent_id == agent.id, AgentVersion.number == number
            )
        )
    ).scalar_one_or_none()
    if version is None:
        raise NotFound("Version not found")
    return await version_out(db, version, agent.current_version_id)


@router.post(
    "/agents/{agent_id}/versions/{number}/restore",
    summary="Make an old version current again (as a new version)",
)
async def restore_version(
    agent_id: uuid.UUID, number: int, actor: CurrentActor, db: DbSession
) -> AgentOut:
    agent, ctx = await load_in_workspace(
        db, Agent, agent_id, actor, Permission.AGENTS_WRITE, for_update=True
    )
    return await agent_out(db, await service.restore_version(db, ctx, agent, number))
