"""Workspaces, roles, members, invitations, ownership, onboarding and service keys."""

from __future__ import annotations

import itertools
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from gouvra.core.authz import ROLE_PERMISSIONS, Permission
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.audit.models import AuditEvent
from gouvra.modules.workspaces.models import Invitation, Role
from tests.helpers import Outbox, add_member, create_workspace, signup

pytestmark = pytest.mark.usefixtures("outbox")


async def test_create_and_list_workspaces(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "owner@example.com")
    first = await create_workspace(owner, "Acme Research")
    assert first["slug"] == "acme-research"
    assert first["role"] == "owner"
    assert "workspace:delete" in first["permissions"]
    second = await create_workspace(owner, "Acme Research")
    assert second["slug"].startswith("acme-research-")
    assert second["slug"] != first["slug"]
    listing = (await owner.client.get("/api/v1/workspaces")).json()
    assert {w["id"] for w in listing} == {first["id"], second["id"]}
    session = (await owner.client.get("/api/v1/auth/session")).json()
    assert len(session["workspaces"]) == 2


async def test_slug_rules(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "slugs@example.com")
    assert (
        await owner.client.post("/api/v1/workspaces", json={"name": "X", "slug": "admin"})
    ).status_code == 422
    assert (
        await owner.client.post("/api/v1/workspaces", json={"name": "Bad", "slug": "Not Valid!"})
    ).status_code == 422
    ok = await owner.client.post("/api/v1/workspaces", json={"name": "Été Studio"})
    assert ok.json()["slug"] == "ete-studio"
    taken = await owner.client.post(
        "/api/v1/workspaces", json={"name": "Other", "slug": "ete-studio"}
    )
    assert taken.status_code == 422
    assert taken.json()["errors"][0]["code"] == "taken"


async def test_role_matrix_is_monotonic() -> None:
    order = [Role.VIEWER, Role.MEMBER, Role.ADMIN, Role.OWNER]
    for lower, higher in itertools.pairwise(order):
        assert ROLE_PERMISSIONS[lower] <= ROLE_PERMISSIONS[higher]
    assert Permission.EXECUTIONS_LAUNCH not in ROLE_PERMISSIONS[Role.VIEWER]
    assert Permission.PROVIDERS_MANAGE not in ROLE_PERMISSIONS[Role.MEMBER]
    assert Permission.WORKSPACE_DELETE not in ROLE_PERMISSIONS[Role.ADMIN]


async def test_permissions_are_enforced_server_side(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "boss@example.com")
    ws = await create_workspace(owner, "Perms")
    viewer = await signup(make_client(), outbox, "viewer@example.com")
    member = await signup(make_client(), outbox, "member@example.com")
    admin = await signup(make_client(), outbox, "admin@example.com")
    await add_member(owner, ws["id"], viewer, outbox, "viewer")
    await add_member(owner, ws["id"], member, outbox, "member")
    await add_member(owner, ws["id"], admin, outbox, "admin")
    base = f"/api/v1/workspaces/{ws['id']}"

    assert (await viewer.client.get(base)).status_code == 200
    assert (await viewer.client.patch(base, json={"name": "Hacked"})).status_code == 403
    assert (
        await member.client.post(f"{base}/invitations", json={"email": "x@example.com"})
    ).status_code == 403
    assert (
        await admin.client.post(f"{base}/invitations", json={"email": "x@example.com"})
    ).status_code == 201
    assert (
        await admin.client.post(f"{base}/delete", json={"confirm_name": "Perms"})
    ).status_code == 403
    assert (await admin.client.patch(base, json={"name": "Renamed"})).status_code == 200
    denied = await member.client.patch(f"{base}/members/{viewer.user_id}", json={"role": "admin"})
    assert denied.status_code == 403
    assert denied.json()["details"]["permission"] == "members:manage"


async def test_member_management(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "o@example.com")
    ws = await create_workspace(owner, "Team")
    alice = await signup(make_client(), outbox, "alice@example.com")
    bob = await signup(make_client(), outbox, "bob@example.com")
    await add_member(owner, ws["id"], alice, outbox, "admin")
    await add_member(owner, ws["id"], bob, outbox, "member")
    base = f"/api/v1/workspaces/{ws['id']}/members"

    members = (await owner.client.get(base)).json()
    assert {m["email"]: m["role"] for m in members} == {
        "o@example.com": "owner",
        "alice@example.com": "admin",
        "bob@example.com": "member",
    }
    assert (await alice.client.patch(f"{base}/{bob.user_id}", json={"role": "viewer"})).json()[
        "role"
    ] == "viewer"
    owner_change = await alice.client.patch(f"{base}/{owner.user_id}", json={"role": "viewer"})
    assert owner_change.status_code == 403
    assert owner_change.json()["code"] == "owner_immutable"
    assert (await alice.client.patch(f"{base}/{alice.user_id}", json={"role": "viewer"})).json()[
        "code"
    ] == "self_role_change"
    assert (
        await owner.client.patch(f"{base}/{bob.user_id}", json={"role": "owner"})
    ).status_code == 422

    # Leaving and removing.
    assert (await bob.client.delete(f"{base}/{bob.user_id}")).status_code == 204
    assert (await bob.client.get(f"/api/v1/workspaces/{ws['id']}")).status_code == 404
    assert (await owner.client.delete(f"{base}/{owner.user_id}")).json()[
        "code"
    ] == "owner_cannot_leave"
    assert (await owner.client.delete(f"{base}/{alice.user_id}")).status_code == 204
    assert (await alice.client.get(f"/api/v1/workspaces/{ws['id']}")).status_code == 404


async def test_ownership_transfer(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "first@example.com")
    ws = await create_workspace(owner, "Handover")
    heir = await signup(make_client(), outbox, "heir@example.com")
    await add_member(owner, ws["id"], heir, outbox, "member")
    base = f"/api/v1/workspaces/{ws['id']}"
    assert (
        await heir.client.post(f"{base}/transfer-ownership", json={"user_id": heir.user_id})
    ).status_code == 403
    assert (
        await owner.client.post(f"{base}/transfer-ownership", json={"user_id": heir.user_id})
    ).status_code == 204
    roles = {m["email"]: m["role"] for m in (await heir.client.get(f"{base}/members")).json()}
    assert roles == {"first@example.com": "admin", "heir@example.com": "owner"}
    assert (await heir.client.get(base)).json()["role"] == "owner"


async def test_delete_workspace_requires_exact_name(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "del@example.com")
    ws = await create_workspace(owner, "Doomed")
    base = f"/api/v1/workspaces/{ws['id']}"
    assert (
        await owner.client.post(f"{base}/delete", json={"confirm_name": "doomed"})
    ).status_code == 422
    assert (
        await owner.client.post(f"{base}/delete", json={"confirm_name": "Doomed"})
    ).status_code == 204
    assert (await owner.client.get(base)).status_code == 404
    async with get_sessionmaker()() as db:
        event = (
            await db.execute(select(AuditEvent).where(AuditEvent.action == "workspace.deleted"))
        ).scalar_one()
        assert event.target_id == ws["id"]


async def test_invitation_lifecycle(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "host@example.com", "Hostess")
    ws = await create_workspace(owner, "Guild")
    base = f"/api/v1/workspaces/{ws['id']}/invitations"
    created = await owner.client.post(base, json={"email": "guest@example.com", "role": "viewer"})
    assert created.status_code == 201
    invitation = created.json()
    assert invitation["status"] == "pending"
    mail = await outbox.last_to("guest@example.com")
    assert "Guild" in mail.subject
    assert "Hostess" in mail.subject
    token = await outbox.token_for("guest@example.com")

    stranger = make_client()
    preview = await stranger.post("/api/v1/invitations/preview", json={"token": token})
    assert preview.status_code == 200
    assert preview.json()["workspace_name"] == "Guild"
    assert preview.json()["email_hint"].startswith("g")
    assert "guest" not in preview.json()["email_hint"]

    # Only the invited address can accept.
    intruder = await signup(make_client(), outbox, "intruder@example.com")
    wrong = await intruder.client.post("/api/v1/invitations/accept", json={"token": token})
    assert wrong.status_code == 403
    assert wrong.json()["code"] == "invitation_email_mismatch"
    assert (
        await stranger.post("/api/v1/invitations/accept", json={"token": token})
    ).status_code == 401

    guest = await signup(make_client(), outbox, "guest@example.com")
    # The verification mail is the latest one now; reuse the invitation token captured above.
    accepted = await guest.client.post("/api/v1/invitations/accept", json={"token": token})
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "viewer"
    assert (
        await guest.client.post("/api/v1/invitations/accept", json={"token": token})
    ).status_code == 410
    assert (await owner.client.get(base)).json() == []
    again = await owner.client.post(base, json={"email": "guest@example.com"})
    assert again.status_code == 409
    assert again.json()["code"] == "already_member"


async def test_invitations_expire_and_can_be_revoked_or_resent(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "inv@example.com")
    ws = await create_workspace(owner, "Expiry")
    base = f"/api/v1/workspaces/{ws['id']}/invitations"
    invitation = (await owner.client.post(base, json={"email": "late@example.com"})).json()
    old_token = await outbox.token_for("late@example.com")
    async with get_sessionmaker()() as db:
        await db.execute(update(Invitation).values(expires_at=utcnow() - timedelta(minutes=1)))
        await db.commit()
    listed = (await owner.client.get(base)).json()
    assert listed[0]["status"] == "expired"
    late = await signup(make_client(), outbox, "late@example.com")
    assert (
        await late.client.post("/api/v1/invitations/accept", json={"token": old_token})
    ).status_code == 410

    resent = await owner.client.post(f"{base}/{invitation['id']}/resend")
    assert resent.status_code == 200
    assert resent.json()["status"] == "pending"
    new_token = await outbox.token_for("late@example.com")
    assert new_token != old_token
    assert (await owner.client.delete(f"{base}/{invitation['id']}")).status_code == 204
    assert (
        await late.client.post("/api/v1/invitations/accept", json={"token": new_token})
    ).status_code == 410
    assert (await owner.client.delete(f"{base}/{invitation['id']}")).status_code == 404


async def test_onboarding_checklist(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "new@example.com")
    ws = await create_workspace(owner, "Fresh")
    base = f"/api/v1/workspaces/{ws['id']}/onboarding"
    checklist = (await owner.client.get(base)).json()
    steps = {s["key"]: s for s in checklist["steps"]}
    assert steps["create_workspace"]["done"] is True
    assert steps["invite_teammate"] == {"key": "invite_teammate", "done": False, "optional": True}
    assert checklist["dismissed"] is False
    await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/invitations", json={"email": "mate@example.com"}
    )
    assert {s["key"]: s["done"] for s in (await owner.client.get(base)).json()["steps"]}[
        "invite_teammate"
    ] is True
    assert (await owner.client.post(f"{base}/dismiss")).status_code == 204
    assert (await owner.client.get(base)).json()["dismissed"] is True


async def test_service_keys(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "keys@example.com")
    ws = await create_workspace(owner, "Robots")
    other_ws = await create_workspace(owner, "Elsewhere")
    base = f"/api/v1/workspaces/{ws['id']}/api-keys"
    created = await owner.client.post(
        base, json={"name": "CI", "role": "viewer", "expires_in_days": 30}
    )
    assert created.status_code == 201
    key = created.json()["key"]
    assert key.startswith("gvr_live_")
    listed = (await owner.client.get(base)).json()
    assert "key" not in listed[0]
    assert listed[0]["prefix"] == key[:13]

    robot = make_client(csrf=False)
    robot.headers["Authorization"] = f"Bearer {key}"
    assert (await robot.get(f"/api/v1/workspaces/{ws['id']}")).status_code == 200
    assert (await robot.get(f"/api/v1/workspaces/{other_ws['id']}")).status_code == 404
    assert (
        await robot.patch(f"/api/v1/workspaces/{ws['id']}", json={"name": "x"})
    ).status_code == 403
    assert (await robot.get("/api/v1/workspaces")).json()[0]["id"] == ws["id"]
    assert (await robot.post("/api/v1/workspaces", json={"name": "Robot-made"})).status_code == 403

    assert (await owner.client.delete(f"{base}/{created.json()['id']}")).status_code == 204
    revoked = await robot.get(f"/api/v1/workspaces/{ws['id']}")
    assert revoked.status_code == 401
    assert revoked.json()["code"] == "invalid_api_key"
    robot.headers["Authorization"] = "Bearer gvr_live_" + "x" * 43
    assert (await robot.get(f"/api/v1/workspaces/{ws['id']}")).status_code == 401


async def test_sensitive_actions_are_audited(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "audit@example.com")
    ws = await create_workspace(owner, "Audited")
    await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/invitations",
        json={"email": "aud@example.com", "role": "admin"},
    )
    async with get_sessionmaker()() as db:
        actions = set((await db.execute(select(AuditEvent.action))).scalars())
        assert {
            "user.registered",
            "user.email_verified",
            "user.signed_in",
            "workspace.created",
            "invitation.created",
        } <= actions
        rows = (await db.execute(select(AuditEvent))).scalars().all()
        assert all(
            row.request_id for row in rows if row.action != "user.registered" or row.request_id
        )
