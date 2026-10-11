"""Phase 3 exit criterion: a real execution (official DeepSeek API) traced end to end."""

from __future__ import annotations

from decimal import Decimal

import pytest

from gouvra.core.config import get_settings
from tests.helpers import Outbox, create_builtin_tool, create_workspace, signup
from tests.test_executions import drain, events_of

pytestmark = [pytest.mark.real, pytest.mark.usefixtures("outbox")]


async def test_real_deepseek_execution_with_tool_call(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    key = get_settings().deepseek_api_key.get_secret_value()
    if not key:
        pytest.skip("DEEPSEEK_API_KEY not configured")
    owner = await signup(make_client(), outbox, "real@example.com")
    ws = await create_workspace(owner, "Real run")
    provider = (
        await owner.client.post(
            f"/api/v1/workspaces/{ws['id']}/providers",
            json={"name": "DeepSeek", "kind": "deepseek", "api_key": key},
        )
    ).json()
    assert "sk-" not in str(provider)
    tested = (await owner.client.post(f"/api/v1/providers/{provider['id']}/test")).json()
    assert tested["ok"] is True, tested
    assert "deepseek-flash" in tested["models"]
    calculator = await create_builtin_tool(owner, ws["id"], "calculator")
    agent = (
        await owner.client.post(
            f"/api/v1/workspaces/{ws['id']}/agents",
            json={
                "name": "Accountant",
                "provider_id": provider["id"],
                "model": "deepseek-flash",
                "instructions": (
                    "Always use the calculator tool for arithmetic,"
                    " then answer with the number only."
                ),
                "tool_ids": [calculator["id"]],
                "parameters": {"reasoning": "auto", "max_output_tokens": 2000},
                "limits": {"max_steps": 6, "timeout_s": 120},
            },
        )
    ).json()
    assert agent["ready"] is True
    launched = (
        await owner.client.post(
            f"/api/v1/agents/{agent['id']}/executions", json={"input": "What is 1234 * 5678?"}
        )
    ).json()
    await drain()
    done = (await owner.client.get(f"/api/v1/executions/{launched['id']}")).json()
    assert done["status"] == "succeeded", done.get("error")
    assert "7006652" in done["output"]["text"].replace(",", "").replace(" ", "").replace(
        "\N{NARROW NO-BREAK SPACE}", ""
    )
    assert done["usage"]["input_tokens"] > 0
    assert done["usage"]["output_tokens"] > 0
    assert done["cost"]["source"] == "estimated"
    assert done["cost"]["currency"] == "USD"
    assert Decimal(done["cost"]["amount"]) > 0
    events = await events_of(launched["id"])
    types = [e.type for e in events]
    assert types[0] == "execution.queued"
    assert types[-1] == "execution.succeeded"
    assert "tool.call" in types
    tool_result = next(e for e in events if e.type == "tool.result")
    assert tool_result.data["ok"] is True
    assert tool_result.data["output"]["result"] == 7006652
    response = next(e for e in events if e.type == "model.response")
    assert response.data["provider_request_id"]
    assert response.data["cost"]["source"] == "estimated"
