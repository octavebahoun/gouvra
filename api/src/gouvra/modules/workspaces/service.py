"""Workspace business rules: creation, members, roles, invitations, ownership."""

from __future__ import annotations

import re
import secrets
import unicodedata
import uuid
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Actor, WorkspaceContext
from gouvra.core.db import utcnow
from gouvra.core.errors import BadRequest, Conflict, Forbidden, Gone, NotFound, ValidationFailed
from gouvra.core.ids import hash_token, new_token
from gouvra.modules.audit.service import record_for
from gouvra.modules.identity.models import User
from gouvra.modules.identity.service import app_link
from gouvra.modules.notifications.service import queue_email
from gouvra.modules.workspaces.models import (
    Invitation,
    InvitationStatus,
    Membership,
    Role,
    Workspace,
)

INVITATION_TTL = timedelta(days=7)
RESERVED_SLUGS = frozenset(
    {"app", "api", "admin", "new", "settings", "login", "logout", "w", "www", "docs"}
)


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return (slug or "workspace")[:40].strip("-")


async def _slug_available(db: AsyncSession, slug: str, exclude: uuid.UUID | None = None) -> bool:
    if slug in RESERVED_SLUGS:
        return False
    query = select(func.count()).select_from(Workspace).where(Workspace.slug == slug)
    if exclude is not None:
        query = query.where(Workspace.id != exclude)
    return (await db.execute(query)).scalar_one() == 0


async def _unique_slug(db: AsyncSession, base: str) -> str:
    candidate = base if len(base) >= 3 else f"{base}-ws"
    if await _slug_available(db, candidate):
        return candidate
    for _ in range(20):
        suffixed = f"{candidate[:40]}-{secrets.token_hex(2)}"
        if await _slug_available(db, suffixed):
            return suffixed
    raise Conflict(
        "Could not allocate a workspace URL — pick one explicitly.", code="slug_unavailable"
    )


async def create_workspace(
    db: AsyncSession, actor: Actor, name: str, slug: str | None
) -> tuple[Workspace, str]:
    if actor.user is None:
        raise Forbidden("Service keys cannot create workspaces.")
    if slug is not None:
        if not await _slug_available(db, slug):
            raise ValidationFailed(
                errors=[{"field": "slug", "code": "taken", "message": "This URL is already taken."}]
            )
    else:
        slug = await _unique_slug(db, slugify(name))
    workspace = Workspace(name=name, slug=slug, owner_id=actor.user.id, settings={})
    db.add(workspace)
    await db.flush()
    db.add(Membership(workspace_id=workspace.id, user_id=actor.user.id, role=Role.OWNER))
    await record_for(
        db,
        actor,
        "workspace.created",
        workspace_id=workspace.id,
        target_type="workspace",
        target_id=workspace.id,
        data={"name": name},
    )
    await db.commit()
    return workspace, Role.OWNER


async def member_count(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Membership)
                .where(Membership.workspace_id == workspace_id)
            )
        ).scalar_one()
    )


async def update_workspace(
    db: AsyncSession, ctx: WorkspaceContext, name: str | None, slug: str | None
) -> Workspace:
    workspace = ctx.workspace
    changes: dict[str, str] = {}
    if name is not None and name != workspace.name:
        changes["name"] = name
        workspace.name = name
    if slug is not None and slug != workspace.slug:
        if not await _slug_available(db, slug, exclude=workspace.id):
            raise ValidationFailed(
                errors=[{"field": "slug", "code": "taken", "message": "This URL is already taken."}]
            )
        changes["slug"] = slug
        workspace.slug = slug
    if changes:
        await record_for(
            db,
            ctx.actor,
            "workspace.updated",
            workspace_id=workspace.id,
            target_type="workspace",
            target_id=workspace.id,
            data=changes,
        )
    await db.commit()
    return workspace


async def delete_workspace(db: AsyncSession, ctx: WorkspaceContext, confirm_name: str) -> None:
    if confirm_name.strip() != ctx.workspace.name:
        raise ValidationFailed(
            errors=[
                {
                    "field": "confirm_name",
                    "code": "mismatch",
                    "message": "Type the workspace name exactly to confirm.",
                }
            ]
        )
    workspace_id = ctx.workspace.id
    # Kept at instance level (workspace_id NULL) so the deletion itself stays auditable.
    await record_for(
        db,
        ctx.actor,
        "workspace.deleted",
        target_type="workspace",
        target_id=workspace_id,
        data={"name": ctx.workspace.name},
    )
    await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
    await db.commit()


# ---------------------------------------------------------------- members


async def list_members(db: AsyncSession, workspace_id: uuid.UUID) -> list[tuple[Membership, User]]:
    rows = (
        await db.execute(
            select(Membership, User)
            .join(User, User.id == Membership.user_id)
            .where(Membership.workspace_id == workspace_id)
            .order_by(Membership.created_at)
        )
    ).all()
    return [(m, u) for m, u in rows]


async def _membership(db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID) -> Membership:
    membership = (
        await db.execute(
            select(Membership)
            .where(Membership.workspace_id == workspace_id, Membership.user_id == user_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if membership is None:
        raise NotFound("Member not found")
    return membership


async def change_role(
    db: AsyncSession, ctx: WorkspaceContext, user_id: uuid.UUID, role: str
) -> Membership:
    membership = await _membership(db, ctx.workspace_id, user_id)
    if membership.role == Role.OWNER:
        raise Forbidden(
            "The owner's role changes only through an ownership transfer.", code="owner_immutable"
        )
    if ctx.actor.user_id == user_id:
        raise Forbidden("You cannot change your own role.", code="self_role_change")
    previous = membership.role
    membership.role = role
    await record_for(
        db,
        ctx.actor,
        "member.role_changed",
        workspace_id=ctx.workspace_id,
        target_type="user",
        target_id=user_id,
        data={"from": previous, "to": role},
    )
    await db.commit()
    return membership


async def remove_member(db: AsyncSession, ctx: WorkspaceContext, user_id: uuid.UUID) -> None:
    membership = await _membership(db, ctx.workspace_id, user_id)
    if membership.role == Role.OWNER:
        raise Forbidden("Transfer ownership before removing the owner.", code="owner_immutable")
    await db.delete(membership)
    await record_for(
        db,
        ctx.actor,
        "member.removed",
        workspace_id=ctx.workspace_id,
        target_type="user",
        target_id=user_id,
    )
    await db.commit()


async def leave_workspace(db: AsyncSession, ctx: WorkspaceContext) -> None:
    if ctx.actor.user_id is None:
        raise Forbidden()
    if ctx.role == Role.OWNER:
        raise Forbidden(
            "Transfer ownership before leaving this workspace.", code="owner_cannot_leave"
        )
    membership = await _membership(db, ctx.workspace_id, ctx.actor.user_id)
    await db.delete(membership)
    await record_for(
        db,
        ctx.actor,
        "member.left",
        workspace_id=ctx.workspace_id,
        target_type="user",
        target_id=ctx.actor.user_id,
    )
    await db.commit()


async def transfer_ownership(
    db: AsyncSession, ctx: WorkspaceContext, new_owner_id: uuid.UUID
) -> None:
    if ctx.actor.user_id is None or new_owner_id == ctx.actor.user_id:
        raise BadRequest("Choose another member as the new owner.", code="invalid_target")
    target = await _membership(db, ctx.workspace_id, new_owner_id)
    current = await _membership(db, ctx.workspace_id, ctx.actor.user_id)
    target.role = Role.OWNER
    current.role = Role.ADMIN
    ctx.workspace.owner_id = new_owner_id
    await record_for(
        db,
        ctx.actor,
        "workspace.ownership_transferred",
        workspace_id=ctx.workspace_id,
        target_type="user",
        target_id=new_owner_id,
    )
    await db.commit()


# ---------------------------------------------------------------- invitations


def invitation_status(invitation: Invitation) -> str:
    if invitation.status == InvitationStatus.PENDING and invitation.expires_at <= utcnow():
        return "expired"
    return invitation.status


async def _send_invitation(
    db: AsyncSession, invitation: Invitation, workspace: Workspace, inviter: User | None, token: str
) -> None:
    recipient = (
        await db.execute(select(User).where(User.email == invitation.email))
    ).scalar_one_or_none()
    locale = recipient.locale if recipient else (inviter.locale if inviter else "en")
    await queue_email(
        db,
        to=invitation.email,
        template="invitation",
        locale=locale,
        context={
            "inviter": inviter.display_name if inviter else "Gouvra",
            "workspace": workspace.name,
            "role": invitation.role,
            "email": invitation.email,
            "expires": invitation.expires_at.strftime("%Y-%m-%d"),
        },
        action_url=app_link("/invite", token),
        meta={"workspace_id": str(workspace.id)},
    )
    invitation.last_sent_at = utcnow()


async def create_invitation(
    db: AsyncSession, ctx: WorkspaceContext, email: str, role: str
) -> Invitation:
    already_member = (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .join(User, User.id == Membership.user_id)
            .where(Membership.workspace_id == ctx.workspace_id, User.email == email)
        )
    ).scalar_one()
    if already_member:
        raise Conflict("This person is already a member.", code="already_member")
    from gouvra.modules.usage.limits import require_capacity

    await require_capacity(db, ctx.workspace_id, "members")
    # A new invitation supersedes any pending one for the same address ("re-invite").
    await db.execute(
        update(Invitation)
        .where(
            Invitation.workspace_id == ctx.workspace_id,
            Invitation.email == email,
            Invitation.status == InvitationStatus.PENDING,
        )
        .values(status=InvitationStatus.REVOKED)
    )
    token = new_token()
    invitation = Invitation(
        workspace_id=ctx.workspace_id,
        email=email,
        role=role,
        token_hash=hash_token(token),
        status=InvitationStatus.PENDING,
        invited_by_id=ctx.actor.user_id,
        expires_at=utcnow() + INVITATION_TTL,
    )
    db.add(invitation)
    try:
        await db.flush()
    except IntegrityError as exc:
        raise Conflict(
            "An invitation is already pending for this address.", code="invitation_pending"
        ) from exc
    await _send_invitation(db, invitation, ctx.workspace, ctx.actor.user, token)
    await record_for(
        db,
        ctx.actor,
        "invitation.created",
        workspace_id=ctx.workspace_id,
        target_type="invitation",
        target_id=invitation.id,
        data={"email": email, "role": role},
    )
    await db.commit()
    return invitation


async def list_invitations(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[Invitation, str | None]]:
    rows = (
        await db.execute(
            select(Invitation, User.display_name)
            .outerjoin(User, User.id == Invitation.invited_by_id)
            .where(
                Invitation.workspace_id == workspace_id,
                Invitation.status == InvitationStatus.PENDING,
            )
            .order_by(Invitation.created_at.desc())
        )
    ).all()
    return [(i, name) for i, name in rows]


async def _workspace_invitation(
    db: AsyncSession, ctx: WorkspaceContext, invitation_id: uuid.UUID
) -> Invitation:
    invitation = (
        await db.execute(
            select(Invitation)
            .where(Invitation.id == invitation_id, Invitation.workspace_id == ctx.workspace_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if invitation is None or invitation.status != InvitationStatus.PENDING:
        raise NotFound("Invitation not found")
    return invitation


async def revoke_invitation(
    db: AsyncSession, ctx: WorkspaceContext, invitation_id: uuid.UUID
) -> None:
    invitation = await _workspace_invitation(db, ctx, invitation_id)
    invitation.status = InvitationStatus.REVOKED
    await record_for(
        db,
        ctx.actor,
        "invitation.revoked",
        workspace_id=ctx.workspace_id,
        target_type="invitation",
        target_id=invitation.id,
    )
    await db.commit()


async def resend_invitation(
    db: AsyncSession, ctx: WorkspaceContext, invitation_id: uuid.UUID
) -> Invitation:
    invitation = await _workspace_invitation(db, ctx, invitation_id)
    token = new_token()
    invitation.token_hash = hash_token(token)
    invitation.expires_at = utcnow() + INVITATION_TTL
    await _send_invitation(db, invitation, ctx.workspace, ctx.actor.user, token)
    await record_for(
        db,
        ctx.actor,
        "invitation.resent",
        workspace_id=ctx.workspace_id,
        target_type="invitation",
        target_id=invitation.id,
    )
    await db.commit()
    return invitation


async def invitation_by_token(
    db: AsyncSession, token: str
) -> tuple[Invitation, Workspace, str | None]:
    row = (
        await db.execute(
            select(Invitation, Workspace, User.display_name)
            .join(Workspace, Workspace.id == Invitation.workspace_id)
            .outerjoin(User, User.id == Invitation.invited_by_id)
            .where(Invitation.token_hash == hash_token(token))
        )
    ).first()
    if row is None:
        raise Gone("This invitation is invalid or has expired.", code="invitation_invalid")
    return row[0], row[1], row[2]


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:1]}{'•' * max(1, min(len(local) - 1, 6))}@{domain}"


async def accept_invitation(db: AsyncSession, actor: Actor, token: str) -> tuple[Workspace, str]:
    if actor.user is None:
        raise Forbidden()
    invitation, workspace, _ = await invitation_by_token(db, token)
    if invitation_status(invitation) != InvitationStatus.PENDING:
        raise Gone("This invitation is invalid or has expired.", code="invitation_invalid")
    if invitation.email.lower() != actor.user.email.lower():
        raise Forbidden(
            "This invitation was sent to another address. Sign in with that address to accept it.",
            code="invitation_email_mismatch",
        )
    existing = (
        await db.execute(
            select(Membership).where(
                Membership.workspace_id == workspace.id, Membership.user_id == actor.user.id
            )
        )
    ).scalar_one_or_none()
    role = existing.role if existing else invitation.role
    if existing is None:
        db.add(Membership(workspace_id=workspace.id, user_id=actor.user.id, role=invitation.role))
    invitation.status = InvitationStatus.ACCEPTED
    invitation.accepted_at = utcnow()
    invitation.accepted_by_id = actor.user.id
    await record_for(
        db,
        actor,
        "invitation.accepted",
        workspace_id=workspace.id,
        target_type="invitation",
        target_id=invitation.id,
    )
    await db.commit()
    return workspace, role


async def dismiss_onboarding(db: AsyncSession, ctx: WorkspaceContext) -> None:
    ctx.workspace.onboarding_dismissed_at = utcnow()
    await db.commit()
