"""Connectors: the library, connections with sealed credentials, and their operations as tools."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import pytest
import respx
from pydantic import SecretStr

from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker
from gouvra.modules.automations import signing
from gouvra.modules.connectors.models import Connection
from tests.helpers import Account, Outbox, add_member, signup

pytestmark = pytest.mark.usefixtures("outbox")

PUBLIC_IP = "93.184.216.34"
SLACK_URL = "https://hooks.slack.com/services/T000/B000/abcdefabcdef"
GITHUB_TOKEN = "github_pat_" + "a1" * 20


@pytest.fixture(autouse=True)
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every host resolves to one public address; requests are pinned to it (and mocked)."""

    async def resolve(host: str, port: int, *, allow_private: bool = False) -> list[str]:
        return [PUBLIC_IP]

    monkeypatch.setattr("gouvra.modules.tools.http_client.resolve_public", resolve)


async def _connect(
    owner: Account, ws_id: str, connector: str, name: str, **credentials: str
) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/workspaces/{ws_id}/connections",
        json={"connector": connector, "name": name, "credentials": credentials},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def _run(owner: Account, tool_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/tools/{tool_id}/test", json={"arguments": arguments}
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_library_lists_connectors_without_secrets(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    library = (await owner.client.get("/api/v1/connectors")).json()
    assert [c["key"] for c in library] == ["slack", "discord", "github", "webhook"]
    github = next(c for c in library if c["key"] == "github")
    assert [o["key"] for o in github["operations"]] == [
        "create_issue",
        "comment_on_issue",
        "get_issue",
    ]
    assert github["verifiable"] is True
    assert github["operations"][2]["writes"] is False
    assert github["fields"][0]["key"] == "token"
    assert "pattern" not in github["fields"][0]


@respx.mock
async def test_slack_connection_posts_messages(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    url = f"/api/v1/workspaces/{ws['id']}/connections"
    bad = [
        ({"webhook_url": "https://evil.example.com/hook"}, "invalid_format"),
        ({}, "required"),
        ({"webhook_url": SLACK_URL, "extra": "x"}, "unknown_field"),
    ]
    for credentials, code in bad:
        refused = await owner.client.post(
            url, json={"connector": "slack", "name": "Support Slack", "credentials": credentials}
        )
        assert refused.status_code == 422, refused.text
        assert refused.json()["errors"][0]["code"] == code
    unknown = await owner.client.post(
        url, json={"connector": "fax", "name": "Fax", "credentials": {}}
    )
    assert unknown.json()["errors"][0]["code"] == "unknown_connector"

    connection = await _connect(owner, ws["id"], "slack", "Support Slack", webhook_url=SLACK_URL)
    assert connection["connector_name"] == "Slack"
    assert connection["secret_hint"] == SLACK_URL[-4:]
    assert connection["status"] == "unverified"
    assert "credentials" not in connection
    [tool] = connection["tools"]
    assert (tool["name"], tool["operation"]) == ("support_slack_post_message", "post_message")
    assert tool["display_name"] == "Support Slack — Post a message"
    detail = (await owner.client.get(f"/api/v1/tools/{tool['id']}")).json()
    assert (detail["kind"], detail["connection_id"], detail["uses_network"]) == (
        "connector",
        connection["id"],
        True,
    )
    assert detail["input_schema"]["required"] == ["text"]

    route = respx.post(f"https://{PUBLIC_IP}/services/T000/B000/abcdefabcdef").mock(
        return_value=httpx.Response(200, text="ok")
    )
    result = await _run(owner, tool["id"], {"text": "A refund needs approval"})
    assert result["ok"] is True, result
    assert result["output"] == {"posted": True}
    sent = route.calls[0].request
    assert sent.headers["host"] == "hooks.slack.com"
    assert json.loads(sent.content) == {"text": "A refund needs approval"}
    # Arguments are checked against the operation's schema before anything is sent.
    rejected = await _run(owner, tool["id"], {"text": "x", "channel": "#general"})
    assert (rejected["ok"], rejected["error_code"]) == (False, "invalid_arguments")
    assert len(route.calls) == 1
    checked = (await owner.client.get(f"/api/v1/connections/{connection['id']}")).json()
    assert checked["status"] == "ok"  # the latest real call worked

    # The schema and credentials of a connector tool belong to its connection.
    locked = await owner.client.patch(
        f"/api/v1/tools/{tool['id']}", json={"input_schema": {"type": "object"}}
    )
    assert locked.status_code == 422


@respx.mock
async def test_github_connection_checks_and_runs_operations(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    bad_token = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/connections",
        json={"connector": "github", "name": "GitHub", "credentials": {"token": "hunter2"}},
    )
    assert bad_token.json()["errors"][0]["code"] == "invalid_format"
    connection = await _connect(owner, ws["id"], "github", "GitHub", token=GITHUB_TOKEN)
    tools = {t["operation"]: t for t in connection["tools"]}
    assert set(tools) == {"create_issue", "comment_on_issue", "get_issue"}

    user = respx.get(f"https://{PUBLIC_IP}/user").mock(
        return_value=httpx.Response(200, json={"login": "octocat"})
    )
    check = await owner.client.post(f"/api/v1/connections/{connection['id']}/check")
    assert check.json() == {"ok": True, "status": "ok", "message": "Signed in as octocat."}
    assert user.calls[0].request.headers["authorization"] == f"Bearer {GITHUB_TOKEN}"
    assert user.calls[0].request.headers["host"] == "api.github.com"

    issues = respx.post(f"https://{PUBLIC_IP}/repos/octo-org/website/issues").mock(
        return_value=httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo-org/website/issues/7",
                "title": "Broken link",
                "state": "open",
                "body": "On the pricing page",
            },
        )
    )
    created = await _run(
        owner,
        tools["create_issue"]["id"],
        {"repository": "octo-org/website", "title": "Broken link", "labels": ["bug"]},
    )
    assert created["ok"] is True, created
    assert created["output"]["number"] == 7
    assert created["output"]["url"].endswith("/issues/7")
    assert json.loads(issues.calls[0].request.content) == {
        "title": "Broken link",
        "labels": ["bug"],
    }
    assert GITHUB_TOKEN not in json.dumps(created)  # the credential never reaches the model

    # A repository is owner/name only: no path tricks get past the schema.
    sneaky = await _run(owner, tools["get_issue"]["id"], {"repository": "../../user", "number": 1})
    assert sneaky["error_code"] == "invalid_arguments"
    respx.get(f"https://{PUBLIC_IP}/repos/octo-org/website/issues/404").mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )
    missing = await _run(
        owner, tools["get_issue"]["id"], {"repository": "octo-org/website", "number": 404}
    )
    assert missing["ok"] is False
    assert missing["error_message"] == "GitHub refused the request (HTTP 404): Not Found"
    after = (await owner.client.get(f"/api/v1/connections/{connection['id']}")).json()
    assert (after["status"], after["status_message"]) == ("error", "HTTP 404: Not Found")

    respx.get(f"https://{PUBLIC_IP}/user").mock(return_value=httpx.Response(401, json={}))
    revoked = await owner.client.post(f"/api/v1/connections/{connection['id']}/check")
    assert revoked.json() == {
        "ok": False,
        "status": "error",
        "message": "Refused by GitHub (HTTP 401).",
    }


@respx.mock
async def test_discord_and_signed_outgoing_webhooks(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    discord_url = "https://discord.com/api/webhooks/123456/token_abcdefgh"
    discord = await _connect(owner, ws["id"], "discord", "Team chat", webhook_url=discord_url)
    respx.get(f"https://{PUBLIC_IP}/api/webhooks/123456/token_abcdefgh").mock(
        return_value=httpx.Response(200, json={"name": "Gouvra", "channel_id": "987"})
    )
    check = await owner.client.post(f"/api/v1/connections/{discord['id']}/check")
    assert check.json()["message"] == "Posts to channel 987 as “Gouvra”."
    posted = respx.post(f"https://{PUBLIC_IP}/api/webhooks/123456/token_abcdefgh").mock(
        return_value=httpx.Response(200, json={"id": "m1"})
    )
    result = await _run(owner, discord["tools"][0]["id"], {"content": "@everyone deploy done"})
    assert result["output"] == {"posted": True, "message_id": "m1"}
    sent = json.loads(posted.calls[0].request.content)
    assert sent["allowed_mentions"] == {"parse": []}  # no mass pings
    assert posted.calls[0].request.url.params["wait"] == "true"

    blocked = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/connections",
        json={
            "connector": "webhook",
            "name": "Internal",
            "credentials": {"url": "https://10.0.0.5/x"},
        },
    )
    assert blocked.json()["errors"][0]["code"] == "blocked_url"
    secret = "s3cret-for-signing-1234"
    outgoing = await _connect(
        owner,
        ws["id"],
        "webhook",
        "Data warehouse",
        url="https://ingest.example.com/gouvra?token=abc",
        secret=secret,
    )
    received = respx.post(f"https://{PUBLIC_IP}/gouvra").mock(return_value=httpx.Response(204))
    sent_event = await _run(
        owner, outgoing["tools"][0]["id"], {"event": "ticket.closed", "data": {"id": 7}}
    )
    assert sent_event["output"] == {"delivered": True, "status": 204}
    request = received.calls[0].request
    assert request.url.params["token"] == "abc"
    payload = json.loads(request.content)
    assert (payload["event"], payload["data"]) == ("ticket.closed", {"id": 7})
    verdict = signing.verify_gouvra(
        secret, request.headers["gouvra-signature"], request.content, time.time()
    )
    assert verdict.ok


@respx.mock
async def test_connection_lifecycle_roles_and_key_rotation(
    lab: dict[str, Any], make_client: Any, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    connection = await _connect(owner, ws["id"], "slack", "Alerts", webhook_url=SLACK_URL)
    tool_id = connection["tools"][0]["id"]
    taken = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/connections",
        json={"connector": "slack", "name": "Alerts", "credentials": {"webhook_url": SLACK_URL}},
    )
    assert taken.json()["errors"][0]["code"] == "taken"

    renamed = await owner.client.patch(
        f"/api/v1/connections/{connection['id']}", json={"name": "Night alerts"}
    )
    assert renamed.json()["tools"][0]["display_name"] == "Night alerts — Post a message"
    replaced = await owner.client.patch(
        f"/api/v1/connections/{connection['id']}",
        json={"credentials": {"webhook_url": SLACK_URL.replace("abcdef", "123456")}},
    )
    assert (replaced.json()["status"], replaced.json()["secret_hint"]) == ("unverified", "3456")
    unverifiable = await owner.client.post(f"/api/v1/connections/{connection['id']}/check")
    assert unverifiable.json()["ok"] is True
    assert "first time" in unverifiable.json()["message"]

    # Encryption key rotation re-seals connection credentials; calls keep working.
    from gouvra.core.rotation import rotate_secrets

    settings = get_settings()
    current = settings.encryption_keys.get_secret_value()
    monkeypatch.setattr(settings, "encryption_keys", SecretStr("k2027:" + "E" * 43 + "," + current))
    assert (await rotate_secrets()).failed == 0
    async with get_sessionmaker()() as db:
        stored = await db.get(Connection, connection["id"])
        assert stored is not None
        assert stored.secret_key_id == "k2027"
    respx.post(f"https://{PUBLIC_IP}/services/T000/B000/123456123456").mock(
        return_value=httpx.Response(200, text="ok")
    )
    assert (await _run(owner, tool_id, {"text": "still works"}))["ok"] is True

    member = await signup(make_client(), outbox, "integrator@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")
    listed = await member.client.get(f"/api/v1/workspaces/{ws['id']}/connections")
    assert [c["id"] for c in listed.json()] == [connection["id"]]
    denied = [
        await member.client.post(
            f"/api/v1/workspaces/{ws['id']}/connections",
            json={"connector": "slack", "name": "Mine", "credentials": {"webhook_url": SLACK_URL}},
        ),
        await member.client.patch(f"/api/v1/connections/{connection['id']}", json={"name": "x"}),
        await member.client.post(f"/api/v1/connections/{connection['id']}/check"),
        await member.client.delete(f"/api/v1/connections/{connection['id']}"),
    ]
    assert [r.status_code for r in denied] == [403] * 4

    removed = await owner.client.delete(f"/api/v1/connections/{connection['id']}")
    assert removed.status_code == 204
    assert (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/connections")).json() == []
    tool = (await owner.client.get(f"/api/v1/tools/{tool_id}")).json()
    assert tool["status"] == "archived"
    after = await _run(owner, tool_id, {"text": "gone"})
    assert after["ok"] is False
    async with get_sessionmaker()() as db:
        stored = await db.get(Connection, connection["id"])
        assert stored is not None
        assert stored.secret_ciphertext is None  # credentials erased
    audit = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events")).json()
    assert {"connection.created", "connection.updated", "connection.removed"} <= {
        e["action"] for e in audit["data"]
    }
