"""Service key management (admins). The full key is returned once, at creation."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select, update

from gouvra.core.authz import DbSession, Permission, WorkspaceContext, workspace_access
from gouvra.core.db import utcnow
from gouvra.core.errors import NotFound
from gouvra.modules.api_keys.models import ApiKey
from gouvra.modules.api_keys.service import generate_key
from gouvra.modules.audit.service import record_for

router = APIRouter(prefix="/workspaces/{workspace_id}/api-keys", tags=["api-keys"])
Ctx = WorkspaceContext


class ApiKeyCreateIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    role: Literal["admin", "member", "viewer"] = "member"
    expires_in_days: int | None = Field(default=None, ge=1, le=730)


class ApiKeyOut(BaseModel):
    id: uuid.UUID
    name: str
    prefix: str
    role: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None


class ApiKeyCreated(ApiKeyOut):
    key: str = Field(description="Shown only once. Store it in a secret manager.")


def _out(key: ApiKey) -> ApiKeyOut:
    return ApiKeyOut.model_validate(key, from_attributes=True)


@router.get("", summary="List service keys")
async def list_keys(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.API_KEYS_MANAGE)]
) -> list[ApiKeyOut]:
    rows = (
        await db.execute(
            select(ApiKey)
            .where(ApiKey.workspace_id == ctx.workspace_id)
            .order_by(ApiKey.created_at.desc())
        )
    ).scalars()
    return [_out(k) for k in rows]


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a service key")
async def create_key(
    payload: ApiKeyCreateIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.API_KEYS_MANAGE)],
) -> ApiKeyCreated:
    full, prefix, digest = generate_key()
    key = ApiKey(
        workspace_id=ctx.workspace_id,
        name=payload.name,
        prefix=prefix,
        key_hash=digest,
        role=payload.role,
        created_by_id=ctx.actor.user_id,
        expires_at=utcnow() + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days
        else None,
    )
    db.add(key)
    await db.flush()
    await record_for(
        db,
        ctx.actor,
        "api_key.created",
        workspace_id=ctx.workspace_id,
        target_type="api_key",
        target_id=key.id,
        data={"name": key.name, "role": key.role},
    )
    await db.commit()
    return ApiKeyCreated(**_out(key).model_dump(), key=full)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Revoke a service key")
async def revoke_key(
    key_id: uuid.UUID,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.API_KEYS_MANAGE)],
) -> None:
    result = await db.execute(
        update(ApiKey)
        .where(
            ApiKey.id == key_id,
            ApiKey.workspace_id == ctx.workspace_id,
            ApiKey.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise NotFound("Service key not found")
    await record_for(
        db,
        ctx.actor,
        "api_key.revoked",
        workspace_id=ctx.workspace_id,
        target_type="api_key",
        target_id=key_id,
    )
    await db.commit()
