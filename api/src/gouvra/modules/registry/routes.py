"""The registry: every model and tool the workspace can use, with what uses them and at what price.

A governance view assembled from the catalogues (provider models with published prices, built-in
tools, connector operations) and the workspace's own configuration (providers, tools, agents).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from gouvra.core.authz import DbSession, Permission, WorkspaceContext, workspace_access
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.providers.catalog import models_for
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.providers.registry import KINDS
from gouvra.modules.providers.routes import model_info_out
from gouvra.modules.providers.schemas import ModelInfoOut
from gouvra.modules.tools.builtins import BUILTINS
from gouvra.modules.tools.models import Tool

router = APIRouter(tags=["registry"])


class Ref(BaseModel):
    id: uuid.UUID
    name: str


class RegistryModelOut(BaseModel):
    provider_kind: str
    provider_label: str
    model: ModelInfoOut
    providers: list[Ref] = Field(description="Configured providers of this kind")
    agents: list[Ref] = Field(description="Agents whose current version uses this model")


class RegistryToolOut(BaseModel):
    id: uuid.UUID | None = Field(description="None: a built-in tool not added to the workspace")
    name: str
    display_name: str
    description: str
    kind: Literal["builtin", "http", "code", "connector"]
    builtin_key: str | None
    connection_id: uuid.UUID | None
    status: str
    uses_network: bool
    input_schema: dict[str, object]
    agents: list[Ref]


class RegistryOut(BaseModel):
    models: list[RegistryModelOut]
    tools: list[RegistryToolOut]


@router.get("/workspaces/{workspace_id}/registry", summary="Models and tools, with their use")
async def registry(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AGENTS_READ)],
) -> RegistryOut:
    providers = list(
        (
            await db.execute(
                select(ProviderConfig)
                .where(ProviderConfig.workspace_id == ctx.workspace_id)
                .order_by(ProviderConfig.name)
            )
        ).scalars()
    )
    kind_of = {p.id: p.kind for p in providers}
    versions = (
        await db.execute(
            select(
                Agent.id,
                Agent.name,
                AgentVersion.provider_config_id,
                AgentVersion.model,
                AgentVersion.tool_ids,
            )
            .join(AgentVersion, AgentVersion.id == Agent.current_version_id)
            .where(Agent.workspace_id == ctx.workspace_id, Agent.archived_at.is_(None))
            .order_by(Agent.name)
        )
    ).all()
    by_model: dict[tuple[str, str], list[Ref]] = defaultdict(list)
    by_tool: dict[str, list[Ref]] = defaultdict(list)
    for agent_id, agent_name, provider_id, model, tool_ids in versions:
        if provider_id in kind_of and model:
            by_model[(kind_of[provider_id], model)].append(Ref(id=agent_id, name=agent_name))
        for tool_id in tool_ids or []:
            by_tool[str(tool_id)].append(Ref(id=agent_id, name=agent_name))

    models = [
        RegistryModelOut(
            provider_kind=spec.kind,
            provider_label=spec.label,
            model=model_info_out(info),
            providers=[Ref(id=p.id, name=p.name) for p in providers if p.kind == spec.kind],
            agents=by_model.get((spec.kind, info.id), []),
        )
        for spec in KINDS.values()
        for info in models_for(spec.kind)
    ]

    tools = list(
        (
            await db.execute(
                select(Tool)
                .where(Tool.workspace_id == ctx.workspace_id, Tool.archived_at.is_(None))
                .order_by(Tool.display_name)
            )
        ).scalars()
    )
    installed = {t.builtin_key for t in tools if t.builtin_key}
    entries = [
        RegistryToolOut(
            id=tool.id,
            name=tool.name,
            display_name=tool.display_name,
            description=tool.description,
            kind=tool.kind,  # type: ignore[arg-type]
            builtin_key=tool.builtin_key,
            connection_id=tool.connection_id,
            status=tool.status,
            uses_network=tool.kind in ("http", "connector")
            or bool(tool.builtin_key and BUILTINS[tool.builtin_key].uses_network)
            or bool(tool.kind == "code" and (tool.config or {}).get("network")),
            input_schema=tool.input_schema,
            agents=by_tool.get(str(tool.id), []),
        )
        for tool in tools
    ]
    entries += [
        RegistryToolOut(
            id=None,
            name=builtin.name,
            display_name=builtin.display_name,
            description=builtin.description,
            kind="builtin",
            builtin_key=builtin.key,
            connection_id=None,
            status="available",
            uses_network=builtin.uses_network,
            input_schema=builtin.input_schema,
            agents=[],
        )
        for builtin in BUILTINS.values()
        if builtin.key not in installed
    ]
    return RegistryOut(models=models, tools=entries)
