"""Workspace, member, invitation and onboarding routes."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from gouvra.core import ratelimit
from gouvra.core.authz import (
    ROLE_PERMISSIONS,
    AnyActor,
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    workspace_access,
)
from gouvra.core.context import current_client_ip
from gouvra.core.errors import Forbidden
from gouvra.modules.identity.auth import check_origin
from gouvra.modules.identity.models import User
from gouvra.modules.identity.schemas import TokenIn
from gouvra.modules.workspaces import onboarding, service
from gouvra.modules.workspaces.models import Invitation, Role, Workspace
from gouvra.modules.workspaces.schemas import (
    InvitationCreateIn,
    InvitationOut,
    InvitationPreviewOut,
    MemberOut,
    OnboardingOut,
    OnboardingStep,
    RoleUpdateIn,
    TransferOwnershipIn,
    WorkspaceCreateIn,
    WorkspaceDeleteIn,
    WorkspaceOut,
    WorkspaceUpdateIn,
)

router = APIRouter(prefix="/workspaces", tags=["workspaces"])
invitations_router = APIRouter(
    prefix="/invitations", tags=["invitations"], dependencies=[Depends(check_origin)]
)

Ctx = WorkspaceContext


async def _out(db: DbSession, workspace: Workspace, role: str) -> WorkspaceOut:
    return WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        slug=workspace.slug,
        role=role,
        status=workspace.status,
        is_demo=workspace.is_demo,
        member_count=await service.member_count(db, workspace.id),
        created_at=workspace.created_at,
        permissions=sorted(p.value for p in ROLE_PERMISSIONS[Role(role)]),
    )


def _invitation_out(invitation: Invitation, inviter: str | None) -> InvitationOut:
    return InvitationOut(
        id=invitation.id,
        email=invitation.email,
        role=invitation.role,
        status=service.invitation_status(invitation),  # type: ignore[arg-type]
        invited_by=inviter,
        created_at=invitation.created_at,
        expires_at=invitation.expires_at,
        last_sent_at=invitation.last_sent_at,
    )


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a workspace")
async def create_workspace(
    payload: WorkspaceCreateIn, actor: CurrentActor, db: DbSession
) -> WorkspaceOut:
    workspace, role = await service.create_workspace(db, actor, payload.name, payload.slug)
    return await _out(db, workspace, role)


@router.get("", summary="List the workspaces I belong to")
async def list_workspaces(actor: CurrentActor, db: DbSession) -> list[WorkspaceOut]:
    from gouvra.modules.workspaces.models import Membership

    if actor.is_service_key:
        workspace = await db.get(Workspace, actor.api_key_workspace_id)
        return [await _out(db, workspace, actor.api_key_role or "viewer")] if workspace else []
    rows = (
        await db.execute(
            select(Workspace, Membership.role)
            .join(Membership, Membership.workspace_id == Workspace.id)
            .where(Membership.user_id == actor.user_id)
            .order_by(Workspace.name)
        )
    ).all()
    return [await _out(db, w, role) for w, role in rows]


@router.get("/{workspace_id}", summary="Get a workspace")
async def get_workspace(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_READ)]
) -> WorkspaceOut:
    return await _out(db, ctx.workspace, ctx.role)


@router.patch("/{workspace_id}", summary="Rename a workspace or change its URL")
async def update_workspace(
    payload: WorkspaceUpdateIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_UPDATE)],
) -> WorkspaceOut:
    workspace = await service.update_workspace(db, ctx, payload.name, payload.slug)
    return await _out(db, workspace, ctx.role)


@router.post(
    "/{workspace_id}/delete",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a workspace (owner)",
)
async def delete_workspace(
    payload: WorkspaceDeleteIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_DELETE)],
) -> None:
    await service.delete_workspace(db, ctx, payload.confirm_name)


class WorkspaceSettingsIn(BaseModel):
    max_concurrent_executions: int | None = Field(default=None, ge=1, le=50)


class WorkspaceSettingsOut(BaseModel):
    max_concurrent_executions: int
    max_concurrent_executions_limit: int


@router.get("/{workspace_id}/settings", summary="Operational settings (limits)")
async def get_settings_(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_READ)]
) -> WorkspaceSettingsOut:
    from gouvra.modules.executions.queue import workspace_concurrency_limit

    return WorkspaceSettingsOut(
        max_concurrent_executions=await workspace_concurrency_limit(db, ctx.workspace_id),
        max_concurrent_executions_limit=50,
    )


@router.patch("/{workspace_id}/settings", summary="Change operational settings")
async def update_settings(
    payload: WorkspaceSettingsIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_UPDATE)],
) -> WorkspaceSettingsOut:
    from gouvra.modules.audit.service import record_for

    settings = dict(ctx.workspace.settings or {})
    if payload.max_concurrent_executions is not None:
        settings["max_concurrent_executions"] = payload.max_concurrent_executions
    ctx.workspace.settings = settings
    await record_for(
        db,
        ctx.actor,
        "workspace.settings_updated",
        workspace_id=ctx.workspace_id,
        target_type="workspace",
        target_id=ctx.workspace_id,
        data=payload.model_dump(exclude_none=True),
    )
    await db.commit()
    return await get_settings_(db, ctx)


@router.get("/{workspace_id}/members", summary="List members")
async def list_members(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.MEMBERS_READ)]
) -> list[MemberOut]:
    return [
        MemberOut(
            user_id=user.id,
            display_name=user.display_name,
            email=user.email,
            role=membership.role,
            joined_at=membership.created_at,
            is_you=user.id == ctx.actor.user_id,
        )
        for membership, user in await service.list_members(db, ctx.workspace_id)
    ]


@router.patch("/{workspace_id}/members/{user_id}", summary="Change a member's role")
async def change_member_role(
    user_id: uuid.UUID,
    payload: RoleUpdateIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.MEMBERS_MANAGE)],
) -> MemberOut:
    membership = await service.change_role(db, ctx, user_id, payload.role)
    user = await db.get(User, user_id)
    assert user is not None  # noqa: S101 - membership implies the user exists
    return MemberOut(
        user_id=user.id,
        display_name=user.display_name,
        email=user.email,
        role=membership.role,
        joined_at=membership.created_at,
        is_you=False,
    )


@router.delete(
    "/{workspace_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a member",
)
async def remove_member(
    user_id: uuid.UUID,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_READ)],
) -> None:
    if user_id == ctx.actor.user_id:
        await service.leave_workspace(db, ctx)
        return
    if not ctx.can(Permission.MEMBERS_MANAGE):
        raise Forbidden(details={"permission": Permission.MEMBERS_MANAGE.value})
    await service.remove_member(db, ctx, user_id)


@router.post(
    "/{workspace_id}/transfer-ownership",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Transfer ownership (owner)",
)
async def transfer_ownership(
    payload: TransferOwnershipIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.OWNERSHIP_TRANSFER)],
) -> None:
    await service.transfer_ownership(db, ctx, payload.user_id)


@router.get("/{workspace_id}/invitations", summary="List pending invitations")
async def list_invitations(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.MEMBERS_READ)]
) -> list[InvitationOut]:
    return [
        _invitation_out(i, inviter)
        for i, inviter in await service.list_invitations(db, ctx.workspace_id)
    ]


@router.post(
    "/{workspace_id}/invitations",
    status_code=status.HTTP_201_CREATED,
    summary="Invite someone by e-mail",
)
async def create_invitation(
    payload: InvitationCreateIn,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.INVITATIONS_MANAGE)],
) -> InvitationOut:
    await ratelimit.hit(ratelimit.INVITES_PER_WORKSPACE, str(ctx.workspace_id))
    invitation = await service.create_invitation(db, ctx, payload.email, payload.role)
    return _invitation_out(invitation, ctx.actor.user.display_name if ctx.actor.user else None)


@router.post(
    "/{workspace_id}/invitations/{invitation_id}/resend", summary="Send an invitation again"
)
async def resend_invitation(
    invitation_id: uuid.UUID,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.INVITATIONS_MANAGE)],
) -> InvitationOut:
    await ratelimit.hit(ratelimit.INVITES_PER_WORKSPACE, str(ctx.workspace_id))
    invitation = await service.resend_invitation(db, ctx, invitation_id)
    return _invitation_out(invitation, ctx.actor.user.display_name if ctx.actor.user else None)


@router.delete(
    "/{workspace_id}/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Revoke an invitation",
)
async def revoke_invitation(
    invitation_id: uuid.UUID,
    db: DbSession,
    ctx: Annotated[Ctx, workspace_access(Permission.INVITATIONS_MANAGE)],
) -> None:
    await service.revoke_invitation(db, ctx, invitation_id)


@router.get("/{workspace_id}/onboarding", summary="First-configuration checklist")
async def get_onboarding(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_READ)]
) -> OnboardingOut:
    steps = await onboarding.evaluate(db, ctx.workspace_id)
    required = [(s, done) for s, done in steps if not s.optional]
    return OnboardingOut(
        steps=[OnboardingStep(key=s.key, done=done, optional=s.optional) for s, done in steps],
        completed=sum(1 for _, done in required if done),
        total=len(required),
        dismissed=ctx.workspace.onboarding_dismissed_at is not None,
    )


@router.post(
    "/{workspace_id}/onboarding/dismiss",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Hide the checklist",
)
async def dismiss_onboarding(
    db: DbSession, ctx: Annotated[Ctx, workspace_access(Permission.WORKSPACE_UPDATE)]
) -> None:
    await service.dismiss_onboarding(db, ctx)


# ---------------------------------------------------------------- invitation links (token holders)


@invitations_router.post("/preview", summary="What an invitation link points to")
async def preview_invitation(payload: TokenIn, db: DbSession) -> InvitationPreviewOut:
    await ratelimit.hit(ratelimit.RESET_PER_IP, current_client_ip())
    invitation, workspace, inviter = await service.invitation_by_token(db, payload.token)
    return InvitationPreviewOut(
        workspace_name=workspace.name,
        inviter_name=inviter,
        role=invitation.role,
        email_hint=service.mask_email(invitation.email),
        expires_at=invitation.expires_at,
        status=service.invitation_status(invitation),  # type: ignore[arg-type]
    )


@invitations_router.post(
    "/accept", summary="Accept an invitation (signed in with the invited address)"
)
async def accept_invitation(payload: TokenIn, actor: AnyActor, db: DbSession) -> WorkspaceOut:
    from gouvra.core.authz import EmailNotVerified

    if actor.user is not None and not actor.user.email_verified:
        raise EmailNotVerified()
    workspace, role = await service.accept_invitation(db, actor, payload.token)
    return await _out(db, workspace, role)
