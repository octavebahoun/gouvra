"""Audit log of a workspace (admins)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select

from gouvra.core.authz import DbSession, Permission, WorkspaceContext, workspace_access
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.modules.audit.models import AuditEvent

router = APIRouter(tags=["audit"])


class AuditEventOut(BaseModel):
    id: uuid.UUID
    action: str
    actor: str | None
    actor_user_id: uuid.UUID | None
    actor_api_key_id: uuid.UUID | None
    target_type: str | None
    target_id: str | None
    data: dict[str, Any]
    ip_address: str | None
    request_id: str | None
    created_at: datetime


def _out(event: AuditEvent) -> AuditEventOut:
    return AuditEventOut(
        id=event.id,
        action=event.action,
        actor=event.actor_label,
        actor_user_id=event.actor_user_id,
        actor_api_key_id=event.actor_api_key_id,
        target_type=event.target_type,
        target_id=event.target_id,
        data=event.data or {},
        ip_address=event.ip_address,
        request_id=event.request_id,
        created_at=event.created_at,
    )


@router.get("/workspaces/{workspace_id}/audit-events", summary="Audit log (who did what, when)")
async def list_audit_events(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AUDIT_READ)],
    params: Annotated[PageParams, Depends(page_params)],
    action: Annotated[
        str | None,
        Query(max_length=64, description="Exact action or prefix ending with '.' (e.g. 'agent.')"),
    ] = None,
    actor_user_id: uuid.UUID | None = None,
) -> Page[AuditEventOut]:
    query = select(AuditEvent).where(AuditEvent.workspace_id == ctx.workspace_id)
    if action:
        query = query.where(
            AuditEvent.action.startswith(action)
            if action.endswith(".")
            else AuditEvent.action == action
        )
    if actor_user_id:
        query = query.where(AuditEvent.actor_user_id == actor_user_id)
    rows = list(
        (
            await db.execute(paginate_desc(query, params, AuditEvent.created_at, AuditEvent.id))
        ).scalars()
    )
    return build_page(rows, params, _out, lambda e: (e.created_at, e.id))
