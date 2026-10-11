"""Retention policies, exports and instance administration."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import subprocess
import sys
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from gouvra.core.config import BillingProviderKind, get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.billing.service import plan_of
from gouvra.modules.executions.models import Execution, UsageRecord
from gouvra.modules.identity.models import User
from gouvra.modules.retention.service import purge_workspace
from gouvra.modules.workspaces.models import Workspace
from tests.helpers import Account, Outbox, add_member, create_agent, drain, launch, signup

pytestmark = pytest.mark.usefixtures("outbox")


async def test_retention_purges_old_runs_but_keeps_usage(
    lab: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    settings_url = f"/api/v1/workspaces/{ws['id']}/settings"
    current = (await owner.client.get(settings_url)).json()
    assert (current["retention_days"], current["audit_retention_days"]) == (365, 365)
    old = await launch(owner, agent["id"], "old run")
    recent = await launch(owner, agent["id"], "recent run")
    await drain()
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Execution)
            .where(Execution.id == old["id"])
            .values(created_at=utcnow() - timedelta(days=40))
        )
        await db.commit()
    changed = await owner.client.patch(settings_url, json={"retention_days": 30})
    assert changed.json()["retention_days"] == 30
    async with get_sessionmaker()() as db:
        workspace = await db.get(Workspace, ws["id"])
        assert workspace is not None
        counts = await purge_workspace(db, workspace, await plan_of(db, workspace.id))
        assert counts == {"executions": 1}
        assert await db.get(Execution, old["id"]) is None
        assert await db.get(Execution, recent["id"]) is not None
        usage = (
            await db.execute(select(UsageRecord).where(UsageRecord.workspace_id == ws["id"]))
        ).scalars()
        kept = list(usage)
        assert len(kept) == 2  # usage history survives, without content
        assert {u.execution_id is None for u in kept} == {True, False}

    # A plan bounds retention.
    monkeypatch.setattr(get_settings(), "billing_provider", BillingProviderKind.SIMULATED)
    refused = await owner.client.patch(settings_url, json={"retention_days": 90})
    assert refused.status_code == 422
    assert refused.json()["errors"][0]["code"] == "plan_limit"
    assert (await owner.client.get(settings_url)).json()["retention_days_max"] == 30


async def test_exports_hold_no_secret_and_neutralise_formulas(
    lab: dict[str, Any], make_client: Any, outbox: Outbox
) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    formula = await create_agent(owner, ws["id"], lab["provider"]["id"], name="=HYPERLINK(1)")
    tool = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/tools",
        json={
            "kind": "http",
            "name": "crm_lookup",
            "display_name": "CRM lookup",
            "description": "Find a customer.",
            "input_schema": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "additionalProperties": False,
            },
            "config": {
                "method": "GET",
                "url": "https://crm.example.com/customers",
                "allowed_hosts": ["crm.example.com"],
                "auth": {"type": "bearer"},
            },
            "secret": "super-secret-token-123",
        },
    )
    assert tool.status_code == 201, tool.text
    hook = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/automations",
        json={
            "name": "Hook",
            "kind": "webhook",
            "target_type": "agent",
            "agent_id": lab["agent"]["id"],
        },
    )
    await launch(owner, formula["id"], "count")
    await drain()

    exported = await owner.client.get(f"/api/v1/workspaces/{ws['id']}/exports/configuration")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    text = exported.text
    document = json.loads(text)
    assert document["format"] == "gouvra.export/v1"
    assert {a["name"] for a in document["agents"]} >= {"Helper", "=HYPERLINK(1)"}
    assert "crm_lookup" in {t["name"] for t in document["tools"]}
    for secret in ("super-secret-token-123", hook.json()["secret"], hook.json()["hook_url"]):
        assert secret not in text

    runs = await owner.client.get(f"/api/v1/workspaces/{ws['id']}/exports/executions.csv")
    assert runs.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(runs.text)))
    assert rows[0][:3] == ["id", "created_at", "agent"]
    assert any(row[2] == "'=HYPERLINK(1)" for row in rows[1:])  # formula neutralised
    usage = await owner.client.get(f"/api/v1/workspaces/{ws['id']}/exports/usage.csv")
    assert next(iter(csv.reader(io.StringIO(usage.text))))[0] == "date"

    viewer = await signup(make_client(), outbox, "reader@example.com")
    await add_member(owner, ws["id"], viewer, outbox, "viewer")
    assert (
        await viewer.client.get(f"/api/v1/workspaces/{ws['id']}/exports/configuration")
    ).status_code == 403
    audit = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events")).json()
    kinds = [e["data"].get("kind") for e in audit["data"] if e["action"] == "export.created"]
    assert sorted(kinds) == ["configuration", "executions", "usage"]


async def _promote(account: Account) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(User).where(User.id == account.user_id).values(is_superadmin=True))
        await db.commit()


async def test_instance_administration(
    lab: dict[str, Any], make_client: Any, outbox: Outbox
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    assert (await owner.client.get("/api/v1/admin/overview")).status_code == 404  # not an admin
    admin = await signup(make_client(), outbox, "root@example.com", name="Root")
    await _promote(admin)

    overview = (await admin.client.get("/api/v1/admin/overview")).json()
    assert overview["users"] >= 2
    assert overview["workspaces"] >= 1
    assert overview["billing_provider"] == "none"
    listed = (await admin.client.get("/api/v1/admin/workspaces", params={"q": ws["name"]})).json()
    entry = next(w for w in listed if w["id"] == ws["id"])
    assert (entry["owner_email"], entry["status"], entry["plan"]) == (
        owner.email,
        "active",
        "self_hosted",
    )

    suspended = await admin.client.patch(
        f"/api/v1/admin/workspaces/{ws['id']}", json={"status": "suspended"}
    )
    assert suspended.json()["status"] == "suspended"
    blocked = await owner.client.post(
        f"/api/v1/agents/{agent['id']}/executions", json={"input": "x"}
    )
    assert (blocked.status_code, blocked.json()["code"]) == (403, "workspace_suspended")
    assert (await owner.client.get(f"/api/v1/agents/{agent['id']}")).status_code == 200  # read-only
    await admin.client.patch(
        f"/api/v1/admin/workspaces/{ws['id']}", json={"status": "active", "plan": "business"}
    )
    assert (
        await owner.client.post(f"/api/v1/agents/{agent['id']}/executions", json={"input": "x"})
    ).status_code == 202

    victim = await signup(make_client(), outbox, "leaver@example.com")
    users = (await admin.client.get("/api/v1/admin/users", params={"q": "leaver"})).json()
    assert [u["email"] for u in users] == ["leaver@example.com"]
    disabled = await admin.client.patch(
        f"/api/v1/admin/users/{victim.user_id}", json={"status": "disabled"}
    )
    assert disabled.json()["status"] == "disabled"
    assert (await victim.client.get("/api/v1/me")).status_code == 401  # signed out everywhere
    myself = await admin.client.patch(
        f"/api/v1/admin/users/{admin.user_id}", json={"status": "disabled"}
    )
    assert myself.json()["code"] == "self_disable"

    audit = (await admin.client.get("/api/v1/admin/audit-events", params={"limit": 50})).json()
    actions = {e["action"] for e in audit["data"]}
    assert {
        "admin.workspace_suspended",
        "admin.workspace_restored",
        "admin.plan_granted",
        "admin.user_disabled",
    } <= actions


async def test_create_superadmin_command(make_client: Any, outbox: Outbox) -> None:
    """The command runs in a process of its own: it must know every table before it writes."""
    account = await signup(make_client(), outbox, "boss@example.com")
    assert (await account.client.get("/api/v1/admin/overview")).status_code == 404
    command = [sys.executable, "-m", "gouvra.cli", "create-superadmin", account.email]
    done = await asyncio.to_thread(
        subprocess.run, command, capture_output=True, text=True, timeout=120, check=False
    )
    assert done.returncode == 0, done.stderr
    assert (await account.client.get("/api/v1/admin/overview")).status_code == 200
    unknown = await asyncio.to_thread(
        subprocess.run,
        [*command[:-1], "nobody@example.com"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert unknown.returncode == 1
    assert "Sign up first" in unknown.stderr
