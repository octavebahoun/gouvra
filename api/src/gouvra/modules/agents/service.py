"""Agents: creation, versioned edits, duplication, archiving, readiness checks."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.agents.schemas import (
    AgentConfigIn,
    AgentCreateIn,
    AgentLimits,
    AgentParameters,
    AgentUpdateIn,
)
from gouvra.modules.audit.service import record_for
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.tools.models import Tool

VERSION_FIELDS = ("instructions", "provider_id", "model", "parameters", "tool_ids", "limits")


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


async def _check_provider(
    db: AsyncSession, workspace_id: uuid.UUID, provider_id: uuid.UUID | None
) -> ProviderConfig | None:
    if provider_id is None:
        return None
    provider = (
        await db.execute(
            select(ProviderConfig).where(
                ProviderConfig.id == provider_id,
                ProviderConfig.workspace_id == workspace_id,
                ProviderConfig.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if provider is None:
        raise _invalid("provider_id", "This provider does not exist in the workspace.", "not_found")
    return provider


async def _check_tools(
    db: AsyncSession, workspace_id: uuid.UUID, tool_ids: list[uuid.UUID]
) -> list[Tool]:
    unique = list(dict.fromkeys(tool_ids))
    if not unique:
        return []
    tools = list(
        (
            await db.execute(
                select(Tool).where(
                    Tool.workspace_id == workspace_id,
                    Tool.id.in_(unique),
                    Tool.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    found = {t.id for t in tools}
    missing = [str(t) for t in unique if t not in found]
    if missing:
        raise _invalid(
            "tool_ids", "Some tools do not exist in the workspace or are archived.", "not_found"
        )
    names = [t.name for t in tools]
    if len(set(names)) != len(names):
        raise _invalid("tool_ids", "Two allowed tools share the same name.", "duplicate")
    return tools


def _check_limits(limits: AgentLimits) -> AgentLimits:
    maximum = get_settings().max_execution_timeout_s
    if limits.timeout_s > maximum:
        raise _invalid(
            "limits.timeout_s",
            f"This instance allows at most {maximum} seconds per execution.",
            "too_large",
        )
    return limits


def _version_values(config: AgentConfigIn | dict[str, Any]) -> dict[str, Any]:
    data = config if isinstance(config, dict) else config.model_dump()
    return {
        "instructions": data.get("instructions") or "",
        "provider_config_id": data.get("provider_id"),
        "model": data.get("model") or "",
        "parameters": AgentParameters.model_validate(data.get("parameters") or {}).model_dump(
            mode="json"
        ),
        "tool_ids": [str(t) for t in dict.fromkeys(data.get("tool_ids") or [])],
        "limits": AgentLimits.model_validate(data.get("limits") or {}).model_dump(mode="json"),
    }


async def _new_version(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, values: dict[str, Any], note: str | None
) -> AgentVersion:
    agent.latest_version_number += 1
    version = AgentVersion(
        id=uuid7(),
        agent_id=agent.id,
        workspace_id=agent.workspace_id,
        number=agent.latest_version_number,
        change_note=note,
        created_by_id=ctx.actor.user_id,
        **values,
    )
    db.add(version)
    await db.flush()
    agent.current_version_id = version.id
    agent.updated_at = utcnow()
    return version


async def create_agent(db: AsyncSession, ctx: WorkspaceContext, payload: AgentCreateIn) -> Agent:
    provider = await _check_provider(db, ctx.workspace_id, payload.provider_id)
    await _check_tools(db, ctx.workspace_id, payload.tool_ids)
    _check_limits(payload.limits)
    model = payload.model or (provider.default_model if provider else None)
    agent = Agent(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        name=payload.name,
        description=payload.description,
        created_by_id=ctx.actor.user_id,
    )
    db.add(agent)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "An agent with this name already exists.", "taken") from exc
    values = _version_values({**payload.model_dump(), "model": model})
    await _new_version(db, ctx, agent, values, "Created")
    await record_for(
        db,
        ctx.actor,
        "agent.created",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=agent.id,
        data={"name": agent.name},
    )
    await db.commit()
    return agent


async def current_version(db: AsyncSession, agent: Agent) -> AgentVersion | None:
    return (
        await db.get(AgentVersion, agent.current_version_id) if agent.current_version_id else None
    )


async def update_agent(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, payload: AgentUpdateIn
) -> Agent:
    if agent.archived_at is not None:
        raise Conflict("Restore the agent before editing it.", code="agent_archived")
    fields = payload.model_fields_set
    if "name" in fields and payload.name:
        agent.name = payload.name
    if "description" in fields and payload.description is not None:
        agent.description = payload.description
    current = await current_version(db, agent)
    base = {
        "instructions": current.instructions if current else "",
        "provider_id": current.provider_config_id if current else None,
        "model": current.model if current else None,
        "parameters": current.parameters if current else {},
        "tool_ids": [uuid.UUID(t) for t in (current.tool_ids if current else [])],
        "limits": current.limits if current else {},
    }
    requested = {f: getattr(payload, f) for f in VERSION_FIELDS if f in fields}
    if "parameters" in requested and requested["parameters"] is not None:
        requested["parameters"] = requested["parameters"].model_dump(mode="json")
    if "limits" in requested and requested["limits"] is not None:
        requested["limits"] = _check_limits(requested["limits"]).model_dump(mode="json")
    if "provider_id" in requested:
        await _check_provider(db, ctx.workspace_id, requested["provider_id"])
    if "tool_ids" in requested and requested["tool_ids"] is not None:
        await _check_tools(db, ctx.workspace_id, requested["tool_ids"])
    merged = {**base, **{k: v for k, v in requested.items() if v is not None or k == "provider_id"}}
    new_values = _version_values(merged)
    old_values = _version_values(base)
    changed = new_values != old_values
    if changed:
        await _new_version(db, ctx, agent, new_values, payload.change_note)
    agent.updated_at = utcnow()
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "An agent with this name already exists.", "taken") from exc
    await record_for(
        db,
        ctx.actor,
        "agent.updated",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=agent.id,
        data={"new_version": agent.latest_version_number if changed else None},
    )
    await db.commit()
    return agent


async def _free_copy_name(db: AsyncSession, workspace_id: uuid.UUID, base: str) -> str:
    for index in range(1, 50):
        candidate = (f"{base} (copy)" if index == 1 else f"{base} (copy {index})")[:80]
        exists = (
            await db.execute(
                select(func.count())
                .select_from(Agent)
                .where(
                    Agent.workspace_id == workspace_id,
                    Agent.name == candidate,
                    Agent.archived_at.is_(None),
                )
            )
        ).scalar_one()
        if not exists:
            return candidate
    raise Conflict("Pick a name for the copy.", code="name_unavailable")


async def duplicate_agent(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, name: str | None
) -> Agent:
    current = await current_version(db, agent)
    copy = Agent(
        id=uuid7(),
        workspace_id=agent.workspace_id,
        name=name or await _free_copy_name(db, agent.workspace_id, agent.name),
        description=agent.description,
        created_by_id=ctx.actor.user_id,
    )
    db.add(copy)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "An agent with this name already exists.", "taken") from exc
    values = {
        "instructions": current.instructions if current else "",
        "provider_config_id": current.provider_config_id if current else None,
        "model": current.model if current else "",
        "parameters": dict(current.parameters) if current else {},
        "tool_ids": list(current.tool_ids) if current else [],
        "limits": dict(current.limits) if current else {},
    }
    await _new_version(
        db, ctx, copy, values, f"Duplicated from {agent.name} v{current.number if current else 0}"
    )
    await record_for(
        db,
        ctx.actor,
        "agent.duplicated",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=copy.id,
        data={"source": str(agent.id)},
    )
    await db.commit()
    return copy


async def set_archived(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, archived: bool
) -> Agent:
    if archived:
        agent.archived_at = utcnow()
    else:
        clash = (
            await db.execute(
                select(func.count())
                .select_from(Agent)
                .where(
                    Agent.workspace_id == agent.workspace_id,
                    Agent.name == agent.name,
                    Agent.archived_at.is_(None),
                    Agent.id != agent.id,
                )
            )
        ).scalar_one()
        if clash:
            raise Conflict(
                "An active agent already uses this name. Rename one of them first.",
                code="name_taken",
            )
        agent.archived_at = None
    await record_for(
        db,
        ctx.actor,
        "agent.archived" if archived else "agent.restored",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=agent.id,
    )
    await db.commit()
    return agent


async def delete_agent(db: AsyncSession, ctx: WorkspaceContext, agent: Agent) -> None:
    from gouvra.modules.executions.models import Execution

    runs = (
        await db.execute(
            select(func.count()).select_from(Execution).where(Execution.agent_id == agent.id)
        )
    ).scalar_one()
    if runs:
        raise Conflict(
            "This agent has executions in its history. Archive it instead to keep the traces.",
            code="agent_has_history",
            details={"executions": runs},
        )
    agent.current_version_id = None
    await db.flush()
    await record_for(
        db,
        ctx.actor,
        "agent.deleted",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=agent.id,
        data={"name": agent.name},
    )
    await db.delete(agent)
    await db.commit()


async def restore_version(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, number: int
) -> Agent:
    source = (
        await db.execute(
            select(AgentVersion).where(
                AgentVersion.agent_id == agent.id, AgentVersion.number == number
            )
        )
    ).scalar_one_or_none()
    if source is None:
        raise _invalid("number", "This version does not exist.", "not_found")
    values = {
        "instructions": source.instructions,
        "provider_config_id": source.provider_config_id,
        "model": source.model,
        "parameters": dict(source.parameters),
        "tool_ids": list(source.tool_ids),
        "limits": dict(source.limits),
    }
    await _new_version(db, ctx, agent, values, f"Restored from v{number}")
    await record_for(
        db,
        ctx.actor,
        "agent.version_restored",
        workspace_id=ctx.workspace_id,
        target_type="agent",
        target_id=agent.id,
        data={"from": number},
    )
    await db.commit()
    return agent


@dataclass
class Readiness:
    ready: bool
    issues: list[str]


async def readiness(db: AsyncSession, version: AgentVersion | None) -> Readiness:
    """Can this version run? Blocking issues prevent launches; warnings are informative."""
    if version is None:
        return Readiness(False, ["no_version"])
    issues: list[str] = []
    provider = (
        await db.get(ProviderConfig, version.provider_config_id)
        if version.provider_config_id
        else None
    )
    if provider is None or provider.archived_at is not None:
        issues.append("no_provider")
    elif provider.status == "error":
        issues.append("provider_error")
    if not version.model:
        issues.append("no_model")
    if version.tool_ids:
        tools = list(
            (
                await db.execute(
                    select(Tool).where(Tool.id.in_([uuid.UUID(t) for t in version.tool_ids]))
                )
            ).scalars()
        )
        if len(tools) != len(version.tool_ids) or any(
            t.archived_at or t.status != "active" for t in tools
        ):
            issues.append("tool_unavailable")
    blocking = {"no_version", "no_provider", "no_model"}
    return Readiness(not (blocking & set(issues)), issues)
