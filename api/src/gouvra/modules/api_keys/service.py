"""Create, authenticate and revoke workspace service keys."""

from __future__ import annotations

import secrets
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Actor
from gouvra.core.db import utcnow
from gouvra.core.ids import hash_token
from gouvra.modules.api_keys.models import ApiKey
from gouvra.modules.workspaces.models import Workspace, WorkspaceStatus

KEY_PREFIX = "gvr_live_"
TOUCH_EVERY = timedelta(minutes=1)


def generate_key() -> tuple[str, str, str]:
    """Return (full key, display prefix, sha256 hash). 256 bits of entropy."""
    full = KEY_PREFIX + secrets.token_urlsafe(32)
    return full, full[: len(KEY_PREFIX) + 4], hash_token(full)


async def authenticate_service_key(db: AsyncSession, presented: str) -> Actor | None:
    if not presented.startswith(KEY_PREFIX) or len(presented) > 128:
        return None
    now = utcnow()
    row = (
        await db.execute(
            select(ApiKey, Workspace.status)
            .join(Workspace, Workspace.id == ApiKey.workspace_id)
            .where(ApiKey.key_hash == hash_token(presented), ApiKey.revoked_at.is_(None))
        )
    ).first()
    if row is None:
        return None
    key, workspace_status = row[0], row[1]
    if key.expires_at is not None and key.expires_at <= now:
        return None
    if workspace_status not in {WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED}:
        return None
    if key.last_used_at is None or now - key.last_used_at > TOUCH_EVERY:
        await db.execute(update(ApiKey).where(ApiKey.id == key.id).values(last_used_at=now))
        await db.commit()
    return Actor(
        api_key_id=key.id,
        api_key_workspace_id=key.workspace_id,
        api_key_role=key.role,
        api_key_name=key.name,
    )
