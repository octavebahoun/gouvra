"""Workflows: graph validation, templates, drafts and versions, runs and their live view.

Phase 7 exit criterion (server side): a multi-step workflow — agents, a condition, a tool and a
transform — runs to completion, and its progress can be followed live.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.executions.models import Execution, ExecutionStatus
from gouvra.modules.workflows import graph as g
from gouvra.modules.workflows.models import WorkflowRun, WorkflowStep
from gouvra.modules.workflows.orchestrator import advance_run, due_runs, run_tool_step
from gouvra.modules.workflows.worker import workflow_service
from tests.helpers import (
    Account,
    Outbox,
    add_member,
    create_agent,
    create_provider,
    create_workspace,
    drain,
    events_of,
    signup,
)

pytestmark = pytest.mark.usefixtures("outbox")


# ---------------------------------------------------------------- graph builders


def node(node_id: str, type_: str, label: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"id": node_id, "type": type_, "label": label or node_id.title(), **extra}


def edge(source: str, target: str, branch: str | None = None) -> dict[str, Any]:
    link: dict[str, Any] = {"id": f"{source}-{target}", "source": source, "target": target}
    if branch:
        link["branch"] = branch
    return link


def graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], **settings: Any) -> dict:  # type: ignore[type-arg]
    return {"nodes": nodes, "edges": edges, "settings": settings}


def chain(*middle: dict[str, Any]) -> dict[str, Any]:
    """input → middle… → output."""
    nodes = [node("start", "start", "Input"), *middle, node("end", "end", "Output")]
    ids = [n["id"] for n in nodes]
    return graph(nodes, [edge(a, b) for a, b in itertools.pairwise(ids)])


def issues_of(spec: dict[str, Any]) -> set[str]:
    return {i.code for i in g.analyse(g.Graph.model_validate(spec)).issues}


# ---------------------------------------------------------------- validation (pure)


def test_starter_graph_is_valid() -> None:
    assert g.analyse(g.starter_graph()).issues == []


def test_structure_problems_are_reported() -> None:
    assert {"missing_start", "missing_end"} <= issues_of(graph([], []))
    looping = graph(
        [
            node("start", "start"),
            node("a", "transform", template="x"),
            node("b", "transform", template="y"),
            node("end", "end"),
        ],
        [edge("start", "a"), edge("a", "b"), edge("b", "a"), edge("b", "end")],
    )
    assert "cycle" in issues_of(looping)
    stray = graph(
        [node("start", "start"), node("end", "end"), node("lost", "transform", template="x")],
        [edge("start", "end")],
    )
    assert "unreachable" in issues_of(stray)
    duplicates = graph(
        [node("start", "start"), node("start", "end"), node("end", "end")],
        [edge("start", "end"), edge("start", "end"), edge("end", "end")],
    )
    assert {"duplicate_id", "duplicate_edge", "self_loop"} <= issues_of(duplicates)
    backwards = graph(
        [node("start", "start"), node("end", "end")],
        [edge("start", "end"), edge("end", "start"), edge("start", "ghost")],
    )
    assert {"start_has_input", "end_has_output", "unknown_endpoint"} <= issues_of(backwards)


def test_branches_and_warnings() -> None:
    spec = graph(
        [
            node("start", "start"),
            node("check", "condition", value="{{input}}", operand="yes"),
            node("note", "transform", template="x"),
            node("end", "end"),
        ],
        [edge("start", "check", branch="true"), edge("check", "end"), edge("note", "end")],
    )
    found = g.analyse(g.Graph.model_validate(spec)).issues
    codes = {i.code for i in found}
    assert {"unexpected_branch", "missing_branch", "no_true_branch", "no_false_branch"} <= codes
    warnings = {i.code for i in found if i.severity == "warning"}
    assert warnings == {"no_true_branch", "no_false_branch"}
    dead_end = graph(
        [node("start", "start"), node("side", "transform", template="x"), node("end", "end")],
        [edge("start", "side"), edge("start", "end")],
    )
    analysis = g.analyse(g.Graph.model_validate(dead_end))
    assert [(i.code, i.severity) for i in analysis.issues] == [("dead_end", "warning")]
    assert analysis.errors == []


def test_template_references_are_checked() -> None:
    spec = graph(
        [
            node("start", "start", input_schema={"type": "nope"}),
            node("a", "transform", template="{{steps.b.output}} {{nothing}}"),
            node("b", "transform", template="{{steps.a.colour}}"),
            node("check", "condition", value="x", operator="matches", operand="(unclosed"),
            node("end", "end"),
        ],
        [
            edge("start", "a"),
            edge("a", "b"),
            edge("b", "check"),
            edge("check", "end", "true"),
            edge("check", "end", "false"),
        ],
    )
    codes = issues_of(spec)
    assert {
        "unavailable_reference",
        "unknown_reference",
        "unknown_field",
        "invalid_pattern",
        "invalid_input_schema",
    } <= codes


# ---------------------------------------------------------------- templates and conditions


def _context() -> g.RunContext:
    return g.RunContext(
        input={"json": {"order": {"id": 12, "items": ["book", "pen"]}, "note": "Refund"}},
        steps={
            "classify": g.StepValue(
                output="Echo: refund", json={"label": "refund"}, status="succeeded"
            ),
            "lookup": g.StepValue(status="failed", error="Not found"),
        },
    )


def test_templates_render_values_and_keep_types() -> None:
    context = _context()
    assert (
        g.render("Order {{ input.order.id }}: {{input.order.items.1}}", context) == "Order 12: pen"
    )
    assert g.render("{{steps.classify}} / {{steps.classify.json.label}}", context) == (
        "Echo: refund / refund"
    )
    assert g.render("{{steps.lookup.status}}: {{steps.lookup.error}}", context) == (
        "failed: Not found"
    )
    assert g.render("[{{steps.missing.output}}][{{input.order.zip}}]", context) == "[][]"
    assert g.render("{{input.order}}", context) == '{"id": 12, "items": ["book", "pen"]}'
    rendered = g.render_value(
        {
            "id": "{{input.order.id}}",
            "label": "#{{input.order.id}}",
            "list": ["{{input.order.items}}"],
        },
        context,
    )
    assert rendered == {"id": 12, "label": "#12", "list": [["book", "pen"]]}
    text_only = g.RunContext(input={"text": "plain"})
    assert g.render("{{input}}|{{input.x}}", text_only) == "plain|"
    assert g.references("{{input}} {{ steps.a.json.b }}") == [
        ["input"],
        ["steps", "a", "json", "b"],
    ]


def test_parse_json_finds_fenced_or_bare_objects() -> None:
    assert g.parse_json('{"a": 1}') == {"a": 1}
    assert g.parse_json("Here:\n```json\n[1, 2]\n```") == [1, 2]
    assert g.parse_json("not json") is None
    assert g.parse_json("{broken") is None
    assert g.parse_json(None) is None


def _condition(operator: str, value: str, operand: str = "", **extra: Any) -> g.ConditionNode:
    return g.ConditionNode(
        id="c",
        label="C",
        value=value,
        operator=operator,
        operand=operand,
        **extra,  # type: ignore[arg-type]
    )


def test_conditions() -> None:
    context = _context()
    assert g.evaluate(_condition("contains", "{{steps.classify}}", "REFUND"), context) == (
        True,
        "Echo: refund",
    )
    assert not g.evaluate(
        _condition("contains", "{{input.note}}", "refund", case_sensitive=True), context
    )[0]
    assert g.evaluate(_condition("not_contains", "abc", "z"), context)[0]
    assert g.evaluate(_condition("equals", " Yes ", "yes"), context)[0]
    assert g.evaluate(_condition("not_equals", "a", "b"), context)[0]
    assert g.evaluate(_condition("is_empty", "{{steps.missing}}"), context)[0]
    assert g.evaluate(_condition("not_empty", "{{input.note}}"), context)[0]
    assert g.evaluate(_condition("matches", "Ticket #4821", r"#\d{4}"), context)[0]
    assert g.evaluate(_condition("gt", "{{input.order.id}}", "10"), context)[0]
    assert g.evaluate(_condition("lte", "3", "3.0"), context)[0]
    with pytest.raises(g.ConditionError, match="as numbers"):
        g.evaluate(_condition("lt", "many", "3"), context)
    with pytest.raises(g.ConditionError, match="too long"):
        g.evaluate(_condition("matches", "1" * 5000, r"(\d+)*\D"), context)


# ---------------------------------------------------------------- API helpers


async def settle() -> None:
    """The worker in miniature: advance runs, run their tool steps and agents, until idle."""
    for _ in range(100):
        progressed = False
        for run_id in await due_runs():
            progressed = True
            for job in await advance_run(run_id):
                await run_tool_step(job)
        if await drain():
            progressed = True
        if not progressed:
            return
    raise AssertionError("workflows did not settle")


async def create_workflow(
    owner: Account, workspace_id: str, spec: dict[str, Any] | None = None, name: str = "Triage"
) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": name, "description": "Sorts support requests."}
    if spec is not None:
        payload["graph"] = spec
    response = await owner.client.post(f"/api/v1/workspaces/{workspace_id}/workflows", json=payload)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def publish(owner: Account, workflow_id: str, note: str | None = None) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/workflows/{workflow_id}/publish", json={"note": note}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def start(owner: Account, workflow_id: str, value: Any, **extra: Any) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/workflows/{workflow_id}/runs", json={"input": value, **extra}
    )
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    return body


async def run_of(owner: Account, run_id: str) -> dict[str, Any]:
    response = await owner.client.get(f"/api/v1/workflow-runs/{run_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def published(owner: Account, workspace_id: str, spec: dict[str, Any], name: str) -> str:
    workflow = await create_workflow(owner, workspace_id, spec, name=name)
    await publish(owner, workflow["id"])
    return str(workflow["id"])


def statuses(run: dict[str, Any]) -> dict[str, str]:
    return {s["node_id"]: s["status"] for s in run["steps"]}


def step(run: dict[str, Any], node_id: str) -> dict[str, Any]:
    return next(s for s in run["steps"] if s["node_id"] == node_id)


async def read_stream(client: Any, url: str) -> list[tuple[str, dict[str, Any]]]:
    messages: list[tuple[str, dict[str, Any]]] = []
    async with client.stream("GET", url) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        name = "message"
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                messages.append((name, json.loads(line[5:])))
                if name == "end":
                    break
    return messages


def triage_graph(classifier: str, writer: str, calculator: str) -> dict[str, Any]:
    return graph(
        [
            node("start", "start", "Request"),
            node("classify", "agent", "Classify", agent_id=classifier, input="{{input.message}}"),
            node(
                "check",
                "condition",
                "Is it a refund?",
                value="{{steps.classify.output}}",
                operator="contains",
                operand="refund",
            ),
            node(
                "compute",
                "tool",
                "Compute refund",
                tool_id=calculator,
                arguments={"expression": "{{input.amount}} * 2"},
            ),
            node(
                "confirm",
                "transform",
                "Confirmation",
                template="Refund of {{steps.compute.json.result}} approved — {{steps.classify}}",
            ),
            node("reply", "agent", "Reply", agent_id=writer, input="Reply to: {{input.message}}"),
            node("end", "end", "Answer"),
        ],
        [
            edge("start", "classify"),
            edge("classify", "check"),
            edge("check", "compute", "true"),
            edge("compute", "confirm"),
            edge("confirm", "end"),
            edge("check", "reply", "false"),
            edge("reply", "end"),
        ],
    )


# ---------------------------------------------------------------- runs


async def test_multi_step_workflow_runs_both_branches(lab: dict[str, Any]) -> None:
    """Phase 7 exit criterion: agents, a condition, a tool and a transform, run end to end."""
    owner: Account = lab["owner"]
    ws = lab["ws"]
    writer = await create_agent(owner, ws["id"], lab["provider"]["id"], name="Writer")
    spec = triage_graph(lab["agent"]["id"], writer["id"], lab["calc"]["id"])
    workflow = await create_workflow(owner, ws["id"], spec)
    assert workflow["issues"] == []
    assert workflow["can_publish"] is True
    assert (workflow["node_count"], workflow["agent_count"]) == (7, 2)
    version = await publish(owner, workflow["id"], "First version")
    assert (version["number"], version["note"], version["is_current"]) == (1, "First version", True)

    refund = await start(owner, workflow["id"], {"message": "I want a refund", "amount": 21})
    assert refund["status"] == "running"
    assert refund["version"] == 1
    assert refund["steps_total"] == 7
    assert [s["node_id"] for s in refund["steps"]][:2] == ["start", "classify"]
    assert set(statuses(refund).values()) == {"pending"}
    await settle()

    done = await run_of(owner, refund["id"])
    assert done["status"] == "succeeded", done["error"]
    assert done["output"]["text"] == "Refund of 42 approved — Echo: I want a refund"
    assert statuses(done) == {
        "start": "succeeded",
        "classify": "succeeded",
        "check": "succeeded",
        "compute": "succeeded",
        "confirm": "succeeded",
        "reply": "skipped",
        "end": "succeeded",
    }
    assert step(done, "check")["branch"] == "true"
    assert step(done, "compute")["output"]["json"]["result"] == 42
    assert step(done, "compute")["input"] == {"expression": "21 * 2"}
    assert (done["steps_done"], done["duration_ms"] is not None) == (7, True)
    assert done["input_tokens"] > 0
    assert '"message": "I want a refund"' in done["input_preview"]

    # The agent step is an ordinary execution, linked to the run and traced as such.
    classify = step(done, "classify")
    assert classify["attempt"] == 1
    assert classify["input_tokens"] > 0
    execution = (await owner.client.get(f"/api/v1/executions/{classify['execution_id']}")).json()
    assert execution["trigger"] == "workflow"
    assert execution["status"] == "succeeded"
    events = await events_of(classify["execution_id"])
    assert events[0].type == "execution.queued"
    assert events[0].data["workflow"] == "Triage"
    assert events[0].data["workflow_step"] == "Classify"

    other = await start(owner, workflow["id"], {"message": "Where is my parcel?", "amount": 0})
    await settle()
    parcel = await run_of(owner, other["id"])
    assert parcel["status"] == "succeeded"
    assert parcel["output"]["text"] == "Echo: Reply to: Where is my parcel?"
    assert step(parcel, "check")["branch"] == "false"
    # A condition passes the value it tested on (here the classifier's answer).
    assert step(parcel, "check")["output"]["text"] == "Echo: Where is my parcel?"
    assert (statuses(parcel)["compute"], statuses(parcel)["confirm"]) == ("skipped", "skipped")

    listing = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/workflow-runs",
            params={"workflow_id": workflow["id"], "limit": 1},
        )
    ).json()
    assert [r["id"] for r in listing["data"]] == [other["id"]]
    assert listing["next_cursor"]
    filtered = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/workflow-runs", params={"status": "failed"}
        )
    ).json()
    assert filtered["data"] == []
    summary = (await owner.client.get(f"/api/v1/workflows/{workflow['id']}")).json()
    assert summary["last_run"]["id"] == other["id"]
    using = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/workflows", params={"agent_id": writer["id"]}
        )
    ).json()
    assert [w["id"] for w in using] == [workflow["id"]]


async def test_run_progress_is_streamed_live(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    spec = chain(
        node("think", "agent", "Think", agent_id=lab["agent"]["id"], input="{{input}}"),
        node("shout", "transform", "Shout", template="{{steps.think}}!"),
    )
    workflow_id = await published(owner, lab["ws"]["id"], spec, "Live")
    run = await start(owner, workflow_id, "hello")
    url = f"/api/v1/workflow-runs/{run['id']}/stream"
    reader = asyncio.create_task(read_stream(owner.client, url))
    await asyncio.sleep(0.3)
    await settle()
    messages = await asyncio.wait_for(reader, timeout=20)
    names = [name for name, _ in messages]
    assert names[0] == "snapshot"
    assert names[-1] == "end"
    snapshots = [body for name, body in messages if name == "snapshot"]
    assert snapshots[0]["run"]["status"] == "running"
    assert snapshots[-1]["run"]["status"] == "succeeded"
    assert snapshots[-1]["run"]["output"]["text"] == "Echo: hello!"
    done = [s["run"]["steps_done"] for s in snapshots]
    assert done == sorted(done)
    assert any(
        next(st for st in s["steps"] if st["node_id"] == "think")["status"] == "running"
        for s in snapshots
    ), "the agent step was seen running"
    # A finished run streams its final state at once.
    replay = await read_stream(owner.client, url)
    assert [name for name, _ in replay] == ["snapshot", "end"]
    assert messages[-1][1] == {"status": "succeeded"}


async def test_failures_retries_and_continue_on_error(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws_id, agent_id = lab["ws"]["id"], lab["agent"]["id"]
    flaky = chain(
        node(
            "flaky",
            "agent",
            "Flaky",
            agent_id=agent_id,
            input="{{input}} [fail:provider_unavailable]",
            retries=1,
        ),
        node("after", "transform", "After", template="never"),
    )
    run = await start(owner, await published(owner, ws_id, flaky, "Flaky"), "hi")
    await settle()
    failed = await run_of(owner, run["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "provider_unavailable"
    assert failed["error"]["step"] == "flaky"
    assert failed["error"]["message"].startswith("Step “Flaky” failed: Simulated failure")
    assert statuses(failed) == {
        "start": "succeeded",
        "flaky": "failed",
        "after": "skipped",
        "end": "skipped",
    }
    assert step(failed, "flaky")["attempt"] == 2  # one retry, then it gave up
    async with get_sessionmaker()() as db:
        attempts = (
            await db.execute(select(Execution).where(Execution.workflow_run_id == run["id"]))
        ).scalars()
        assert [e.status for e in attempts] == ["failed", "failed"]

    tolerant = chain(
        node(
            "flaky",
            "agent",
            "Flaky",
            agent_id=agent_id,
            input="[fail:provider_bad_request]",
            retries=3,
            on_error="continue",
        ),
        node("note", "transform", "Note", template="{{steps.flaky.status}}: {{steps.flaky.error}}"),
    )
    run = await start(owner, await published(owner, ws_id, tolerant, "Tolerant"), "hi")
    await settle()
    survived = await run_of(owner, run["id"])
    assert survived["status"] == "succeeded"
    assert survived["output"]["text"].startswith("failed: Simulated failure")
    assert step(survived, "flaky")["attempt"] == 1  # not retryable: no retry


async def test_step_errors_fail_the_run(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws_id = lab["ws"]["id"]
    cases = {
        "condition_error": chain(
            node("check", "condition", value="{{input}}", operator="gt", operand="3"),
        ),
        "invalid_json": chain(node("shape", "transform", template="{{input}}", output="json")),
        "tool_error": chain(
            node("calc", "tool", tool_id=lab["calc"]["id"], arguments={"expression": "{{input}}"})
        ),
    }
    # The condition's branches both lead on, so only the comparison itself can fail.
    condition = cases["condition_error"]
    condition["edges"] = [
        edge("start", "check"),
        edge("check", "end", "true"),
        {**edge("check", "end", "false"), "id": "check-end-false"},
    ]
    for code, spec in cases.items():
        run = await start(owner, await published(owner, ws_id, spec, code), "not a number")
        await settle()
        failed = await run_of(owner, run["id"])
        assert failed["status"] == "failed", code
        assert failed["error"]["code"] == code
        assert failed["steps_done"] == failed["steps_total"]


async def test_cancel_timeout_and_lost_tool_steps(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws_id = lab["ws"]["id"]
    spec = chain(node("slow", "agent", "Slow", agent_id=lab["agent"]["id"], input="{{input}}"))
    workflow_id = await published(owner, ws_id, spec, "Slow")

    # Cancelled while its agent waits in the queue: the execution is cancelled with it.
    run = await start(owner, workflow_id, "wait")
    await advance_run(run["id"])
    queued = step(await run_of(owner, run["id"]), "slow")
    assert queued["status"] == "running"
    response = await owner.client.post(f"/api/v1/workflow-runs/{run['id']}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["cancel_requested_at"] is not None
    await settle()
    cancelled = await run_of(owner, run["id"])
    assert cancelled["status"] == "cancelled"
    assert statuses(cancelled) == {"start": "succeeded", "slow": "cancelled", "end": "skipped"}
    child = (await owner.client.get(f"/api/v1/executions/{queued['execution_id']}")).json()
    assert child["status"] == "cancelled"
    assert [e.type for e in await events_of(queued["execution_id"])][-1] == "execution.cancelled"
    again = await owner.client.post(f"/api/v1/workflow-runs/{run['id']}/cancel")
    assert (again.status_code, again.json()["code"]) == (409, "run_finished")

    # Out of time while its agent is running: the worker is asked to stop it.
    run = await start(owner, workflow_id, "late")
    await advance_run(run["id"])
    running = step(await run_of(owner, run["id"]), "slow")
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Execution)
            .where(Execution.id == running["execution_id"])
            .values(status=ExecutionStatus.RUNNING)
        )
        await db.execute(
            update(WorkflowRun)
            .where(WorkflowRun.id == run["id"])
            .values(deadline_at=utcnow() - timedelta(seconds=1))
        )
        await db.commit()
    await advance_run(run["id"])
    timed_out = await run_of(owner, run["id"])
    assert timed_out["status"] == "timed_out"
    assert timed_out["error"]["code"] == "timeout"
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, running["execution_id"])
        assert execution is not None
        assert execution.cancel_requested_at is not None
    types = [e.type for e in await events_of(running["execution_id"])]
    assert types[-1] == "execution.cancel_requested"

    # A tool step whose worker vanished is failed once its deadline passes.
    tool_spec = chain(
        node("calc", "tool", tool_id=lab["calc"]["id"], arguments={"expression": "1+1"})
    )
    run = await start(owner, await published(owner, ws_id, tool_spec, "Lost"), "x")
    jobs = await advance_run(run["id"])
    assert len(jobs) == 1  # handed to a worker… that never runs it
    async with get_sessionmaker()() as db:
        await db.execute(
            update(WorkflowStep)
            .where(WorkflowStep.run_id == run["id"], WorkflowStep.node_id == "calc")
            .values(deadline_at=utcnow() - timedelta(seconds=1))
        )
        await db.commit()
    await advance_run(run["id"])
    lost = await run_of(owner, run["id"])
    assert lost["status"] == "failed"
    assert lost["error"]["code"] == "worker_lost"
    await run_tool_step(jobs[0])  # a late result changes nothing
    assert (await run_of(owner, run["id"]))["status"] == "failed"


async def test_outputs_of_parallel_paths_and_runs_without_output(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws_id = lab["ws"]["id"]
    parallel = graph(
        [
            node("start", "start"),
            node("a", "transform", template="A: {{input}}"),
            node("b", "transform", template='{"b": "{{input}}"}', output="json"),
            node("end_a", "end", output="{{steps.a}}"),
            node("end_b", "end"),
        ],
        [edge("start", "a"), edge("start", "b"), edge("a", "end_a"), edge("b", "end_b")],
    )
    run = await start(owner, await published(owner, ws_id, parallel, "Parallel"), "hi")
    await settle()
    both = await run_of(owner, run["id"])
    assert both["status"] == "succeeded"
    assert both["output"]["json"] == {"end_a": "A: hi", "end_b": {"b": "hi"}}

    one_way = graph(
        [
            node("start", "start"),
            node("check", "condition", value="{{input}}", operator="equals", operand="yes"),
            node("end", "end"),
        ],
        [edge("start", "check"), edge("check", "end", "true")],
    )
    after_condition = graph(
        [
            node("start", "start"),
            node("check", "condition", value="{{input}}", operator="equals", operand="yes"),
            node("shout", "transform", template="{{input}}!"),
            node("end", "end"),
        ],
        [
            edge("start", "check"),
            edge("check", "shout", "true"),
            edge("shout", "end"),
            {**edge("check", "end", "false"), "id": "check-end-false"},
        ],
    )
    run = await start(owner, await published(owner, ws_id, after_condition, "Joined"), "no")
    await settle()
    joined = await run_of(owner, run["id"])
    assert (joined["status"], joined["output"]["text"]) == ("succeeded", "no")
    workflow = await create_workflow(owner, ws_id, one_way, name="One way")
    assert {i["code"] for i in workflow["issues"]} == {"no_false_branch"}  # a warning only
    assert workflow["can_publish"] is True
    await publish(owner, workflow["id"])
    run = await start(owner, workflow["id"], "no")
    await settle()
    nowhere = await run_of(owner, run["id"])
    assert nowhere["status"] == "failed"
    assert nowhere["error"]["code"] == "no_output"
    assert statuses(nowhere)["end"] == "skipped"


async def test_draft_lifecycle_versions_and_conflicts(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws_id = lab["ws"]["id"]
    workflow = await create_workflow(owner, ws_id)
    wid = workflow["id"]
    assert [n["type"] for n in workflow["draft"]["nodes"]] == ["start", "end"]
    assert (workflow["draft_revision"], workflow["current_version"]) == (1, None)
    assert workflow["has_unpublished_changes"] is True
    taken = await owner.client.post(
        f"/api/v1/workspaces/{ws_id}/workflows", json={"name": "Triage"}
    )
    assert (taken.status_code, taken.json()["errors"][0]["code"]) == (422, "taken")

    not_published = await owner.client.post(f"/api/v1/workflows/{wid}/runs", json={"input": "x"})
    assert (not_published.status_code, not_published.json()["code"]) == (
        409,
        "workflow_not_published",
    )
    draft_run = await start(owner, wid, "draft input", draft=True)
    assert draft_run["version"] is None
    await settle()
    assert (await run_of(owner, draft_run["id"]))["output"]["text"] == "draft input"

    shout = chain(node("shout", "transform", "Shout", template="{{input}}!"))
    saved = await owner.client.put(
        f"/api/v1/workflows/{wid}/draft", json={"graph": shout, "revision": 1}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["draft_revision"] == 2
    stale = await owner.client.put(
        f"/api/v1/workflows/{wid}/draft", json={"graph": shout, "revision": 1}
    )
    assert (stale.status_code, stale.json()["code"]) == (409, "draft_conflict")
    assert stale.json()["details"]["revision"] == 2

    await publish(owner, wid)
    same = await owner.client.post(f"/api/v1/workflows/{wid}/publish", json={})
    assert (same.status_code, same.json()["code"]) == (409, "nothing_to_publish")
    current = (await owner.client.get(f"/api/v1/workflows/{wid}")).json()
    assert (current["current_version"], current["has_unpublished_changes"]) == (1, False)
    assert current["can_publish"] is False

    looping = chain(node("a", "transform", template="x"))
    looping["edges"].append(edge("a", "start"))
    broken = await owner.client.put(
        f"/api/v1/workflows/{wid}/draft", json={"graph": looping, "revision": 2}
    )
    issues = {i["code"] for i in broken.json()["issues"]}
    assert {"cycle", "start_has_input"} <= issues
    assert broken.json()["can_publish"] is False
    refused = await owner.client.post(f"/api/v1/workflows/{wid}/publish", json={})
    assert (refused.status_code, refused.json()["code"]) == (409, "workflow_invalid")
    assert refused.json()["details"]["issues"]
    draft_refused = await owner.client.post(
        f"/api/v1/workflows/{wid}/runs", json={"input": "x", "draft": True}
    )
    assert draft_refused.json()["code"] == "workflow_invalid"
    # The published version still runs while the draft is broken.
    run = await start(owner, wid, "still")
    await settle()
    assert (await run_of(owner, run["id"]))["output"]["text"] == "still!"
    unknown = await owner.client.post(
        f"/api/v1/workflows/{wid}/runs", json={"input": "x", "version": 9}
    )
    assert unknown.status_code == 422

    restored = await owner.client.post(f"/api/v1/workflows/{wid}/versions/1/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["draft_revision"] == 4
    assert restored.json()["issues"] == []
    versions = (await owner.client.get(f"/api/v1/workflows/{wid}/versions")).json()
    assert [(v["number"], v["is_current"]) for v in versions] == [(1, True)]
    assert versions[0]["created_by"] == "Test User"

    renamed = await owner.client.patch(
        f"/api/v1/workflows/{wid}", json={"name": "Triage v2", "description": "New"}
    )
    assert (renamed.json()["name"], renamed.json()["description"]) == ("Triage v2", "New")

    archived = await owner.client.post(f"/api/v1/workflows/{wid}/archive")
    assert archived.json()["archived"] is True
    blocked = await owner.client.post(f"/api/v1/workflows/{wid}/runs", json={"input": "x"})
    assert blocked.json()["code"] == "workflow_archived"
    listed = (await owner.client.get(f"/api/v1/workspaces/{ws_id}/workflows")).json()
    assert wid not in [w["id"] for w in listed]
    everything = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws_id}/workflows", params={"include_archived": True}
        )
    ).json()
    assert wid in [w["id"] for w in everything]
    await owner.client.post(f"/api/v1/workflows/{wid}/restore")
    kept = await owner.client.delete(f"/api/v1/workflows/{wid}")
    assert (kept.status_code, kept.json()["code"]) == (409, "workflow_has_history")
    fresh = await create_workflow(owner, ws_id, name="Scratch")
    assert (await owner.client.delete(f"/api/v1/workflows/{fresh['id']}")).status_code == 204
    assert (await owner.client.get(f"/api/v1/workflows/{fresh['id']}")).status_code == 404

    audit = (await owner.client.get(f"/api/v1/workspaces/{ws_id}/audit-events")).json()
    actions = {e["action"] for e in audit["data"]}
    assert {
        "workflow.created",
        "workflow.published",
        "workflow.run_started",
        "workflow.archived",
        "workflow.deleted",
    } <= actions


async def test_input_schema_and_idempotent_starts(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    spec = chain(node("echo", "transform", template="{{input.message}}"))
    spec["nodes"][0]["input_schema"] = {
        "type": "object",
        "required": ["message"],
        "properties": {"message": {"type": "string"}},
    }
    wid = await published(owner, lab["ws"]["id"], spec, "Typed")
    wrong = await owner.client.post(f"/api/v1/workflows/{wid}/runs", json={"input": "plain text"})
    assert wrong.status_code == 422
    assert "does not match" in wrong.json()["errors"][0]["message"]

    url = f"/api/v1/workflows/{wid}/runs"
    headers = {"Idempotency-Key": "delivery-1"}
    first = await owner.client.post(url, json={"input": {"message": "hi"}}, headers=headers)
    replay = await owner.client.post(url, json={"input": {"message": "hi"}}, headers=headers)
    assert (first.status_code, replay.status_code) == (202, 200)
    assert first.json()["id"] == replay.json()["id"]
    mismatch = await owner.client.post(url, json={"input": {"message": "bye"}}, headers=headers)
    assert (mismatch.status_code, mismatch.json()["code"]) == (422, "idempotency_mismatch")


async def test_references_and_roles(lab: dict[str, Any], make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner: Account = lab["owner"]
    ws_id = lab["ws"]["id"]
    # Another tenant's agent cannot be used, even by id.
    stranger = await signup(make_client(), outbox, "stranger@example.com")
    elsewhere = await create_workspace(stranger, "Elsewhere")
    their_provider = await create_provider(stranger, elsewhere["id"])
    their_agent = await create_agent(stranger, elsewhere["id"], their_provider["id"])
    borrowed = chain(node("steal", "agent", agent_id=their_agent["id"]))
    workflow = await create_workflow(owner, ws_id, borrowed, name="Borrowed")
    assert [i["code"] for i in workflow["issues"]] == ["unknown_agent"]
    refused = await owner.client.post(f"/api/v1/workflows/{workflow['id']}/publish", json={})
    assert refused.json()["code"] == "workflow_invalid"
    sneaky = await owner.client.post(
        f"/api/v1/workflows/{workflow['id']}/runs", json={"input": "x", "draft": True}
    )
    assert sneaky.json()["code"] == "workflow_invalid"

    # Archived agents and disabled tools are flagged in the editor.
    spare = await create_agent(owner, ws_id, lab["provider"]["id"], name="Spare")
    await owner.client.post(f"/api/v1/agents/{spare['id']}/archive")
    await owner.client.patch(f"/api/v1/tools/{lab['clock']['id']}", json={"status": "disabled"})
    stale = chain(
        node("old", "agent", agent_id=spare["id"]),
        node("clock", "tool", tool_id=lab["clock"]["id"]),
    )
    flagged = await create_workflow(owner, ws_id, stale, name="Stale")
    assert {i["code"] for i in flagged["issues"]} == {"agent_archived", "tool_disabled"}

    # Viewers read, members build and run.
    viewer = await signup(make_client(), outbox, "viewer@example.com")
    member = await signup(make_client(), outbox, "member@example.com", name="Member")
    await add_member(owner, ws_id, viewer, outbox, "viewer")
    await add_member(owner, ws_id, member, outbox, "member")
    spec = chain(node("echo", "transform", template="{{input}}"))
    wid = await published(owner, ws_id, spec, "Shared")
    run = await start(owner, wid, "x")
    assert (await viewer.client.get(f"/api/v1/workflows/{wid}")).status_code == 200
    assert (await viewer.client.get(f"/api/v1/workflow-runs/{run['id']}")).status_code == 200
    forbidden = [
        await viewer.client.post(f"/api/v1/workspaces/{ws_id}/workflows", json={"name": "V"}),
        await viewer.client.put(
            f"/api/v1/workflows/{wid}/draft", json={"graph": spec, "revision": 1}
        ),
        await viewer.client.post(f"/api/v1/workflows/{wid}/publish", json={}),
        await viewer.client.post(f"/api/v1/workflows/{wid}/runs", json={"input": "x"}),
        await viewer.client.post(f"/api/v1/workflow-runs/{run['id']}/cancel"),
    ]
    assert [r.status_code for r in forbidden] == [403] * 5
    mine = await create_workflow(member, ws_id, spec, name="Member's")
    member_run = await start(member, mine["id"], "x", draft=True)
    assert member_run["created_by"] == "Member"


async def test_worker_service_runs_workflows(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    spec = chain(
        node("think", "agent", agent_id=lab["agent"]["id"], input="{{input}}"),
        node("calc", "tool", tool_id=lab["calc"]["id"], arguments={"expression": "6 * 7"}),
        node("say", "transform", template="{{steps.think}} = {{steps.calc.json.result}}"),
    )
    run = await start(owner, await published(owner, lab["ws"]["id"], spec, "Worker"), "answer")
    stop = asyncio.Event()
    service = asyncio.create_task(workflow_service(stop))
    try:
        for _ in range(200):
            await drain()  # the execution worker's part; its finish hook wakes the service
            if (await run_of(owner, run["id"]))["status"] != "running":
                break
            await asyncio.sleep(0.05)
        done = await run_of(owner, run["id"])
        assert done["status"] == "succeeded", done
        assert done["output"]["text"] == "Echo: answer = 42"
    finally:
        stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(service, timeout=10)
