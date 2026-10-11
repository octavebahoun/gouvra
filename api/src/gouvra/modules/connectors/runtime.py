"""Running a connector operation as a tool call: build the request server-side, send it safely."""

from __future__ import annotations

from typing import Any

from gouvra.core.db import get_sessionmaker
from gouvra.modules.connectors.catalog import CONNECTORS, Connector, Credentials, Request
from gouvra.modules.connectors.models import Connection
from gouvra.modules.connectors.service import credentials_of, record_outcome
from gouvra.modules.tools.builtins import ToolInputError
from gouvra.modules.tools.http_client import fetch
from gouvra.modules.tools.models import Tool

MAX_RESPONSE_BYTES = 262_144


async def send(spec: Connector, credentials: Credentials, request: Request) -> tuple[int, Any]:
    """One request to the connector's own hosts only, public addresses only, bounded answer."""
    result = await fetch(
        method=request.method,
        url=request.url,
        headers=request.headers,
        json_body=request.json_body,
        content=request.content,
        allowed_hosts=spec.hosts(credentials),
        secret_headers=request.secret_headers,
        max_response_bytes=MAX_RESPONSE_BYTES,
    )
    return int(result["status"]), result["body"]


def _provider_message(body: Any) -> str:
    if isinstance(body, dict):
        for key in ("message", "error", "error_description"):
            if isinstance(body.get(key), str):
                return str(body[key])[:300]
    return str(body)[:300] if body else ""


async def run_connector_tool(tool: Tool, arguments: dict[str, Any]) -> Any:
    async with get_sessionmaker()() as db:
        connection = await db.get(Connection, tool.connection_id) if tool.connection_id else None
    if connection is None or connection.archived_at is not None:
        raise ToolInputError("This tool's connection was removed.")
    spec = CONNECTORS.get(connection.connector)
    operation = spec.operation((tool.config or {}).get("operation", "")) if spec else None
    if spec is None or operation is None:
        raise ToolInputError("This connector operation no longer exists.")
    credentials = credentials_of(connection)
    try:
        status, body = await send(spec, credentials, operation.build(credentials, arguments))
    except ToolInputError as exc:
        await record_outcome(connection.id, False, str(exc))
        raise
    if not 200 <= status < 300:
        detail = _provider_message(body)
        await record_outcome(connection.id, False, f"HTTP {status}: {detail}")
        raise ToolInputError(
            f"{spec.name} refused the request (HTTP {status})" + (f": {detail}" if detail else ".")
        )
    await record_outcome(connection.id, True, None)
    return operation.result(status, body)
