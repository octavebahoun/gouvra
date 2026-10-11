"""Providers, tools and agents through the API (permissions, secrets, versioning)."""

from __future__ import annotations

import httpx
import pytest
import respx
from sqlalchemy import select

from gouvra.core.db import get_sessionmaker
from gouvra.modules.providers.models import ProviderConfig
from tests.helpers import (
    Outbox,
    add_member,
    create_agent,
    create_builtin_tool,
    create_provider,
    create_workspace,
    signup,
)

pytestmark = pytest.mark.usefixtures("outbox")


@pytest.fixture
async def team(make_client, outbox: Outbox):  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "lead@example.com")
    ws = await create_workspace(owner, "Lab")
    member = await signup(make_client(), outbox, "dev@example.com")
    viewer = await signup(make_client(), outbox, "watch@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")
    await add_member(owner, ws["id"], viewer, outbox, "viewer")
    return owner, member, viewer, ws


# ---------------------------------------------------------------- providers


async def test_provider_secrets_are_write_only(team) -> None:  # type: ignore[no-untyped-def]
    owner, member, _, ws = team
    created = await create_provider(
        owner, ws["id"], "deepseek", name="DeepSeek prod", api_key="sk-abcdef0123456789wxyz"
    )
    assert created["secret_set"] is True
    assert created["secret_hint"] == "••••wxyz"
    assert "sk-abc" not in str(created)
    fetched = await member.client.get(f"/api/v1/providers/{created['id']}")
    assert "api_key" not in fetched.json()
    assert "sk-abc" not in fetched.text
    async with get_sessionmaker()() as db:
        row = (await db.execute(select(ProviderConfig))).scalar_one()
        assert row.secret_ciphertext is not None
        assert b"sk-abcdef" not in row.secret_ciphertext
    # Members can read but not manage providers.
    assert (
        await member.client.patch(f"/api/v1/providers/{created['id']}", json={"name": "x"})
    ).status_code == 403
    rotated = await owner.client.patch(
        f"/api/v1/providers/{created['id']}", json={"api_key": "sk-new-key-0000000000zz9"}
    )
    assert rotated.json()["secret_hint"] == "••••0zz9"
    assert rotated.json()["status"] == "untested"


async def test_provider_validation(team) -> None:  # type: ignore[no-untyped-def]
    owner, _, _, ws = team
    base = f"/api/v1/workspaces/{ws['id']}/providers"
    missing_key = await owner.client.post(base, json={"name": "A", "kind": "deepseek"})
    assert missing_key.json()["errors"][0]["field"] == "api_key"
    no_url = await owner.client.post(
        base, json={"name": "B", "kind": "openai_compatible", "api_key": "k" * 20}
    )
    assert no_url.json()["errors"][0]["field"] == "base_url"
    for url in (
        "http://api.example.com/v1",
        "https://127.0.0.1/v1",
        "https://metadata.internal/v1",
    ):
        bad = await owner.client.post(
            base,
            json={"name": "C", "kind": "openai_compatible", "api_key": "k" * 20, "base_url": url},
        )
        assert bad.status_code == 422, url
    await create_provider(owner, ws["id"], name="Same")
    duplicate = await owner.client.post(base, json={"name": "Same", "kind": "test"})
    assert duplicate.json()["errors"][0]["code"] == "taken"


async def test_connection_test_refreshes_models(team) -> None:  # type: ignore[no-untyped-def]
    owner, member, _, ws = team
    provider = await create_provider(owner, ws["id"], "test")
    tested = await owner.client.post(f"/api/v1/providers/{provider['id']}/test")
    assert tested.json()["ok"] is True
    after = (await owner.client.get(f"/api/v1/providers/{provider['id']}")).json()
    assert after["status"] == "ok"
    assert after["models"] == ["gouvra-test-1"]
    assert after["default_model"] == "gouvra-test-1"
    assert (await member.client.post(f"/api/v1/providers/{provider['id']}/test")).status_code == 403


@respx.mock
async def test_connection_test_reports_provider_errors(
    team, monkeypatch: pytest.MonkeyPatch
) -> None:  # type: ignore[no-untyped-def]
    owner, _, _, ws = team

    async def fake_resolve(host: str, port: int, *, allow_private: bool = False) -> list[str]:
        return ["93.184.216.34"]

    monkeypatch.setattr("gouvra.modules.providers.registry.resolve_public", fake_resolve)
    respx.get("https://api.deepseek.com/models").mock(
        return_value=httpx.Response(401, json={"error": {"message": "Authentication Fails"}})
    )
    provider = await create_provider(owner, ws["id"], "deepseek")
    result = (await owner.client.post(f"/api/v1/providers/{provider['id']}/test")).json()
    assert result["ok"] is False
    assert result["error"]["code"] == "provider_auth_error"
    stored = (await owner.client.get(f"/api/v1/providers/{provider['id']}")).json()
    assert stored["status"] == "error"
    assert stored["last_error"]["code"] == "provider_auth_error"


async def test_provider_kinds_catalogue(team) -> None:  # type: ignore[no-untyped-def]
    owner, *_ = team
    kinds = {k["kind"]: k for k in (await owner.client.get("/api/v1/providers/kinds")).json()}
    assert set(kinds) == {"deepseek", "anthropic", "openai_compatible", "test"}
    flash = next(m for m in kinds["deepseek"]["models"] if m["id"] == "deepseek-flash")
    assert flash["pricing"]["peak"] is not None
    assert flash["pricing"]["source_url"].startswith("https://")


async def test_provider_in_use_cannot_be_deleted(team) -> None:  # type: ignore[no-untyped-def]
    owner, _, _, ws = team
    provider = await create_provider(owner, ws["id"])
    agent = await create_agent(owner, ws["id"], provider["id"])
    blocked = await owner.client.delete(f"/api/v1/providers/{provider['id']}")
    assert blocked.status_code == 409
    assert blocked.json()["code"] == "provider_in_use"
    await owner.client.post(f"/api/v1/agents/{agent['id']}/archive")
    assert (await owner.client.delete(f"/api/v1/providers/{provider['id']}")).status_code == 204


# ---------------------------------------------------------------- tools


async def test_builtin_and_custom_tools(team, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    _owner, member, viewer, ws = team
    builtins = {t["key"] for t in (await viewer.client.get("/api/v1/tools/builtins")).json()}
    assert {"calculator", "current_time", "http_request"} <= builtins
    calculator = await create_builtin_tool(member, ws["id"], "calculator")
    tested = await member.client.post(
        f"/api/v1/tools/{calculator['id']}/test", json={"arguments": {"expression": "6*7"}}
    )
    assert tested.json()["ok"] is True
    assert tested.json()["output"]["result"] == 42
    invalid = await member.client.post(
        f"/api/v1/tools/{calculator['id']}/test", json={"arguments": {"expr": "1"}}
    )
    assert invalid.json()["error_code"] == "invalid_arguments"
    assert (
        await viewer.client.post(f"/api/v1/tools/{calculator['id']}/test", json={"arguments": {}})
    ).status_code == 403

    http_needs_hosts = await member.client.post(
        f"/api/v1/workspaces/{ws['id']}/tools",
        json={"kind": "builtin", "builtin_key": "http_request", "config": {}},
    )
    assert http_needs_hosts.status_code == 422
    custom = await member.client.post(
        f"/api/v1/workspaces/{ws['id']}/tools",
        json={
            "kind": "http",
            "name": "get_ticket",
            "description": "Fetch a support ticket",
            "input_schema": {
                "type": "object",
                "properties": {"ticket_id": {"type": "string"}},
                "required": ["ticket_id"],
            },
            "config": {
                "method": "GET",
                "url": "https://tickets.example.com/api/tickets/{ticket_id}",
                "auth": {"type": "bearer"},
            },
            "secret": "tok_supersecret_123456",
        },
    )
    assert custom.status_code == 201, custom.text
    body = custom.json()
    assert body["secret_set"] is True
    assert "supersecret" not in custom.text
    hostile_host = await member.client.post(
        f"/api/v1/workspaces/{ws['id']}/tools",
        json={
            "kind": "http",
            "name": "pivot",
            "description": "x",
            "input_schema": {"type": "object", "properties": {}},
            "config": {"url": "https://{host}/x"},
        },
    )
    assert hostile_host.status_code == 422

    async def fake_resolve(host: str, port: int, *, allow_private: bool = False) -> list[str]:
        return ["93.184.216.34"]

    monkeypatch.setattr("gouvra.modules.tools.http_client.resolve_public", fake_resolve)
    with respx.mock:
        route = respx.get("https://93.184.216.34/api/tickets/T-42").mock(
            return_value=httpx.Response(200, json={"id": "T-42", "status": "open"})
        )
        result = await member.client.post(
            f"/api/v1/tools/{body['id']}/test", json={"arguments": {"ticket_id": "T-42"}}
        )
    assert result.json()["output"]["body"] == {"id": "T-42", "status": "open"}
    sent = route.calls[0].request
    assert sent.headers["host"] == "tickets.example.com"
    assert sent.headers["authorization"] == "Bearer tok_supersecret_123456"
    assert sent.extensions["sni_hostname"] == "tickets.example.com"


async def test_http_tool_blocks_private_targets_and_redirects(
    team, monkeypatch: pytest.MonkeyPatch
) -> None:  # type: ignore[no-untyped-def]
    owner, _, _, ws = team
    tool = await create_builtin_tool(
        owner, ws["id"], "http_request", allowed_hosts=["*.example.com"], allowed_methods=["GET"]
    )
    url = f"/api/v1/tools/{tool['id']}/test"
    outside = await owner.client.post(url, json={"arguments": {"url": "https://evil.test/data"}})
    assert "allow-list" in outside.json()["error_message"]

    async def private(host: str, port: int, *, allow_private: bool = False) -> list[str]:
        from gouvra.core.netguard import BlockedDestination

        raise BlockedDestination("private_address")

    monkeypatch.setattr("gouvra.modules.tools.http_client.resolve_public", private)
    rebinding = await owner.client.post(
        url, json={"arguments": {"url": "https://api.example.com/data"}}
    )
    assert "private" in rebinding.json()["error_message"]

    calls: list[str] = []

    async def mixed(host: str, port: int, *, allow_private: bool = False) -> list[str]:
        calls.append(host)
        if host == "api.example.com":
            return ["93.184.216.34"]
        raise AssertionError("redirect target must be checked against the allow-list first")

    monkeypatch.setattr("gouvra.modules.tools.http_client.resolve_public", mixed)
    with respx.mock:
        respx.get("https://93.184.216.34/data").mock(
            return_value=httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest/meta-data"}
            )
        )
        redirected = await owner.client.post(
            url, json={"arguments": {"url": "https://api.example.com/data"}}
        )
    assert redirected.json()["ok"] is False
    assert "allow-list" in redirected.json()["error_message"]
    post = await owner.client.post(
        url, json={"arguments": {"url": "https://api.example.com/data", "method": "POST"}}
    )
    assert "not allowed" in post.json()["error_message"]


# ---------------------------------------------------------------- agents


async def test_agent_versioning_and_lifecycle(team) -> None:  # type: ignore[no-untyped-def]
    owner, member, viewer, ws = team
    provider = await create_provider(owner, ws["id"])
    calc = await create_builtin_tool(owner, ws["id"], "calculator")
    agent = await create_agent(
        member,
        ws["id"],
        provider["id"],
        "Support triage",
        tool_ids=[calc["id"]],
        limits={"max_steps": 4},
    )
    assert agent["version"]["number"] == 1
    assert agent["ready"] is True
    assert agent["version"]["tools"][0]["name"] == "calculator"
    assert (
        await viewer.client.patch(f"/api/v1/agents/{agent['id']}", json={"name": "x"})
    ).status_code == 403

    renamed = (
        await member.client.patch(
            f"/api/v1/agents/{agent['id']}", json={"description": "Routes tickets"}
        )
    ).json()
    assert renamed["latest_version_number"] == 1  # metadata edits don't create a version
    changed = (
        await member.client.patch(
            f"/api/v1/agents/{agent['id']}",
            json={"instructions": "Be terse.", "change_note": "shorter"},
        )
    ).json()
    assert changed["version"]["number"] == 2
    assert changed["version"]["change_note"] == "shorter"
    same = (
        await member.client.patch(
            f"/api/v1/agents/{agent['id']}", json={"instructions": "Be terse."}
        )
    ).json()
    assert same["latest_version_number"] == 2
    versions = (await member.client.get(f"/api/v1/agents/{agent['id']}/versions")).json()
    assert [v["number"] for v in versions] == [2, 1]
    assert [v["is_current"] for v in versions] == [True, False]
    restored = (await member.client.post(f"/api/v1/agents/{agent['id']}/versions/1/restore")).json()
    assert restored["version"]["number"] == 3
    assert restored["version"]["instructions"] == "Be helpful."

    copy = (await member.client.post(f"/api/v1/agents/{agent['id']}/duplicate", json={})).json()
    assert copy["name"] == "Support triage (copy)"
    assert copy["version"]["number"] == 1
    assert copy["version"]["tools"][0]["id"] == calc["id"]
    second_copy = (
        await member.client.post(f"/api/v1/agents/{agent['id']}/duplicate", json={})
    ).json()
    assert second_copy["name"] == "Support triage (copy 2)"

    archived = (await member.client.post(f"/api/v1/agents/{agent['id']}/archive")).json()
    assert archived["status"] == "archived"
    listing = (await member.client.get(f"/api/v1/workspaces/{ws['id']}/agents")).json()["data"]
    assert agent["id"] not in [a["id"] for a in listing]
    archived_list = (
        await member.client.get(
            f"/api/v1/workspaces/{ws['id']}/agents", params={"status": "archived"}
        )
    ).json()["data"]
    assert [a["id"] for a in archived_list] == [agent["id"]]
    assert (await member.client.patch(f"/api/v1/agents/{agent['id']}", json={"name": "y"})).json()[
        "code"
    ] == "agent_archived"
    assert (await member.client.post(f"/api/v1/agents/{agent['id']}/restore")).json()[
        "status"
    ] == "active"
    assert (await member.client.delete(f"/api/v1/agents/{copy['id']}")).status_code == 204


async def test_agent_validation_and_readiness(team, make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner, _, _, ws = team
    other_owner = await signup(make_client(), outbox, "elsewhere@example.com")
    other_ws = await create_workspace(other_owner, "Other")
    foreign_tool = await create_builtin_tool(other_owner, other_ws["id"], "calculator")
    foreign_provider = await create_provider(other_owner, other_ws["id"])
    base = f"/api/v1/workspaces/{ws['id']}/agents"
    bad_tool = await owner.client.post(base, json={"name": "A", "tool_ids": [foreign_tool["id"]]})
    assert bad_tool.json()["errors"][0]["field"] == "tool_ids"
    bad_provider = await owner.client.post(
        base, json={"name": "B", "provider_id": foreign_provider["id"]}
    )
    assert bad_provider.json()["errors"][0]["field"] == "provider_id"
    too_long = await owner.client.post(base, json={"name": "C", "limits": {"timeout_s": 99999}})
    assert too_long.status_code == 422
    draft = (await owner.client.post(base, json={"name": "Draft"})).json()
    assert draft["ready"] is False
    assert "no_provider" in draft["readiness_issues"]
    search = (await owner.client.get(base, params={"q": "draf"})).json()["data"]
    assert [a["name"] for a in search] == ["Draft"]
