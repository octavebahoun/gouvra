"""Import every ORM model so that Alembic and the metadata see the whole schema."""

from __future__ import annotations

from gouvra.core.db import Base
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.api_keys.models import ApiKey
from gouvra.modules.audit.models import AuditEvent
from gouvra.modules.automations.models import Automation, AutomationFire
from gouvra.modules.billing.models import BillingEvent, Subscription
from gouvra.modules.budgets.models import Alert, Budget
from gouvra.modules.connectors.models import Connection
from gouvra.modules.evaluations.models import EvalCase, EvalResult, EvalRun, EvalSuite
from gouvra.modules.executions.models import Execution, ExecutionEvent, UsageRecord
from gouvra.modules.identity.models import EmailToken, OAuthAccount, User, UserSession
from gouvra.modules.notifications.models import EmailOutbox
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.tools.models import Tool
from gouvra.modules.workflows.models import Workflow, WorkflowRun, WorkflowStep, WorkflowVersion
from gouvra.modules.workspaces.models import Invitation, Membership, Workspace

__all__ = [
    "Agent",
    "AgentVersion",
    "Alert",
    "ApiKey",
    "AuditEvent",
    "Automation",
    "AutomationFire",
    "Base",
    "BillingEvent",
    "Budget",
    "Connection",
    "EmailOutbox",
    "EmailToken",
    "EvalCase",
    "EvalResult",
    "EvalRun",
    "EvalSuite",
    "Execution",
    "ExecutionEvent",
    "Invitation",
    "Membership",
    "OAuthAccount",
    "ProviderConfig",
    "Subscription",
    "Tool",
    "UsageRecord",
    "User",
    "UserSession",
    "Workflow",
    "WorkflowRun",
    "WorkflowStep",
    "WorkflowVersion",
    "Workspace",
]
