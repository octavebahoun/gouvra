"""Instance administration (super-admins only; everyone else gets 404): every workspace and
account, plans, suspension, and the instance-wide audit log."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import DbSession, SuperAdmin
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, NotFound
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.modules.audit.models import AuditEvent
from gouvra.modules.audit.service import record_for
from gouvra.modules.billing import service as billing
from gouvra.modules.billing.models import Subscription
from gouvra.modules.executions.models import Execution, UsageRecord
from gouvra.modules.identity.models import User, UserSession
from gouvra.modules.workspaces.models import Membership, Workspace, WorkspaceStatus

router = APIRouter(prefix="/admin", tags=["administration"])


class InstanceOverviewOut(BaseModel):
    users: int
    workspaces: int
    suspended_workspaces: int
    executions_24h: int
    executions_30d: int
    spend_30d: Decimal
    plans: dict[str, int]
    billing_provider: str


class AdminWorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    owner_email: str | None
    members: int
    plan: str
    subscription_status: str | None
    status: str
    is_demo: bool
    executions_30d: int
    spend_30d: Decimal
    created_at: datetime


class AdminWorkspaceIn(BaseModel):
    status: Literal["active", "suspended"] | None = None
    plan: Literal["free", "team", "business"] | None = Field(
        default=None, description="Grant a plan without payment (or back to Free)"
    )


class AdminUserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    status: str
    is_superadmin: bool
    email_verified: bool
    workspaces: int
    created_at: datetime


class AdminUserIn(BaseModel):
    status: Literal["active", "disabled"]


class AdminAuditOut(BaseModel):
    id: uuid.UUID
    action: str
    actor_label: str | None
    workspace_id: uuid.UUID | None
    target_type: str | None
    target_id: str | None
    data: dict[str, Any]
    ip_address: str | None
    created_at: datetime


async def _count(db: AsyncSession, query: Any) -> int:
    return int((await db.execute(query)).scalar_one())


@router.get("/overview", summary="The instance at a glance")
async def overview(_: SuperAdmin, db: DbSession) -> InstanceOverviewOut:
    now = utcnow()
    plans = dict(
        (
            await db.execute(select(Subscription.plan, func.count()).group_by(Subscription.plan))
        ).all()
    )
    workspaces = await _count(db, select(func.count()).select_from(Workspace))
    paid = sum(plans.get(key, 0) for key in ("team", "business"))
    return InstanceOverviewOut(
        users=await _count(db, select(func.count()).select_from(User)),
        workspaces=workspaces,
        suspended_workspaces=await _count(
            db,
            select(func.count())
            .select_from(Workspace)
            .where(Workspace.status == WorkspaceStatus.SUSPENDED),
        ),
        executions_24h=await _count(
            db,
            select(func.count())
            .select_from(Execution)
            .where(Execution.created_at >= now - timedelta(days=1)),
        ),
        executions_30d=await _count(
            db,
            select(func.count())
            .select_from(Execution)
            .where(Execution.created_at >= now - timedelta(days=30)),
        ),
        spend_30d=Decimal(
            (
                await db.execute(
                    select(func.coalesce(func.sum(UsageRecord.cost_amount), 0)).where(
                        UsageRecord.recorded_at >= now - timedelta(days=30)
                    )
                )
            ).scalar_one()
            or 0
        ),
        plans={
            "free": workspaces - paid,
            "team": plans.get("team", 0),
            "business": plans.get("business", 0),
        },
        billing_provider=billing.provider().value,
    )


async def _workspace_out(db: AsyncSession, workspace: Workspace) -> AdminWorkspaceOut:
    since = utcnow() - timedelta(days=30)
    owner = await db.get(User, workspace.owner_id)
    subscription = await billing.subscription_of(db, workspace.id)
    return AdminWorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        slug=workspace.slug,
        owner_email=owner.email if owner else None,
        members=await _count(
            db,
            select(func.count())
            .select_from(Membership)
            .where(Membership.workspace_id == workspace.id),
        ),
        plan=billing.effective_plan(subscription).key,
        subscription_status=subscription.status if subscription else None,
        status=workspace.status,
        is_demo=workspace.is_demo,
        executions_30d=await _count(
            db,
            select(func.count())
            .select_from(Execution)
            .where(Execution.workspace_id == workspace.id, Execution.created_at >= since),
        ),
        spend_30d=Decimal(
            (
                await db.execute(
                    select(func.coalesce(func.sum(UsageRecord.cost_amount), 0)).where(
                        UsageRecord.workspace_id == workspace.id, UsageRecord.recorded_at >= since
                    )
                )
            ).scalar_one()
            or 0
        ),
        created_at=workspace.created_at,
    )


@router.get("/workspaces", summary="Every workspace (organisation) of the instance")
async def workspaces(
    _: SuperAdmin,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=80)] = None,
) -> list[AdminWorkspaceOut]:
    query = select(Workspace).order_by(Workspace.created_at.desc()).limit(200)
    if q:
        query = query.where(or_(Workspace.name.ilike(f"%{q}%"), Workspace.slug.ilike(f"%{q}%")))
    return [await _workspace_out(db, w) for w in (await db.execute(query)).scalars()]


@router.patch("/workspaces/{workspace_id}", summary="Suspend or restore a workspace; grant a plan")
async def update_workspace(
    workspace_id: uuid.UUID, payload: AdminWorkspaceIn, actor: SuperAdmin, db: DbSession
) -> AdminWorkspaceOut:
    workspace = await db.get(Workspace, workspace_id)
    if workspace is None:
        raise NotFound("Workspace not found")
    if payload.status and payload.status != workspace.status:
        workspace.status = payload.status
        await record_for(
            db,
            actor,
            "admin.workspace_suspended"
            if payload.status == "suspended"
            else "admin.workspace_restored",
            workspace_id=workspace.id,
            target_type="workspace",
            target_id=workspace.id,
        )
        await db.commit()
    if payload.plan:
        await billing.grant_plan(db, workspace.id, payload.plan, actor)
    await db.refresh(workspace)
    return await _workspace_out(db, workspace)


async def _user_out(db: AsyncSession, user: User) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        status=user.status,
        is_superadmin=user.is_superadmin,
        email_verified=user.email_verified,
        workspaces=await _count(
            db, select(func.count()).select_from(Membership).where(Membership.user_id == user.id)
        ),
        created_at=user.created_at,
    )


@router.get("/users", summary="Every account of the instance")
async def users(
    _: SuperAdmin,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=120)] = None,
) -> list[AdminUserOut]:
    query = select(User).order_by(User.created_at.desc()).limit(200)
    if q:
        query = query.where(or_(User.email.ilike(f"%{q}%"), User.display_name.ilike(f"%{q}%")))
    return [await _user_out(db, u) for u in (await db.execute(query)).scalars()]


@router.patch("/users/{user_id}", summary="Disable or re-enable an account (signs it out)")
async def update_user(
    user_id: uuid.UUID, payload: AdminUserIn, actor: SuperAdmin, db: DbSession
) -> AdminUserOut:
    user = await db.get(User, user_id)
    if user is None:
        raise NotFound("Account not found")
    if user.id == actor.user_id:
        raise Conflict("You cannot disable your own account.", code="self_disable")
    if payload.status != user.status:
        user.status = payload.status
        if payload.status == "disabled":
            sessions = (
                await db.execute(
                    select(UserSession).where(
                        UserSession.user_id == user.id, UserSession.revoked_at.is_(None)
                    )
                )
            ).scalars()
            for session in sessions:
                session.revoked_at = utcnow()
        await record_for(
            db,
            actor,
            "admin.user_disabled" if payload.status == "disabled" else "admin.user_enabled",
            target_type="user",
            target_id=user.id,
        )
        await db.commit()
    return await _user_out(db, user)


@router.get("/audit-events", summary="The instance-wide audit log")
async def audit_events(
    _: SuperAdmin,
    db: DbSession,
    params: Annotated[PageParams, Depends(page_params)],
) -> Page[AdminAuditOut]:
    rows = list(
        (
            await db.execute(
                paginate_desc(select(AuditEvent), params, AuditEvent.created_at, AuditEvent.id)
            )
        ).scalars()
    )
    return build_page(
        rows,
        params,
        lambda e: AdminAuditOut(
            id=e.id,
            action=e.action,
            actor_label=e.actor_label,
            workspace_id=e.workspace_id,
            target_type=e.target_type,
            target_id=e.target_id,
            data=e.data or {},
            ip_address=str(e.ip_address) if e.ip_address else None,
            created_at=e.created_at,
        ),
        lambda e: (e.created_at, e.id),
    )
