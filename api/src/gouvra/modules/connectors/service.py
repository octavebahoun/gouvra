"""Connections: install a connector, keep its credentials sealed, publish its operations."""

from __future__ import annotations

import json
import re
import uuid
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.crypto import decrypt_secret, encrypt_secret
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.core.netguard import BlockedDestination, validate_base_url
from gouvra.modules.audit.service import record_for
from gouvra.modules.connectors.catalog import CONNECTORS, Connector, Credentials
from gouvra.modules.connectors.models import Connection
from gouvra.modules.connectors.schemas import ConnectionCreateIn, ConnectionUpdateIn
from gouvra.modules.tools.models import Tool

SECRET_PURPOSE = "connector_credentials"  # noqa: S105 - key purpose label, not a secret
TOOL_TIMEOUT_MS = 20_000


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


def spec_of(key: str) -> Connector:
    spec = CONNECTORS.get(key)
    if spec is None:
        raise _invalid("connector", "Unknown connector.", "unknown_connector")
    return spec


def check_credentials(spec: Connector, values: dict[str, str]) -> Credentials:
    """Exactly the connector's fields, each matching its expected shape."""
    unknown = set(values) - {f.key for f in spec.fields}
    if unknown:
        raise _invalid(f"credentials.{min(unknown)}", "Unknown field.", "unknown_field")
    clean: Credentials = {}
    for field in spec.fields:
        value = (values.get(field.key) or "").strip()
        if not value:
            if field.required:
                raise _invalid(
                    f"credentials.{field.key}", f"{field.label} is required.", "required"
                )
            continue
        if not re.fullmatch(field.pattern, value):
            raise _invalid(
                f"credentials.{field.key}",
                f"This does not look like a {field.label.lower()}.",
                "invalid_format",
            )
        clean[field.key] = value
    if spec.key == "webhook":
        parts = urlsplit(clean["url"])
        try:  # a query string is fine for an endpoint (often its token); the host must be public
            validate_base_url(
                urlunsplit(parts._replace(query="", fragment="")), field="credentials.url"
            )
        except (BlockedDestination, ValidationFailed) as exc:
            raise _invalid(
                "credentials.url", "The endpoint must be a public HTTPS address.", "blocked_url"
            ) from exc
    return clean


def _seal(connection: Connection, credentials: Credentials, spec: Connector) -> None:
    sealed = encrypt_secret(
        json.dumps(credentials),
        workspace_id=connection.workspace_id,
        resource_id=connection.id,
        purpose=SECRET_PURPOSE,
    )
    connection.secret_ciphertext = sealed.ciphertext
    connection.secret_key_id = sealed.key_id
    main = credentials.get(spec.fields[0].key, "")
    connection.secret_hint = main[-4:] if len(main) >= 12 else None


def credentials_of(connection: Connection) -> Credentials:
    if connection.secret_ciphertext is None or connection.secret_key_id is None:
        raise _invalid("credentials", "This connection has no credentials.", "removed")
    plain = decrypt_secret(
        connection.secret_ciphertext,
        connection.secret_key_id,
        workspace_id=connection.workspace_id,
        resource_id=connection.id,
        purpose=SECRET_PURPOSE,
    )
    data: dict[str, str] = json.loads(plain)
    return data


def _tool_name(connection_name: str, operation: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", connection_name.lower()).strip("_")[:30] or "connector"
    if not base[0].isalpha():
        base = f"c_{base}"
    name = f"{base}_{operation}"[:64]
    suffix = 2
    while name in taken:
        name = f"{base}_{operation}_{suffix}"[:64]
        suffix += 1
    taken.add(name)
    return name


async def tools_of(db: AsyncSession, connection: Connection) -> list[Tool]:
    return list(
        (
            await db.execute(
                select(Tool)
                .where(Tool.connection_id == connection.id)
                .order_by(Tool.created_at, Tool.name)
            )
        ).scalars()
    )


async def create_connection(
    db: AsyncSession, ctx: WorkspaceContext, payload: ConnectionCreateIn
) -> Connection:
    ctx.require(Permission.CONNECTORS_MANAGE)
    spec = spec_of(payload.connector)
    credentials = check_credentials(spec, payload.credentials)
    connection = Connection(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        connector=spec.key,
        name=payload.name,
        created_by_id=ctx.actor.user_id,
    )
    _seal(connection, credentials, spec)
    db.add(connection)
    taken = set(
        (
            await db.execute(
                select(Tool.name).where(
                    Tool.workspace_id == ctx.workspace_id, Tool.archived_at.is_(None)
                )
            )
        ).scalars()
    )
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A connection with this name already exists.", "taken") from exc
    for operation in spec.operations:
        db.add(
            Tool(
                id=uuid7(),
                workspace_id=ctx.workspace_id,
                name=_tool_name(connection.name, operation.key, taken),
                display_name=f"{connection.name} — {operation.name}"[:80],
                description=operation.description,
                kind="connector",
                input_schema=operation.input_schema,
                config={"connector": spec.key, "operation": operation.key},
                connection_id=connection.id,
                timeout_ms=TOOL_TIMEOUT_MS,
                created_by_id=ctx.actor.user_id,
            )
        )
    await record_for(
        db,
        ctx.actor,
        "connection.created",
        workspace_id=ctx.workspace_id,
        target_type="connection",
        target_id=connection.id,
        data={"connector": spec.key, "name": connection.name},
    )
    await db.commit()
    return connection


async def update_connection(
    db: AsyncSession, ctx: WorkspaceContext, connection: Connection, payload: ConnectionUpdateIn
) -> Connection:
    ctx.require(Permission.CONNECTORS_MANAGE)
    if connection.archived_at is not None:
        raise Conflict("This connection was removed.", code="connection_removed")
    spec = spec_of(connection.connector)
    changes: list[str] = []
    if payload.name and payload.name != connection.name:
        connection.name = payload.name
        for tool in await tools_of(db, connection):
            operation = spec.operation((tool.config or {}).get("operation", ""))
            if operation is not None:
                tool.display_name = f"{connection.name} — {operation.name}"[:80]
        changes.append("name")
    if payload.credentials is not None:
        _seal(connection, check_credentials(spec, payload.credentials), spec)
        connection.status, connection.status_message = "unverified", None
        changes.append("credentials")
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A connection with this name already exists.", "taken") from exc
    await record_for(
        db,
        ctx.actor,
        "connection.updated",
        workspace_id=ctx.workspace_id,
        target_type="connection",
        target_id=connection.id,
        data={"fields": changes},
    )
    await db.commit()
    return connection


async def remove_connection(
    db: AsyncSession, ctx: WorkspaceContext, connection: Connection
) -> None:
    """Remove it: its credentials are erased and its tools archived (their history stays)."""
    ctx.require(Permission.CONNECTORS_MANAGE)
    now = utcnow()
    for tool in await tools_of(db, connection):
        tool.archived_at = tool.archived_at or now
        tool.status = "disabled"
    connection.archived_at = now
    connection.secret_ciphertext = connection.secret_key_id = connection.secret_hint = None
    await record_for(
        db,
        ctx.actor,
        "connection.removed",
        workspace_id=ctx.workspace_id,
        target_type="connection",
        target_id=connection.id,
        data={"name": connection.name},
    )
    await db.commit()


async def check_connection(
    db: AsyncSession, ctx: WorkspaceContext, connection: Connection
) -> tuple[bool, str]:
    """A harmless call with the stored credentials (when the connector offers one)."""
    from gouvra.modules.connectors.runtime import send

    ctx.require(Permission.CONNECTORS_MANAGE)
    spec = spec_of(connection.connector)
    if spec.check is None:
        connection.status_message = (
            "This connector is verified the first time one of its tools runs."
        )
        await db.commit()
        return True, connection.status_message
    credentials = credentials_of(connection)
    try:
        status, body = await send(spec, credentials, spec.check(credentials))
    except Exception as exc:  # noqa: BLE001 - reported to the person checking, never raised
        ok, message = False, str(exc)[:300]
    else:
        ok = 200 <= status < 300
        message = (
            spec.check_result(status, body)
            if ok and spec.check_result
            else ("Credentials accepted." if ok else f"Refused by {spec.name} (HTTP {status}).")
        )
    connection.status = "ok" if ok else "error"
    connection.status_message = message
    connection.last_checked_at = utcnow()
    await db.commit()
    return ok, message


async def record_outcome(connection_id: uuid.UUID, ok: bool, message: str | None) -> None:
    """Remember the outcome of the latest real call (shown on the connection)."""
    from gouvra.core.db import get_sessionmaker

    async with get_sessionmaker()() as db:
        connection = await db.get(Connection, connection_id)
        if connection is None or connection.archived_at is not None:
            return
        connection.status = "ok" if ok else "error"
        connection.status_message = None if ok else (message or "")[:300]
        connection.last_checked_at = utcnow()
        await db.commit()
