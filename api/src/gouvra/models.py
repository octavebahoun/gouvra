"""Import every ORM model so that Alembic and the metadata see the whole schema."""

from __future__ import annotations

from gouvra.core.db import Base
from gouvra.modules.api_keys.models import ApiKey
from gouvra.modules.audit.models import AuditEvent
from gouvra.modules.identity.models import EmailToken, OAuthAccount, User, UserSession
from gouvra.modules.notifications.models import EmailOutbox
from gouvra.modules.workspaces.models import Invitation, Membership, Workspace

__all__ = [
    "ApiKey",
    "AuditEvent",
    "Base",
    "EmailOutbox",
    "EmailToken",
    "Invitation",
    "Membership",
    "OAuthAccount",
    "User",
    "UserSession",
    "Workspace",
]
