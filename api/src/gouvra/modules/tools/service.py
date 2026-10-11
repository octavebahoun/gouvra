"""Tool definitions: validation per kind, encrypted credentials, controlled test runs."""

from __future__ import annotations

import uuid
from typing import Any
from urllib.parse import urlsplit

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.crypto import encrypt_secret
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.core.netguard import validate_base_url
from gouvra.modules.audit.service import record_for
from gouvra.modules.tools.builtins import BUILTINS
from gouvra.modules.tools.models import Tool
from gouvra.modules.tools.runtime import SECRET_PURPOSE
from gouvra.modules.tools.schema_rules import check_input_schema
from gouvra.modules.tools.schemas import CodeToolConfig, HttpToolConfig, ToolCreateIn, ToolUpdateIn


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


def _validate_config(kind: str, builtin_key: str | None, config: dict[str, Any]) -> dict[str, Any]:
    if kind == "builtin":
        from gouvra.modules.tools.schema_rules import validate_arguments

        builtin = BUILTINS[builtin_key or ""]
        errors = validate_arguments(builtin.config_schema, config)
        if errors:
            raise ValidationFailed(
                errors=[{"field": "config", "code": "invalid", "message": e} for e in errors]
            )
        return config
    model = HttpToolConfig if kind == "http" else CodeToolConfig
    try:
        parsed = model.model_validate(config)
    except PydanticValidationError as exc:
        raise ValidationFailed(
            errors=[
                {
                    "field": "config." + ".".join(str(p) for p in e["loc"]),
                    "code": e["type"],
                    "message": e["msg"],
                }
                for e in exc.errors()
            ]
        ) from exc
    if isinstance(parsed, HttpToolConfig):
        static_url = parsed.url.replace("{", "").replace("}", "")
        parts = urlsplit(static_url)
        if not parts.hostname or "{" in (urlsplit(parsed.url).netloc or ""):
            raise _invalid(
                "config.url",
                "The host must be fixed: placeholders are only allowed in the path and query.",
            )
        validate_base_url(
            f"{parts.scheme}://{parts.netloc}",
            allow_private=get_settings().http_tool_allow_private_networks,
            field="config.url",
        )
    return parsed.model_dump()


def _store_secret(tool: Tool, secret: str) -> None:
    sealed = encrypt_secret(
        secret, workspace_id=tool.workspace_id, resource_id=tool.id, purpose=SECRET_PURPOSE
    )
    tool.secret_ciphertext, tool.secret_key_id, tool.secret_last4 = (
        sealed.ciphertext,
        sealed.key_id,
        sealed.last4,
    )


async def create_tool(db: AsyncSession, ctx: WorkspaceContext, payload: ToolCreateIn) -> Tool:
    if payload.kind == "builtin":
        builtin = BUILTINS.get(payload.builtin_key or "")
        if builtin is None:
            raise _invalid("builtin_key", "Unknown built-in tool.")
        name = payload.name or builtin.name
        display_name = payload.display_name or builtin.display_name
        description = payload.description or builtin.description
        schema = builtin.input_schema
    else:
        if not (payload.name and payload.description and payload.input_schema is not None):
            raise ValidationFailed(
                errors=[
                    {"field": f, "code": "required", "message": "Required for custom tools."}
                    for f, v in (
                        ("name", payload.name),
                        ("description", payload.description),
                        ("input_schema", payload.input_schema),
                    )
                    if not v and v != {}
                ]
            )
        name, description = payload.name, payload.description
        display_name = payload.display_name or payload.name.replace("_", " ").capitalize()
        schema = check_input_schema(payload.input_schema)
    tool = Tool(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        name=name,
        display_name=display_name,
        description=description,
        kind=payload.kind,
        builtin_key=payload.builtin_key if payload.kind == "builtin" else None,
        input_schema=schema,
        config=_validate_config(payload.kind, payload.builtin_key, payload.config),
        status="active",
        timeout_ms=payload.timeout_ms,
        created_by_id=ctx.actor.user_id,
    )
    if payload.secret:
        if payload.kind != "http":
            raise _invalid("secret", "Only HTTP tools take a credential.")
        _store_secret(tool, payload.secret)
    db.add(tool)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid(
            "name", "A tool with this name already exists in the workspace.", "taken"
        ) from exc
    await record_for(
        db,
        ctx.actor,
        "tool.created",
        workspace_id=ctx.workspace_id,
        target_type="tool",
        target_id=tool.id,
        data={"name": tool.name, "kind": tool.kind},
    )
    await db.commit()
    return tool


async def update_tool(
    db: AsyncSession, ctx: WorkspaceContext, tool: Tool, payload: ToolUpdateIn
) -> Tool:
    if tool.archived_at is not None:
        raise Conflict("Archived tools cannot be edited.", code="tool_archived")
    changes: list[str] = []
    for field_name in ("name", "display_name", "description", "timeout_ms", "status"):
        value = getattr(payload, field_name)
        if value is not None and value != getattr(tool, field_name):
            setattr(tool, field_name, value)
            changes.append(field_name)
    if tool.kind == "connector" and (
        payload.input_schema is not None or payload.config is not None or payload.secret
    ):
        raise _invalid(
            "config", "This tool is managed by its connection: edit the connection instead."
        )
    if payload.input_schema is not None:
        if tool.kind == "builtin":
            raise _invalid("input_schema", "The schema of a built-in tool cannot be changed.")
        tool.input_schema = check_input_schema(payload.input_schema)
        changes.append("input_schema")
    if payload.config is not None:
        tool.config = _validate_config(tool.kind, tool.builtin_key, payload.config)
        changes.append("config")
    if payload.clear_secret:
        tool.secret_ciphertext = tool.secret_key_id = tool.secret_last4 = None
        changes.append("secret")
    elif payload.secret:
        if tool.kind != "http":
            raise _invalid("secret", "Only HTTP tools take a credential.")
        _store_secret(tool, payload.secret)
        changes.append("secret")
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid(
            "name", "A tool with this name already exists in the workspace.", "taken"
        ) from exc
    if changes:
        await record_for(
            db,
            ctx.actor,
            "tool.updated",
            workspace_id=ctx.workspace_id,
            target_type="tool",
            target_id=tool.id,
            data={"fields": changes},
        )
    await db.commit()
    return tool


async def archive_tool(db: AsyncSession, ctx: WorkspaceContext, tool: Tool) -> None:
    tool.archived_at = utcnow()
    tool.status = "disabled"
    await record_for(
        db,
        ctx.actor,
        "tool.archived",
        workspace_id=ctx.workspace_id,
        target_type="tool",
        target_id=tool.id,
    )
    await db.commit()


async def tools_by_ids(
    db: AsyncSession, workspace_id: uuid.UUID, ids: list[uuid.UUID]
) -> list[Tool]:
    if not ids:
        return []
    return list(
        (
            await db.execute(
                select(Tool).where(
                    Tool.workspace_id == workspace_id, Tool.id.in_(ids), Tool.archived_at.is_(None)
                )
            )
        ).scalars()
    )
