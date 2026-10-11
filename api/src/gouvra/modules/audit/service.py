"""Record audit events (secrets and content are filtered out)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.context import current_client_ip, current_request_id
from gouvra.core.logging import redact
from gouvra.modules.audit.models import AuditEvent


async def record(
    db: AsyncSession,
    action: str,
    *,
    actor_user_id: uuid.UUID | None = None,
    actor_api_key_id: uuid.UUID | None = None,
    actor_label: str | None = None,
    workspace_id: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: uuid.UUID | str | None = None,
    data: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        workspace_id=workspace_id,
        actor_user_id=actor_user_id,
        actor_api_key_id=actor_api_key_id,
        actor_label=actor_label[:160] if actor_label else None,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        data=redact(data or {}),
        ip_address=current_client_ip(),
        request_id=current_request_id(),
    )
    db.add(event)
    return event


async def record_for(db: AsyncSession, actor: Any, action: str, **kwargs: Any) -> AuditEvent:
    """Shortcut taking an `Actor`."""
    return await record(
        db,
        action,
        actor_user_id=actor.user_id,
        actor_api_key_id=actor.api_key_id,
        actor_label=actor.label,
        **kwargs,
    )
