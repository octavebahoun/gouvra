"""Connector routes: the library, the workspace's connections, and their checks."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, status
from sqlalchemy import func, or_, select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.modules.connectors import service
from gouvra.modules.connectors.catalog import CONNECTORS
from gouvra.modules.connectors.models import Connection
from gouvra.modules.connectors.schemas import (
    CheckOut,
    ConnectionCreateIn,
    ConnectionOut,
    ConnectionToolOut,
    ConnectionUpdateIn,
    ConnectorOut,
    CredentialFieldOut,
    OperationOut,
)
from gouvra.modules.identity.models import User

router = APIRouter(tags=["connectors"])


async def connection_out(db: DbSession, connection: Connection) -> ConnectionOut:
    from gouvra.modules.agents.models import Agent, AgentVersion

    spec = CONNECTORS.get(connection.connector)
    tools = await service.tools_of(db, connection)
    live_ids = [str(t.id) for t in tools if t.archived_at is None]
    agents = (
        int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Agent)
                    .join(AgentVersion, AgentVersion.id == Agent.current_version_id)
                    .where(
                        Agent.archived_at.is_(None),
                        or_(*(AgentVersion.tool_ids.contains([tool_id]) for tool_id in live_ids)),
                    )
                )
            ).scalar_one()
        )
        if live_ids
        else 0
    )
    author = await db.get(User, connection.created_by_id) if connection.created_by_id else None
    return ConnectionOut(
        id=connection.id,
        workspace_id=connection.workspace_id,
        connector=connection.connector,
        connector_name=spec.name if spec else connection.connector,
        name=connection.name,
        secret_hint=connection.secret_hint,
        status=connection.status,  # type: ignore[arg-type]
        status_message=connection.status_message,
        last_checked_at=connection.last_checked_at,
        tools=[
            ConnectionToolOut(
                id=tool.id,
                name=tool.name,
                display_name=tool.display_name,
                operation=(tool.config or {}).get("operation", ""),
                status="archived" if tool.archived_at else tool.status,
            )
            for tool in tools
        ],
        agent_count=agents,
        created_by=author.display_name if author else None,
        created_at=connection.created_at,
        updated_at=connection.updated_at,
    )


@router.get("/connectors", summary="The connector library")
async def list_connectors(_: CurrentActor) -> list[ConnectorOut]:
    return [
        ConnectorOut(
            key=spec.key,
            name=spec.name,
            description=spec.description,
            category=spec.category,
            docs_url=spec.docs_url,
            fields=[
                CredentialFieldOut(
                    key=f.key,
                    label=f.label,
                    help=f.help,
                    placeholder=f.placeholder,
                    required=f.required,
                )
                for f in spec.fields
            ],
            operations=[
                OperationOut(
                    key=op.key,
                    name=op.name,
                    description=op.description,
                    input_schema=op.input_schema,
                    writes=op.writes,
                )
                for op in spec.operations
            ],
            verifiable=spec.check is not None,
        )
        for spec in CONNECTORS.values()
    ]


@router.get("/workspaces/{workspace_id}/connections", summary="Connections of the workspace")
async def list_connections(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.TOOLS_READ)],
) -> list[ConnectionOut]:
    rows = (
        await db.execute(
            select(Connection)
            .where(Connection.workspace_id == ctx.workspace_id, Connection.archived_at.is_(None))
            .order_by(Connection.created_at.desc())
        )
    ).scalars()
    return [await connection_out(db, row) for row in rows]


@router.post(
    "/workspaces/{workspace_id}/connections",
    status_code=status.HTTP_201_CREATED,
    summary="Connect a service: its operations become tools",
)
async def create_connection(
    payload: ConnectionCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.CONNECTORS_MANAGE)],
) -> ConnectionOut:
    return await connection_out(db, await service.create_connection(db, ctx, payload))


@router.get("/connections/{connection_id}", summary="Get a connection")
async def get_connection(
    connection_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> ConnectionOut:
    connection, _ = await load_in_workspace(
        db, Connection, connection_id, actor, Permission.TOOLS_READ
    )
    return await connection_out(db, connection)


@router.patch(
    "/connections/{connection_id}", summary="Rename a connection or replace its credentials"
)
async def update_connection(
    connection_id: uuid.UUID, payload: ConnectionUpdateIn, actor: CurrentActor, db: DbSession
) -> ConnectionOut:
    connection, ctx = await load_in_workspace(
        db, Connection, connection_id, actor, Permission.CONNECTORS_MANAGE, for_update=True
    )
    return await connection_out(db, await service.update_connection(db, ctx, connection, payload))


@router.delete(
    "/connections/{connection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a connection: credentials erased, tools archived",
)
async def remove_connection(connection_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    connection, ctx = await load_in_workspace(
        db, Connection, connection_id, actor, Permission.CONNECTORS_MANAGE
    )
    await service.remove_connection(db, ctx, connection)


@router.post("/connections/{connection_id}/check", summary="Check the credentials (no side effect)")
async def check_connection(
    connection_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> CheckOut:
    connection, ctx = await load_in_workspace(
        db, Connection, connection_id, actor, Permission.CONNECTORS_MANAGE
    )
    ok, message = await service.check_connection(db, ctx, connection)
    return CheckOut(ok=ok, status=connection.status, message=message)  # type: ignore[arg-type]
