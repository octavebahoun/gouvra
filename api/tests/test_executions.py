"""Execution engine end to end with the deterministic provider (no network)."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.executions.engine import run_execution
from gouvra.modules.executions.models import Execution, ExecutionEvent, UsageRecord
from gouvra.modules.executions.queue import claim_next, reap_expired
from gouvra.modules.executions.worker import execution_service
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


async def drain() -> int:
    """Run every queued execution to completion, like the worker would."""
    count = 0
    while (claimed := await claim_next("test-worker")) is not None:
        await run_execution(claimed, worker_id="test-worker")
        count += 1
    return count


async def events_of(execution_id: str) -> list[ExecutionEvent]:
    async with get_sessionmaker()() as db:
        return list(
            (
                await db.execute(
                    select(ExecutionEvent)
                    .where(ExecutionEvent.execution_id == execution_id)
                    .order_by(ExecutionEvent.seq)
                )
            ).scalars()
        )


@pytest.fixture
async def lab(make_client, outbox: Outbox) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "runner@example.com")
    ws = await create_workspace(owner, "Runs")
    provider = await create_provider(owner, ws["id"])
    calc = await create_builtin_tool(owner, ws["id"], "calculator")
    clock = await create_builtin_tool(owner, ws["id"], "current_time")
    agent = await create_agent(
        owner,
        ws["id"],
        provider["id"],
        tool_ids=[calc["id"]],
        limits={"max_steps": 4, "max_tool_calls": 3, "timeout_s": 30},
    )
    return {
        "owner": owner,
        "ws": ws,
        "provider": provider,
        "agent": agent,
        "calc": calc,
        "clock": clock,
    }


async def launch(owner: Account, agent_id: str, text: Any, **extra: Any) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/agents/{agent_id}/executions", json={"input": text, **extra}
    )
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_simple_execution_is_traced_end_to_end(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    queued = await launch(owner, lab["agent"]["id"], "Hello there")
    assert queued["status"] == "queued"
    assert queued["agent"]["name"] == "Helper"
    assert await drain() == 1
    done = (await owner.client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "succeeded"
    assert done["output"] == {"text": "Echo: Hello there"}
    assert done["duration_ms"] is not None
    assert done["usage"]["input_tokens"] > 0
    assert (
        done["cost"]["source"] == "unavailable"
    )  # no public price for the test model: never a fake zero
    assert done["cost"]["amount"] is None
    types = [e.type for e in await events_of(queued["id"])]
    assert types == [
        "execution.queued",
        "execution.started",
        "model.request",
        "model.response",
        "execution.succeeded",
    ]
    async with get_sessionmaker()() as db:
        assert len((await db.execute(select(UsageRecord))).scalars().all()) == 1


async def test_tool_calls_are_validated_executed_and_traced(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    queued = await launch(
        owner, lab["agent"]["id"], 'Multiply [tool:calculator {"expression": "6*7"}]'
    )
    await drain()
    done = (await owner.client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "succeeded"
    assert "42" in done["output"]["text"]
    assert (done["tool_calls"], done["model_calls"], done["steps"]) == (1, 2, 2)
    events = await events_of(queued["id"])
    call = next(e for e in events if e.type == "tool.call")
    result = next(e for e in events if e.type == "tool.result")
    assert call.data["tool"] == "calculator"
    assert call.data["arguments"] == {"expression": "6*7"}
    assert result.data["ok"] is True
    assert result.data["output"]["result"] == 42
    assert result.duration_ms is not None


async def test_disallowed_and_invalid_tool_calls_are_reported_to_the_model(
    lab: dict[str, Any],
) -> None:
    owner = lab["owner"]
    not_allowed = await launch(owner, lab["agent"]["id"], "[tool:current_time {}]")
    bad_args = await launch(owner, lab["agent"]["id"], '[tool:calculator {"formula": "1+1"}]')
    await drain()
    for execution_id, code in (
        (not_allowed["id"], "tool_not_allowed"),
        (bad_args["id"], "invalid_arguments"),
    ):
        result = next(e for e in await events_of(execution_id) if e.type == "tool.result")
        assert result.data["ok"] is False
        assert result.data["error_code"] == code
        assert result.level == "warning"
        done = (await owner.client.get(f"/api/v1/executions/{execution_id}")).json()
        assert done["status"] == "succeeded"  # the model got the error and answered


async def test_limits_stop_runaway_agents(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    many = " ".join(f'[tool:calculator {{"expression": "{i}+1"}}]' for i in range(5))
    queued = await launch(owner, lab["agent"]["id"], many)
    await drain()
    done = (await owner.client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "failed"
    assert done["error"]["code"] == "limit_exceeded"
    assert done["error"]["details"]["limit"] == "max_tool_calls"
    final = (await events_of(queued["id"]))[-1]
    assert final.type == "execution.failed"
    assert final.data["error"]["code"] == "limit_exceeded"


async def test_provider_failures_are_normalised_for_diagnosis(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    queued = await launch(owner, lab["agent"]["id"], "[fail:provider_rate_limited]")
    await drain()
    done = (await owner.client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "failed"
    assert done["error"]["code"] == "provider_rate_limited"
    assert done["error"]["retryable"] is True
    model_error = next(e for e in await events_of(queued["id"]) if e.type == "model.error")
    assert model_error.data["error"]["code"] == "provider_rate_limited"
    failed = (
        await owner.client.get(
            f"/api/v1/workspaces/{lab['ws']['id']}/executions", params={"status": "failed"}
        )
    ).json()
    assert [e["id"] for e in failed["data"]] == [queued["id"]]
    assert failed["data"][0]["error_code"] == "provider_rate_limited"


async def test_timeouts(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    queued = await launch(owner, lab["agent"]["id"], "[sleep:3000] slow", timeout_s=5)
    async with get_sessionmaker()() as db:
        await db.execute(update(Execution).where(Execution.id == queued["id"]).values(timeout_s=1))
        await db.commit()
    await drain()
    done = (await owner.client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "timed_out"
    assert done["error"]["code"] == "timeout"
    assert (await events_of(queued["id"]))[-1].type == "execution.timed_out"


async def test_cancel_queued_and_running(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    queued = await launch(owner, lab["agent"]["id"], "never runs")
    cancelled = (await owner.client.post(f"/api/v1/executions/{queued['id']}/cancel")).json()
    assert cancelled["status"] == "cancelled"
    assert (await owner.client.post(f"/api/v1/executions/{queued['id']}/cancel")).json()[
        "code"
    ] == "execution_finished"
    assert await drain() == 0

    stop = asyncio.Event()
    worker = asyncio.create_task(execution_service(stop))
    try:
        running = await launch(owner, lab["agent"]["id"], "[sleep:20000] long job")
        for _ in range(100):
            state = (await owner.client.get(f"/api/v1/executions/{running['id']}")).json()["status"]
            if state == "running":
                break
            await asyncio.sleep(0.05)
        assert state == "running"
        await owner.client.post(f"/api/v1/executions/{running['id']}/cancel")
        for _ in range(100):
            state = (await owner.client.get(f"/api/v1/executions/{running['id']}")).json()["status"]
            if state == "cancelled":
                break
            await asyncio.sleep(0.05)
        assert state == "cancelled"
        types = [e.type for e in await events_of(running["id"])]
        assert "execution.cancel_requested" in types
        assert types[-1] == "execution.cancelled"
    finally:
        stop.set()
        await asyncio.wait_for(worker, timeout=40)


async def test_idempotency_keys(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    url = f"/api/v1/agents/{lab['agent']['id']}/executions"
    first = await owner.client.post(
        url, json={"input": "once"}, headers={"Idempotency-Key": "order-123"}
    )
    again = await owner.client.post(
        url, json={"input": "once"}, headers={"Idempotency-Key": "order-123"}
    )
    assert first.status_code == 202
    assert again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    conflict = await owner.client.post(
        url, json={"input": "different"}, headers={"Idempotency-Key": "order-123"}
    )
    assert conflict.status_code == 422
    assert conflict.json()["code"] == "idempotency_mismatch"


async def test_launch_guards(
    lab: dict[str, Any], make_client, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:  # type: ignore[no-untyped-def]
    owner = lab["owner"]
    url = f"/api/v1/agents/{lab['agent']['id']}/executions"
    monkeypatch.setattr(get_settings(), "max_execution_input_bytes", 100)
    assert (await owner.client.post(url, json={"input": "x" * 200})).status_code == 413
    assert (await owner.client.post(url, json={"input": "   "})).status_code == 422
    draft = (
        await owner.client.post(
            f"/api/v1/workspaces/{lab['ws']['id']}/agents", json={"name": "Draft"}
        )
    ).json()
    not_ready = await owner.client.post(
        f"/api/v1/agents/{draft['id']}/executions", json={"input": "hi"}
    )
    assert not_ready.status_code == 409
    assert "no_provider" in not_ready.json()["details"]["issues"]
    viewer = await signup(make_client(), outbox, "readonly@example.com")
    await add_member(owner, lab["ws"]["id"], viewer, outbox, "viewer")
    assert (await viewer.client.post(url, json={"input": "hi"})).status_code == 403
    json_input = await owner.client.post(url, json={"input": {"ticket": 42}})
    assert json_input.json()["input"] == {"json": {"ticket": 42}}


async def test_launch_rate_limit(lab: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    from gouvra.core import ratelimit

    monkeypatch.setattr(
        ratelimit, "EXECUTIONS_PER_WORKSPACE", ratelimit.Limit("executions:workspace", 2, 60)
    )
    url = f"/api/v1/agents/{lab['agent']['id']}/executions"
    codes = [
        (await lab["owner"].client.post(url, json={"input": f"n{i}"})).status_code for i in range(3)
    ]
    assert codes == [202, 202, 429]


async def test_per_workspace_concurrency(
    lab: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "default_workspace_concurrency", 1)
    for i in range(3):
        await launch(lab["owner"], lab["agent"]["id"], f"job {i}")
    first = await claim_next("w1")
    assert first is not None
    assert await claim_next("w2") is None  # the workspace already runs its single allowed execution
    await run_execution(first, worker_id="w1")
    assert await claim_next("w2") is not None


async def test_lost_workers_are_reaped(lab: dict[str, Any]) -> None:
    queued = await launch(lab["owner"], lab["agent"]["id"], "orphan")
    claimed = await claim_next("ghost")
    assert claimed is not None
    async with get_sessionmaker()() as db:
        await db.execute(update(Execution).values(lease_expires_at=utcnow() - timedelta(seconds=5)))
        await db.commit()
    reaped = await reap_expired()
    assert [str(r["id"]) for r in reaped] == [queued["id"]]
    done = (await lab["owner"].client.get(f"/api/v1/executions/{queued['id']}")).json()
    assert done["status"] == "failed"
    assert done["error"]["code"] == "worker_lost"


async def test_retry_and_listing(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    failed = await launch(owner, lab["agent"]["id"], "[fail:provider_unavailable]")
    await drain()
    retry = await owner.client.post(f"/api/v1/executions/{failed['id']}/retry")
    assert retry.status_code == 202
    assert retry.json()["parent_execution_id"] == failed["id"]
    assert retry.json()["trigger"] == "retry"
    for i in range(3):
        await launch(owner, lab["agent"]["id"], f"page item {i}")
    page = (
        await owner.client.get(
            f"/api/v1/workspaces/{lab['ws']['id']}/executions", params={"limit": 2}
        )
    ).json()
    assert len(page["data"]) == 2
    assert page["has_more"] is True
    rest = (
        await owner.client.get(
            f"/api/v1/workspaces/{lab['ws']['id']}/executions",
            params={"limit": 10, "cursor": page["next_cursor"]},
        )
    ).json()
    assert len(rest["data"]) == 3
    assert not {e["id"] for e in page["data"]} & {e["id"] for e in rest["data"]}
    found = (
        await owner.client.get(
            f"/api/v1/workspaces/{lab['ws']['id']}/executions", params={"q": "page item 1"}
        )
    ).json()["data"]
    assert len(found) == 1
    by_agent = (
        await owner.client.get(
            f"/api/v1/workspaces/{lab['ws']['id']}/executions",
            params={"agent_id": lab["agent"]["id"], "trigger": "retry"},
        )
    ).json()["data"]
    assert [e["id"] for e in by_agent] == [retry.json()["id"]]


async def test_event_paging(lab: dict[str, Any]) -> None:
    queued = await launch(
        lab["owner"], lab["agent"]["id"], 'x [tool:calculator {"expression": "1+1"}]'
    )
    await drain()
    first = (
        await lab["owner"].client.get(
            f"/api/v1/executions/{queued['id']}/events", params={"limit": 3}
        )
    ).json()
    assert [e["seq"] for e in first["data"]] == [1, 2, 3]
    assert first["has_more"] is True
    rest = (
        await lab["owner"].client.get(
            f"/api/v1/executions/{queued['id']}/events", params={"after": first["next_after"]}
        )
    ).json()
    assert rest["data"][0]["seq"] == 4
    only_tools = (
        await lab["owner"].client.get(
            f"/api/v1/executions/{queued['id']}/events",
            params={"type": ["tool.call", "tool.result"]},
        )
    ).json()
    assert [e["type"] for e in only_tools["data"]] == ["tool.call", "tool.result"]


async def _read_sse(client, url: str, stop_on_end: bool = True) -> list[tuple[str, dict[str, Any]]]:  # type: ignore[no-untyped-def]
    import json

    messages: list[tuple[str, dict[str, Any]]] = []
    async with client.stream("GET", url) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        event_name = "message"
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                messages.append((event_name, json.loads(line[5:])))
                if event_name == "end" and stop_on_end:
                    break
    return messages


async def test_sse_replays_and_streams_live(lab: dict[str, Any]) -> None:
    owner = lab["owner"]
    finished = await launch(owner, lab["agent"]["id"], "replay me")
    await drain()
    replay = await _read_sse(owner.client, f"/api/v1/executions/{finished['id']}/stream")
    assert [name for name, _ in replay][-1] == "end"
    assert [m["type"] for name, m in replay if name == "event"][-1] == "execution.succeeded"
    resumed = await _read_sse(owner.client, f"/api/v1/executions/{finished['id']}/stream?after=3")
    assert next(m["seq"] for name, m in resumed if name == "event") == 4

    live = await launch(owner, lab["agent"]["id"], "[sleep:600] streaming words one two three")
    reader = asyncio.create_task(_read_sse(owner.client, f"/api/v1/executions/{live['id']}/stream"))
    await asyncio.sleep(0.3)
    await drain()
    messages = await asyncio.wait_for(reader, timeout=20)
    names = [name for name, _ in messages]
    assert "delta" in names  # tokens arrived live
    seqs = [m["seq"] for name, m in messages if name == "event"]
    assert seqs == sorted(seqs)
    assert len(seqs) == len(set(seqs))


async def test_stream_requires_access(lab: dict[str, Any], make_client) -> None:  # type: ignore[no-untyped-def]
    queued = await launch(lab["owner"], lab["agent"]["id"], "private")
    stranger = make_client()
    response = await stranger.get(f"/api/v1/executions/{queued['id']}/stream")
    assert response.status_code == 401


async def test_onboarding_now_tracks_the_first_run(lab: dict[str, Any]) -> None:
    owner, ws = lab["owner"], lab["ws"]
    steps = {
        s["key"]: s["done"]
        for s in (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/onboarding")).json()[
            "steps"
        ]
    }
    assert steps["configure_provider"]
    assert steps["create_agent"]
    assert steps["run_execution"] is False
    await launch(owner, lab["agent"]["id"], "first")
    await drain()
    checklist = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/onboarding")).json()
    assert checklist["completed"] == checklist["total"]


async def test_service_keys_can_launch(lab: dict[str, Any], make_client) -> None:  # type: ignore[no-untyped-def]
    key = (
        await lab["owner"].client.post(
            f"/api/v1/workspaces/{lab['ws']['id']}/api-keys", json={"name": "ci", "role": "member"}
        )
    ).json()["key"]
    robot = make_client(csrf=False)
    robot.headers["Authorization"] = f"Bearer {key}"
    launched = await robot.post(
        f"/api/v1/agents/{lab['agent']['id']}/executions", json={"input": "from CI"}
    )
    assert launched.status_code == 202
    assert launched.json()["trigger"] == "api"
    assert launched.json()["triggered_by"] == "API key"
    with contextlib.suppress(Exception):
        await drain()
