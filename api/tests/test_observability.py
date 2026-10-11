"""Phase 4: overview, usage aggregates, agent stats, audit log, export, settings, tool history."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import update

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.executions.models import UsageRecord
from tests.helpers import Outbox, add_member, drain, launch, signup

pytestmark = pytest.mark.usefixtures("outbox")


async def _price_usage(amount: str) -> None:
    """The scripted model has no public price; give some calls a cost to test the aggregates."""
    async with get_sessionmaker()() as db:
        await db.execute(
            update(UsageRecord).values(
                cost_amount=Decimal(amount), cost_currency="USD", cost_source="estimated"
            )
        )
        await db.commit()


async def test_overview_reports_known_metrics_only(lab: dict[str, Any]) -> None:
    owner, ws = lab["owner"], lab["ws"]
    empty = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/overview")).json()
    assert empty["success_rate_7d"] is None  # no data: no fake 0 %
    assert empty["month_cost"]["source"] == "unavailable"
    assert empty["month_cost"]["amount"] is None
    await launch(owner, lab["agent"]["id"], "ok one")
    await launch(owner, lab["agent"]["id"], "[fail:provider_unavailable]")
    await launch(owner, lab["agent"]["id"], "still queued")
    await drain()
    await launch(owner, lab["agent"]["id"], "queued later")
    data = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/overview")).json()
    assert data["agents_active"] == 1
    assert data["providers_configured"] == 1
    assert data["executions_24h"]["succeeded"] == 2
    assert data["executions_24h"]["failed"] == 1
    assert data["queued_now"] == 1
    assert data["success_rate_7d"] == round(2 / 3, 4)
    assert data["duration_7d"]["p50_ms"] is not None
    assert data["month_tokens"]["model_calls"] == 2  # a failed provider call consumes nothing
    assert [e["status"] for e in data["recent_failures"]] == ["failed"]
    assert data["recent_failures"][0]["error_code"] == "provider_unavailable"
    assert len(data["recent_executions"]) == 4


async def test_usage_aggregates_with_partial_costs(lab: dict[str, Any]) -> None:
    owner, ws = lab["owner"], lab["ws"]
    await launch(owner, lab["agent"]["id"], "priced")
    await drain()
    await _price_usage("0.0125")
    await launch(owner, lab["agent"]["id"], "unpriced")
    await drain()
    data = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/usage")).json()
    assert Decimal(data["cost"]["amount"]) == Decimal("0.0125")
    assert data["cost"]["partial"] is True  # one call had no price: the total is a lower bound
    assert data["cost"]["source"] == "estimated"
    assert data["tokens"]["model_calls"] == 2
    assert data["executions"]["succeeded"] == 2
    today = [p for p in data["series"] if p["executions"]]
    assert today[0]["unpriced_calls"] == 1
    assert data["by_agent"][0]["agent_name"] == "Helper"
    assert data["by_model"][0]["model"] == "gouvra-test-1"
    assert data["limits"]["max_concurrent_executions"] >= 1
    hourly = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/usage",
            params={"granularity": "hour", "since": (utcnow() - timedelta(hours=3)).isoformat()},
        )
    ).json()
    assert len(hourly["series"]) in (3, 4)
    bad = await owner.client.get(
        f"/api/v1/workspaces/{ws['id']}/usage",
        params={"since": utcnow().isoformat(), "until": (utcnow() - timedelta(days=1)).isoformat()},
    )
    assert bad.status_code == 400


async def test_agent_stats(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    await launch(owner, lab["agent"]["id"], "a")
    await launch(owner, lab["agent"]["id"], "[fail:provider_timeout]")
    await drain()
    stats = (
        await owner.client.get(f"/api/v1/agents/{lab['agent']['id']}/stats", params={"days": 7})
    ).json()
    assert stats["executions"]["succeeded"] == 1
    assert stats["executions"]["failed"] == 1
    assert stats["success_rate"] == 0.5
    assert stats["cost"]["source"] == "unavailable"


async def test_audit_log_is_admin_only_and_filterable(
    lab: dict[str, Any], make_client, outbox: Outbox
) -> None:  # type: ignore[no-untyped-def]
    owner, ws = lab["owner"], lab["ws"]
    member = await signup(make_client(), outbox, "audit-member@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")
    assert (
        await member.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events")
    ).status_code == 403
    page = (
        await owner.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events", params={"limit": 50})
    ).json()
    actions = {e["action"] for e in page["data"]}
    assert {
        "workspace.created",
        "provider.created",
        "tool.created",
        "agent.created",
        "invitation.created",
    } <= actions
    only_agents = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/audit-events", params={"action": "agent."}
        )
    ).json()["data"]
    assert {e["action"] for e in only_agents} == {"agent.created"}
    assert all(e["actor"] for e in page["data"])


async def test_execution_export(lab: dict[str, Any], make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = lab["owner"]
    queued = await launch(
        owner, lab["agent"]["id"], 'export [tool:calculator {"expression": "2*21"}]'
    )
    await drain()
    exported = await owner.client.get(f"/api/v1/executions/{queued['id']}/export")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    body = exported.json()
    assert body["format"] == "gouvra.execution.v1"
    assert body["execution"]["status"] == "succeeded"
    assert [e["type"] for e in body["events"]][-1] == "execution.succeeded"
    viewer = await signup(make_client(), outbox, "export-viewer@example.com")
    await add_member(owner, lab["ws"]["id"], viewer, outbox, "viewer")
    assert (await viewer.client.get(f"/api/v1/executions/{queued['id']}/export")).status_code == 403


async def test_workspace_concurrency_setting(lab: dict[str, Any]) -> None:
    owner, ws = lab["owner"], lab["ws"]
    url = f"/api/v1/workspaces/{ws['id']}/settings"
    assert (
        await owner.client.patch(url, json={"max_concurrent_executions": 999})
    ).status_code == 422
    updated = (await owner.client.patch(url, json={"max_concurrent_executions": 2})).json()
    assert updated["max_concurrent_executions"] == 2
    assert (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/usage")).json()["limits"][
        "max_concurrent_executions"
    ] == 2


async def test_tool_usage_history(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    await launch(owner, lab["agent"]["id"], '[tool:calculator {"expression": "1+1"}]')
    await launch(owner, lab["agent"]["id"], '[tool:calculator {"bad": 1}]')
    await drain()
    calls = (await owner.client.get(f"/api/v1/tools/{lab['calc']['id']}/calls")).json()
    assert len(calls) == 2
    assert {c["ok"] for c in calls} == {True, False}
    assert {c["error_code"] for c in calls} == {None, "invalid_arguments"}
    assert calls[0]["agent_name"] == "Helper"
