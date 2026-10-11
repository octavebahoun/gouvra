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


async def test_every_workspace_route_is_covered() -> None:
    """Guard: a new /workspaces/{workspace_id}/... route must be added to ROUTES."""
    from fastapi.routing import APIRoute

    from gouvra.main import create_app

    declared = {
        (method, route.path.removeprefix("/api/v1").replace("{workspace_id}", "{ws}"))
        for route in create_app().routes
        if isinstance(route, APIRoute) and "{workspace_id}" in route.path
        for method in route.methods
    }
    normalised = {
        (
            r.method,
            r.path.replace("{member}", "{user_id}")
            .replace("{invitation}", "{invitation_id}")
            .replace("{api_key}", "{key_id}"),
        )
        for r in ROUTES
    }
    missing = declared - normalised
    assert not missing, f"routes without an isolation test: {sorted(missing)}"
