"""Multi-tenant isolation (anti-IDOR).

For every workspace-scoped route, a user from another workspace — even an owner there —
must get 404, never the data and never a 403 that would confirm the resource exists.
Two attacks are covered for each route:
  1. foreign workspace in the path (outsider targets workspace A directly);
  2. own workspace in the path but a foreign resource id (ID mixing).
New resources register their routes in ROUTES and their factories in `world`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import select

from tests.helpers import (
    Account,
    Outbox,
    add_member,
    create_agent,
    create_builtin_tool,
    create_provider,
    create_workspace,
    signup,
)

pytestmark = pytest.mark.usefixtures("outbox")


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    body: dict[str, Any] | None = None
    # Routes addressing a sub-resource are also tested with a foreign id under the own workspace.
    sub_resource: str | None = None


ROUTES: list[Route] = [
    Route("GET", "/workspaces/{ws}"),
    Route("PATCH", "/workspaces/{ws}", {"name": "Owned"}),
    Route("POST", "/workspaces/{ws}/delete", {"confirm_name": "Victim"}),
    Route("GET", "/workspaces/{ws}/members"),
    Route("PATCH", "/workspaces/{ws}/members/{member}", {"role": "admin"}, sub_resource="member"),
    Route("DELETE", "/workspaces/{ws}/members/{member}", sub_resource="member"),
    Route("POST", "/workspaces/{ws}/transfer-ownership", {"user_id": "{member}"}),
    Route("GET", "/workspaces/{ws}/invitations"),
    Route("POST", "/workspaces/{ws}/invitations", {"email": "spy@example.com"}),
    Route("POST", "/workspaces/{ws}/invitations/{invitation}/resend", sub_resource="invitation"),
    Route("DELETE", "/workspaces/{ws}/invitations/{invitation}", sub_resource="invitation"),
    Route("GET", "/workspaces/{ws}/onboarding"),
    Route("POST", "/workspaces/{ws}/onboarding/dismiss"),
    Route("GET", "/workspaces/{ws}/api-keys"),
    Route("POST", "/workspaces/{ws}/api-keys", {"name": "stolen"}),
    Route("DELETE", "/workspaces/{ws}/api-keys/{api_key}", sub_resource="api_key"),
    Route("GET", "/workspaces/{ws}/providers"),
    Route("POST", "/workspaces/{ws}/providers", {"name": "stolen", "kind": "test"}),
    Route("GET", "/workspaces/{ws}/tools"),
    Route(
        "POST",
        "/workspaces/{ws}/tools",
        {"kind": "builtin", "builtin_key": "calculator", "name": "calc_two"},
    ),
    Route("GET", "/workspaces/{ws}/agents"),
    Route("POST", "/workspaces/{ws}/agents", {"name": "Intruder"}),
    Route("GET", "/workspaces/{ws}/executions"),
    Route("GET", "/workspaces/{ws}/stream"),
    Route("GET", "/workspaces/{ws}/overview"),
    Route("GET", "/workspaces/{ws}/usage"),
    Route("GET", "/workspaces/{ws}/audit-events"),
    Route("GET", "/workspaces/{ws}/settings"),
    Route("PATCH", "/workspaces/{ws}/settings", {"max_concurrent_executions": 1}),
    Route("GET", "/workspaces/{ws}/evaluations/suites"),
    Route("POST", "/workspaces/{ws}/evaluations/suites", {"name": "Stolen suite"}),
    Route("GET", "/workspaces/{ws}/evaluations/runs"),
    Route("GET", "/workspaces/{ws}/workflows"),
    Route("POST", "/workspaces/{ws}/workflows", {"name": "Stolen flow"}),
    Route("GET", "/workspaces/{ws}/workflow-runs"),
    Route("GET", "/workspaces/{ws}/registry"),
    Route("GET", "/workspaces/{ws}/billing"),
    Route("POST", "/workspaces/{ws}/billing/checkout", {"plan": "team"}),
    Route("POST", "/workspaces/{ws}/billing/portal"),
    Route("POST", "/workspaces/{ws}/billing/simulated/confirm", {"plan": "team", "token": "x"}),
    Route("POST", "/workspaces/{ws}/billing/simulated/cancel"),
    Route("GET", "/workspaces/{ws}/budget"),
    Route("PUT", "/workspaces/{ws}/budget", {"monthly_limit": "1"}),
    Route("GET", "/workspaces/{ws}/alerts"),
    Route("GET", "/workspaces/{ws}/exports/configuration"),
    Route("GET", "/workspaces/{ws}/exports/executions.csv"),
    Route("GET", "/workspaces/{ws}/exports/usage.csv"),
    # Instance administration: anyone but a super-admin gets 404, owner of the workspace or not.
    Route("PATCH", "/admin/workspaces/{ws}", {"status": "suspended"}),
    Route("GET", "/workspaces/{ws}/connections"),
    Route(
        "POST",
        "/workspaces/{ws}/connections",
        {
            "connector": "slack",
            "name": "Stolen",
            "credentials": {"webhook_url": "https://hooks.slack.com/services/T0/B0/stolen"},
        },
    ),
    Route("GET", "/workspaces/{ws}/automations"),
    Route(
        "POST",
        "/workspaces/{ws}/automations",
        {
            "name": "Stolen",
            "kind": "schedule",
            "target_type": "agent",
            "agent_id": "{agent}",
            "cron": "@daily",
            "input": "x",
        },
    ),
]

# Routes addressing one resource by id (the workspace is derived from the resource).
RESOURCE_ROUTES: list[Route] = [
    Route("GET", "/providers/{provider}"),
    Route("PATCH", "/providers/{provider}", {"name": "pwned"}),
    Route("DELETE", "/providers/{provider}"),
    Route("POST", "/providers/{provider}/test"),
    Route("GET", "/tools/{tool}"),
    Route("PATCH", "/tools/{tool}", {"description": "pwned"}),
    Route("DELETE", "/tools/{tool}"),
    Route("POST", "/tools/{tool}/test", {"arguments": {"expression": "1+1"}}),
    Route("GET", "/agents/{agent}"),
    Route("PATCH", "/agents/{agent}", {"instructions": "pwned"}),
    Route("DELETE", "/agents/{agent}"),
    Route("POST", "/agents/{agent}/duplicate", {}),
    Route("POST", "/agents/{agent}/archive"),
    Route("POST", "/agents/{agent}/restore"),
    Route("GET", "/agents/{agent}/versions"),
    Route("GET", "/agents/{agent}/versions/1"),
    Route("POST", "/agents/{agent}/versions/1/restore"),
    Route("POST", "/agents/{agent}/executions", {"input": "steal"}),
    Route("GET", "/executions/{execution}"),
    Route("GET", "/executions/{execution}/events"),
    Route("GET", "/executions/{execution}/stream"),
    Route("POST", "/executions/{execution}/cancel"),
    Route("POST", "/executions/{execution}/retry"),
    Route("GET", "/executions/{execution}/export"),
    Route("GET", "/agents/{agent}/stats"),
    Route("GET", "/tools/{tool}/calls"),
    Route("GET", "/evaluations/suites/{suite}"),
    Route("PATCH", "/evaluations/suites/{suite}", {"name": "pwned"}),
    Route("DELETE", "/evaluations/suites/{suite}"),
    Route("GET", "/evaluations/suites/{suite}/cases"),
    Route("POST", "/evaluations/suites/{suite}/cases", {"name": "x", "input": "y"}),
    Route(
        "POST", "/evaluations/suites/{suite}/cases/import", {"cases": [{"name": "x", "input": "y"}]}
    ),
    Route("PATCH", "/evaluations/cases/{case}", {"name": "pwned"}),
    Route("DELETE", "/evaluations/cases/{case}"),
    Route("POST", "/evaluations/runs", {"suite_id": "{suite}", "agent_id": "{agent}"}),
    Route("GET", "/evaluations/runs/{run}"),
    Route("POST", "/evaluations/runs/{run}/cancel"),
    Route("GET", "/evaluations/compare?base={run}&candidate={run}"),
    Route("GET", "/workflows/{workflow}"),
    Route("PATCH", "/workflows/{workflow}", {"name": "pwned"}),
    Route("PUT", "/workflows/{workflow}/draft", {"graph": {"nodes": []}, "revision": 1}),
    Route("POST", "/workflows/{workflow}/publish", {}),
    Route("GET", "/workflows/{workflow}/versions"),
    Route("POST", "/workflows/{workflow}/versions/1/restore"),
    Route("POST", "/workflows/{workflow}/archive"),
    Route("POST", "/workflows/{workflow}/restore"),
    Route("DELETE", "/workflows/{workflow}"),
    Route("POST", "/workflows/{workflow}/runs", {"input": "steal"}),
    Route("GET", "/workflow-runs/{wfrun}"),
    Route("POST", "/workflow-runs/{wfrun}/cancel"),
    Route("GET", "/workflow-runs/{wfrun}/stream"),
    Route("GET", "/automations/{automation}"),
    Route("PATCH", "/automations/{automation}", {"enabled": False}),
    Route("DELETE", "/automations/{automation}"),
    Route("POST", "/automations/{automation}/rotate-secret"),
    Route("POST", "/automations/{automation}/run", {}),
    Route("GET", "/automations/{automation}/fires"),
    Route("GET", "/connections/{connection}"),
    Route("PATCH", "/connections/{connection}", {"name": "pwned"}),
    Route("DELETE", "/connections/{connection}"),
    Route("POST", "/connections/{connection}/check"),
    Route("POST", "/alerts/{alert}/dismiss"),
]


@dataclass
class Tenant:
    owner: Account
    member: Account
    ids: dict[str, str]


async def _tenant(make_client: Any, outbox: Outbox, prefix: str, name: str) -> Tenant:
    owner = await signup(make_client(), outbox, f"{prefix}-owner@example.com")
    workspace = await create_workspace(owner, name)
    member = await signup(make_client(), outbox, f"{prefix}-member@example.com")
    await add_member(owner, workspace["id"], member, outbox, "member")
    invitation = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/invitations",
        json={"email": f"{prefix}-pending@example.com"},
    )
    api_key = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/api-keys", json={"name": "ci"}
    )
    provider = await create_provider(owner, workspace["id"])
    tool = await create_builtin_tool(owner, workspace["id"], "calculator")
    agent = await create_agent(owner, workspace["id"], provider["id"], tool_ids=[tool["id"]])
    execution = await owner.client.post(
        f"/api/v1/agents/{agent['id']}/executions", json={"input": "hello"}
    )
    suite = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/evaluations/suites", json={"name": "Quality"}
    )
    case = await owner.client.post(
        f"/api/v1/evaluations/suites/{suite.json()['id']}/cases",
        json={"name": "Greeting", "input": "hi", "expected": "Echo: hi"},
    )
    run = await owner.client.post(
        "/api/v1/evaluations/runs",
        json={"suite_id": suite.json()["id"], "agent_id": agent["id"]},
    )
    workflow = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/workflows",
        json={
            "name": "Flow",
            "graph": {
                "nodes": [
                    {"id": "start", "type": "start", "label": "Input"},
                    {"id": "ask", "type": "agent", "label": "Ask", "agent_id": agent["id"]},
                    {"id": "end", "type": "end", "label": "Output"},
                ],
                "edges": [
                    {"id": "a", "source": "start", "target": "ask"},
                    {"id": "b", "source": "ask", "target": "end"},
                ],
            },
        },
    )
    flow_id = workflow.json()["id"]
    await owner.client.post(f"/api/v1/workflows/{flow_id}/publish", json={})
    wfrun = await owner.client.post(f"/api/v1/workflows/{flow_id}/runs", json={"input": "hi"})
    connection = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/connections",
        json={
            "connector": "slack",
            "name": "Alerts",
            "credentials": {"webhook_url": "https://hooks.slack.com/services/T1/B1/secret"},
        },
    )
    automation = await owner.client.post(
        f"/api/v1/workspaces/{workspace['id']}/automations",
        json={"name": "Hook", "kind": "webhook", "target_type": "agent", "agent_id": agent["id"]},
    )
    from gouvra.core.db import get_sessionmaker
    from gouvra.modules.budgets.models import Alert
    from gouvra.modules.budgets.service import raise_alert

    async with get_sessionmaker()() as db:
        await raise_alert(db, workspace["id"], kind="quota", key=f"probe:{prefix}", level="warning")
        await db.commit()
        alert = (
            await db.execute(select(Alert).where(Alert.workspace_id == workspace["id"]))
        ).scalar_one()
    return Tenant(
        owner=owner,
        member=member,
        ids={
            "ws": workspace["id"],
            "member": member.user_id,
            "invitation": invitation.json()["id"],
            "api_key": api_key.json()["id"],
            "provider": provider["id"],
            "tool": tool["id"],
            "agent": agent["id"],
            "execution": execution.json()["id"],
            "suite": suite.json()["id"],
            "case": case.json()["id"],
            "run": run.json()["id"],
            "workflow": flow_id,
            "wfrun": wfrun.json()["id"],
            "automation": automation.json()["id"],
            "connection": connection.json()["id"],
            "alert": str(alert.id),
        },
    )


@pytest.fixture
async def world(make_client, outbox: Outbox) -> tuple[Tenant, Tenant]:  # type: ignore[no-untyped-def]
    victim = await _tenant(make_client, outbox, "victim", "Victim")
    attacker = await _tenant(make_client, outbox, "attacker", "Attacker")
    return victim, attacker


def _fill(template: str, ids: dict[str, str]) -> str:
    for key, value in ids.items():
        template = template.replace("{" + key + "}", value)
    return template


def _body(route: Route, ids: dict[str, str]) -> dict[str, Any] | None:
    if route.body is None:
        return None
    return {k: _fill(v, ids) if isinstance(v, str) else v for k, v in route.body.items()}


async def _call(account: Account, route: Route, ids: dict[str, str]) -> int:
    path = "/api/v1" + _fill(route.path, ids)
    response = await account.client.request(route.method, path, json=_body(route, ids))
    return response.status_code


@pytest.mark.parametrize("route", ROUTES, ids=lambda r: f"{r.method} {r.path}")
async def test_outsider_gets_404_on_foreign_workspace(
    world: tuple[Tenant, Tenant], route: Route
) -> None:
    victim, attacker = world
    # The attacker is owner of their own workspace: maximal privileges, wrong tenant.
    assert await _call(attacker.owner, route, victim.ids) == 404


@pytest.mark.parametrize(
    "route", [r for r in ROUTES if r.sub_resource], ids=lambda r: f"{r.method} {r.path}"
)
async def test_foreign_resource_id_under_own_workspace_is_404(
    world: tuple[Tenant, Tenant], route: Route
) -> None:
    victim, attacker = world
    assert route.sub_resource is not None
    mixed = {**attacker.ids, route.sub_resource: victim.ids[route.sub_resource]}
    assert await _call(attacker.owner, route, mixed) == 404


@pytest.mark.parametrize("route", RESOURCE_ROUTES, ids=lambda r: f"{r.method} {r.path}")
async def test_outsider_gets_404_on_foreign_resources(
    world: tuple[Tenant, Tenant], route: Route
) -> None:
    victim, attacker = world
    assert await _call(attacker.owner, route, victim.ids) == 404


async def test_service_keys_cannot_reach_other_workspaces(
    world: tuple[Tenant, Tenant], make_client
) -> None:  # type: ignore[no-untyped-def]
    victim, attacker = world
    key = (
        await attacker.owner.client.post(
            f"/api/v1/workspaces/{attacker.ids['ws']}/api-keys",
            json={"name": "probe", "role": "admin"},
        )
    ).json()["key"]
    robot = make_client(csrf=False)
    robot.headers["Authorization"] = f"Bearer {key}"
    for route in [r for r in RESOURCE_ROUTES if r.method == "GET"] + [
        r for r in ROUTES if r.method == "GET"
    ]:
        path = "/api/v1" + _fill(route.path, victim.ids)
        assert (await robot.get(path)).status_code == 404, path


async def test_victim_data_is_untouched(world: tuple[Tenant, Tenant]) -> None:
    victim, attacker = world
    for route in ROUTES:
        await _call(attacker.owner, route, victim.ids)
    workspace = (await victim.owner.client.get(f"/api/v1/workspaces/{victim.ids['ws']}")).json()
    assert workspace["name"] == "Victim"
    members = (
        await victim.owner.client.get(f"/api/v1/workspaces/{victim.ids['ws']}/members")
    ).json()
    assert {m["email"] for m in members} == {
        "victim-owner@example.com",
        "victim-member@example.com",
    }
    keys = (await victim.owner.client.get(f"/api/v1/workspaces/{victim.ids['ws']}/api-keys")).json()
    assert [k["revoked_at"] for k in keys] == [None]


def _declared_routes() -> set[tuple[str, str]]:
    """Every documented route (read from OpenAPI: included routers are not flattened)."""
    from gouvra.main import create_app

    methods = {"get", "post", "put", "patch", "delete"}
    paths = create_app().openapi()["paths"]
    declared = {
        (method.upper(), path.removeprefix("/api/v1"))
        for path, operations in paths.items()
        for method in operations
        if method in methods
    }
    assert len(declared) > 50, "the route table could not be read"
    return declared


def _normalise(path: str) -> str:
    replacements = {
        "{member}": "{user_id}",
        "{invitation}": "{invitation_id}",
        "{api_key}": "{key_id}",
        "{provider}": "{provider_id}",
        "{tool}": "{tool_id}",
        "{agent}": "{agent_id}",
        "{execution}": "{execution_id}",
        "{suite}": "{suite_id}",
        "{case}": "{case_id}",
        "{run}": "{run_id}",
        "{workflow}": "{workflow_id}",
        "{wfrun}": "{run_id}",
        "{automation}": "{automation_id}",
        "{connection}": "{connection_id}",
        "{alert}": "{alert_id}",
        "/versions/1": "/versions/{number}",
    }
    path = path.split("?", 1)[0]
    for old, new in replacements.items():
        path = path.replace(old, new)
    return path


def test_every_workspace_route_is_covered() -> None:
    """Guard: a new /workspaces/{workspace_id}/... route must be added to ROUTES."""
    declared = {
        (method, path.replace("{workspace_id}", "{ws}"))
        for method, path in _declared_routes()
        if "{workspace_id}" in path
    }
    missing = declared - {(r.method, _normalise(r.path)) for r in ROUTES}
    assert not missing, f"routes without an isolation test: {sorted(missing)}"


# Routes addressed by id that are not workspace resources (covered by the identity tests).
NOT_WORKSPACE_RESOURCES = {
    ("GET", "/auth/oauth/{provider}/start"),
    ("GET", "/auth/oauth/{provider}/callback"),
    ("DELETE", "/me/sessions/{session_id}"),
    # Public inbound webhooks: addressed by an unguessable token, authenticated by signature.
    ("POST", "/hooks/{token}"),
    # Instance administration (super-admins only), covered by test_saas.
    ("PATCH", "/admin/users/{user_id}"),
}


def test_every_resource_route_is_covered() -> None:
    """Guard: a new route addressing a resource by id must be added to RESOURCE_ROUTES."""
    declared = {
        (method, path)
        for method, path in _declared_routes()
        if "{" in path and "{workspace_id}" not in path
    }
    covered = {(r.method, _normalise(r.path)) for r in RESOURCE_ROUTES}
    missing = declared - covered - NOT_WORKSPACE_RESOURCES
    assert not missing, f"resource routes without an isolation test: {sorted(missing)}"
