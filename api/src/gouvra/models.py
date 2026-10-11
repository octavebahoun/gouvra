"""Import every ORM model so that Alembic and the metadata see the whole schema."""

from __future__ import annotations

from gouvra.core.db import Base
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.api_keys.models import ApiKey
from gouvra.modules.audit.models import AuditEvent
from gouvra.modules.executions.models import Execution, ExecutionEvent, UsageRecord
from gouvra.modules.identity.models import EmailToken, OAuthAccount, User, UserSession
from gouvra.modules.notifications.models import EmailOutbox
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.tools.models import Tool
from gouvra.modules.workspaces.models import Invitation, Membership, Workspace

__all__ = [
    "Agent",
    "AgentVersion",
    "ApiKey",
    "AuditEvent",
    "Base",
    "EmailOutbox",
    "EmailToken",
    "Execution",
    "ExecutionEvent",
    "Invitation",
    "Membership",
    "OAuthAccount",
    "ProviderConfig",
    "Tool",
    "UsageRecord",
    "User",
    "UserSession",
    "Workspace",
]
