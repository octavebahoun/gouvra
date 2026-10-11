"""Central access control.

Every request resolves an `Actor` (session user or workspace service key). Every
workspace-scoped read or write goes through `workspace_access()` / `load_in_workspace()`:
the resource is loaded *filtered by workspace*, membership is checked, and a missing
resource and a resource of another workspace are indistinguishable (404).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Any, Protocol

from fastapi import Depends, Path, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.db import get_db
from gouvra.core.errors import AppError, Forbidden, NotFound, Unauthorized
from gouvra.modules.workspaces.models import ROLE_RANK, Membership, Role, Workspace, WorkspaceStatus

if TYPE_CHECKING:
    from gouvra.modules.identity.models import User, UserSession


class Permission(StrEnum):
    WORKSPACE_READ = "workspace:read"
    WORKSPACE_UPDATE = "workspace:update"
    WORKSPACE_DELETE = "workspace:delete"
    MEMBERS_READ = "members:read"
    MEMBERS_MANAGE = "members:manage"
    INVITATIONS_MANAGE = "invitations:manage"
    OWNERSHIP_TRANSFER = "ownership:transfer"
    AUDIT_READ = "audit:read"
    API_KEYS_MANAGE = "api_keys:manage"
    PROVIDERS_READ = "providers:read"
    PROVIDERS_MANAGE = "providers:manage"
    AGENTS_READ = "agents:read"
    AGENTS_WRITE = "agents:write"
    TOOLS_READ = "tools:read"
    TOOLS_WRITE = "tools:write"
    EXECUTIONS_READ = "executions:read"
    EXECUTIONS_LAUNCH = "executions:launch"
    EXECUTIONS_CANCEL = "executions:cancel"
    USAGE_READ = "usage:read"
    EVALUATIONS_READ = "evaluations:read"
    EVALUATIONS_WRITE = "evaluations:write"
    WORKFLOWS_READ = "workflows:read"
    WORKFLOWS_WRITE = "workflows:write"
    AUTOMATIONS_READ = "automations:read"
    AUTOMATIONS_MANAGE = "automations:manage"
    CONNECTORS_MANAGE = "connectors:manage"
    BUDGETS_MANAGE = "budgets:manage"
    RETENTION_MANAGE = "retention:manage"
    EXPORTS_CREATE = "exports:create"
    BILLING_READ = "billing:read"
    BILLING_MANAGE = "billing:manage"


_VIEWER = {
    Permission.WORKSPACE_READ,
    Permission.MEMBERS_READ,
    Permission.PROVIDERS_READ,
    Permission.AGENTS_READ,
    Permission.TOOLS_READ,
    Permission.EXECUTIONS_READ,
    Permission.USAGE_READ,
    Permission.EVALUATIONS_READ,
    Permission.WORKFLOWS_READ,
    Permission.AUTOMATIONS_READ,
}
_MEMBER = _VIEWER | {
    Permission.AGENTS_WRITE,
    Permission.TOOLS_WRITE,
    Permission.EXECUTIONS_LAUNCH,
    Permission.EXECUTIONS_CANCEL,
    Permission.EVALUATIONS_WRITE,
    Permission.WORKFLOWS_WRITE,
    Permission.EXPORTS_CREATE,
}
_ADMIN = _MEMBER | {
    Permission.WORKSPACE_UPDATE,
    Permission.MEMBERS_MANAGE,
    Permission.INVITATIONS_MANAGE,
    Permission.AUDIT_READ,
    Permission.API_KEYS_MANAGE,
    Permission.PROVIDERS_MANAGE,
    Permission.AUTOMATIONS_MANAGE,
    Permission.CONNECTORS_MANAGE,
    Permission.BUDGETS_MANAGE,
    Permission.RETENTION_MANAGE,
    Permission.BILLING_READ,
}
_OWNER = _ADMIN | {
    Permission.WORKSPACE_DELETE,
    Permission.OWNERSHIP_TRANSFER,
    Permission.BILLING_MANAGE,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset(_VIEWER),
    Role.MEMBER: frozenset(_MEMBER),
    Role.ADMIN: frozenset(_ADMIN),
    Role.OWNER: frozenset(_OWNER),
}


def role_allows(role: str, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(Role(role), frozenset())


def role_at_least(role: str, minimum: Role) -> bool:
    return ROLE_RANK[Role(role)] >= ROLE_RANK[minimum]


class EmailNotVerified(AppError):
    status_code = 403
    code = "email_not_verified"
    title = "Confirm your e-mail address first"


class WorkspaceSuspended(AppError):
    status_code = 403
    code = "workspace_suspended"
    title = "This workspace is suspended"


@dataclass
class Actor:
    """Who is calling: a signed-in user, or a workspace service key (scoped to one workspace)."""

    user: User | None = None
    session: UserSession | None = None
    api_key_id: uuid.UUID | None = None
    api_key_workspace_id: uuid.UUID | None = None
    api_key_role: str | None = None
    api_key_name: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def user_id(self) -> uuid.UUID | None:
        return self.user.id if self.user else None

    @property
    def is_service_key(self) -> bool:
        return self.api_key_id is not None

    @property
    def is_superadmin(self) -> bool:
        return bool(self.user and self.user.is_superadmin)

    @property
    def label(self) -> str:
        if self.user is not None:
            return self.user.email
        return f"service key {self.api_key_name or self.api_key_id}"


@dataclass(frozen=True)
class WorkspaceContext:
    workspace: Workspace
    role: str
    actor: Actor

    @property
    def workspace_id(self) -> uuid.UUID:
        return self.workspace.id

    def can(self, permission: Permission) -> bool:
        return role_allows(self.role, permission)

    def require(self, permission: Permission) -> None:
        if not self.can(permission):
            raise Forbidden(details={"permission": permission.value, "role": self.role})


async def resolve_workspace_access(
    db: AsyncSession, actor: Actor, workspace_id: uuid.UUID, permission: Permission
) -> WorkspaceContext:
    """Membership (or service key scope) check. Non-members get 404, never 403."""
    if actor.is_service_key:
        if actor.api_key_workspace_id != workspace_id:
            raise NotFound("Workspace not found")
        workspace = await db.get(Workspace, workspace_id)
        if workspace is None:
            raise NotFound("Workspace not found")
        role = actor.api_key_role or Role.VIEWER
    else:
        if actor.user is None:
            raise Unauthorized()
        row = (
            await db.execute(
                select(Workspace, Membership.role)
                .join(Membership, Membership.workspace_id == Workspace.id)
                .where(Workspace.id == workspace_id, Membership.user_id == actor.user.id)
            )
        ).first()
        if row is None:
            raise NotFound("Workspace not found")
        workspace, role = row[0], row[1]
    if workspace.status == WorkspaceStatus.SUSPENDED and permission not in _VIEWER:
        raise WorkspaceSuspended()
    context = WorkspaceContext(workspace=workspace, role=role, actor=actor)
    context.require(permission)
    return context


class _WorkspaceScoped(Protocol):
    id: Any
    workspace_id: Any


async def load_in_workspace[ModelT: _WorkspaceScoped](
    db: AsyncSession,
    model: type[ModelT],
    resource_id: uuid.UUID,
    actor: Actor,
    permission: Permission,
    *,
    for_update: bool = False,
) -> tuple[ModelT, WorkspaceContext]:
    """Load a workspace-scoped resource by id and authorise the actor on its workspace.

    A missing resource and a resource the actor cannot see both raise the same 404.
    """
    query = select(model).where(model.id == resource_id)
    if for_update:
        query = query.with_for_update()
    resource = (await db.execute(query)).scalar_one_or_none()
    if resource is None:
        raise NotFound(f"{model.__name__} not found")
    try:
        context = await resolve_workspace_access(db, actor, resource.workspace_id, permission)
    except NotFound:
        raise NotFound(f"{model.__name__} not found") from None
    return resource, context


# ---------------------------------------------------------------- FastAPI dependencies


async def get_actor(
    request: Request, response: Response, db: Annotated[AsyncSession, Depends(get_db)]
) -> Actor:
    from gouvra.modules.identity.auth import authenticate_request

    actor = await authenticate_request(request, db, response)
    if actor is None:
        raise Unauthorized()
    return actor


async def get_verified_actor(actor: Annotated[Actor, Depends(get_actor)]) -> Actor:
    if actor.user is not None and not actor.user.email_verified:
        raise EmailNotVerified()
    return actor


CurrentActor = Annotated[Actor, Depends(get_verified_actor)]
AnyActor = Annotated[Actor, Depends(get_actor)]  # also unverified users (profile, resend)
DbSession = Annotated[AsyncSession, Depends(get_db)]


def workspace_access(permission: Permission) -> Any:
    """Dependency for `/workspaces/{workspace_id}/...` routes."""

    async def dependency(
        workspace_id: Annotated[uuid.UUID, Path()],
        actor: CurrentActor,
        db: DbSession,
    ) -> WorkspaceContext:
        return await resolve_workspace_access(db, actor, workspace_id, permission)

    return Depends(dependency)


async def require_superadmin(actor: CurrentActor) -> Actor:
    if not actor.is_superadmin:
        raise NotFound()
    return actor


SuperAdmin = Annotated[Actor, Depends(require_superadmin)]
