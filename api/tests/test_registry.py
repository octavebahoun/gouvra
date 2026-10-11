"""The registry: models with their prices and the agents using them; tools with their origin."""

from __future__ import annotations

from typing import Any

import pytest

from tests.helpers import Account

pytestmark = pytest.mark.usefixtures("outbox")


async def test_registry_shows_what_is_used_and_what_is_available(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    registry = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/registry")).json()

    scripted = next(m for m in registry["models"] if m["model"]["id"] == "gouvra-test-1")
    assert scripted["provider_kind"] == "test"
    assert [p["id"] for p in scripted["providers"]] == [lab["provider"]["id"]]
    assert [a["id"] for a in scripted["agents"]] == [agent["id"]]
    deepseek = [m for m in registry["models"] if m["provider_kind"] == "deepseek"]
    assert deepseek
    assert deepseek[0]["providers"] == []  # not configured in this workspace
    assert deepseek[0]["model"]["pricing"]["currency"] == "USD"

    tools = {t["name"]: t for t in registry["tools"]}
    calculator = tools["calculator"]
    assert (calculator["id"], calculator["kind"]) == (lab["calc"]["id"], "builtin")
    assert [a["name"] for a in calculator["agents"]] == ["Helper"]
    assert tools["current_time"]["agents"] == []
    available = [t for t in registry["tools"] if t["id"] is None]
    assert available
    assert {t["status"] for t in available} == {"available"}
    assert "calculator" not in {t["name"] for t in available}
