"""Evaluations: graders, suites and cases, runs, cancellation, judges and comparisons.

Phase 6 exit criterion: run one suite against two versions of an agent and compare them.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import pytest
from sqlalchemy import select

from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker
from gouvra.modules.evaluations import graders as g
from gouvra.modules.evaluations.service import grade_pending
from gouvra.modules.evaluations.worker import evaluation_service
from gouvra.modules.executions.models import UsageRecord
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

JSON_ANSWER = {
    "type": "object",
    "required": ["answer"],
    "properties": {"answer": {"type": "string"}},
}


# ---------------------------------------------------------------- graders (pure)


def test_exact_grader_normalises_whitespace_and_case() -> None:
    assert g.grade_exact(g.ExactGrader(), "  Hello   World ", {"text": "hello world"}).passed
    assert not g.grade_exact(g.ExactGrader(case_sensitive=True), "Hello", {"text": "hello"}).passed
    assert g.grade_exact(g.ExactGrader(expected="42"), "42", None).passed
    assert g.grade_exact(g.ExactGrader(), "x", None).error == "missing_expected"


def test_contains_grader_modes_and_partial_score() -> None:
    both = g.ContainsGrader(values=["refund", "invoice"])
    result = g.grade_contains(both, "Your REFUND is on its way")
    assert (result.passed, result.score) == (False, 0.5)
    assert "missing: invoice" in result.details
    anyone = g.ContainsGrader(values=["refund", "invoice"], mode="any")
    assert g.grade_contains(anyone, "refund").passed
    strict = g.ContainsGrader(values=["refund"], mode="any", case_sensitive=True)
    assert not g.grade_contains(strict, "REFUND").passed
    forbidden = g.ContainsGrader(values=["password"], mode="none")
    assert g.grade_contains(forbidden, "All good").passed
    assert not g.grade_contains(forbidden, "your Password is").passed


def test_regex_grader_is_time_boxed() -> None:
    assert g.grade_regex(g.RegexGrader(pattern=r"#\d{4}"), "Ticket #4821").passed
    assert g.grade_regex(g.RegexGrader(pattern="error", should_match=False), "all fine").passed
    assert g.grade_regex(g.RegexGrader(pattern="(unclosed"), "x").error == "invalid_pattern"
    # Catastrophic backtracking is cut short instead of pinning the worker.
    slow = g.grade_regex(g.RegexGrader(pattern=r"(\d+)*\D"), "1" * 5000)
    assert slow.error == "regex_timeout"
    assert not slow.passed


def test_json_schema_grader() -> None:
    spec = g.JsonSchemaGrader(schema=JSON_ANSWER)
    assert g.grade_json_schema(spec, '{"answer": "ok"}', None).passed
    assert g.grade_json_schema(spec, '```json\n{"answer": "ok"}\n```', None).passed
    assert g.grade_json_schema(spec, "", {"answer": "structured output"}).passed
    violation = g.grade_json_schema(spec, '{"answer": 3}', None)
    assert not violation.passed
    assert "answer" in violation.details
    assert g.grade_json_schema(spec, "not json", None).details == "The output is not valid JSON."
    broken = g.grade_json_schema(g.JsonSchemaGrader(schema={"type": "nope"}), "{}", None)
    assert broken.error == "invalid_schema"


def test_judge_parsing_and_score_combination() -> None:
    assert g.parse_judge('{"score": 0.8, "reasoning": "Good"}') == (0.8, "Good")
    assert g.parse_judge('```json\n{"score": 7}\n```')[0] == 0.7  # 0-10 scale accepted
    with pytest.raises(ValueError, match="out of range"):
        g.parse_judge('{"score": 42}')
    with pytest.raises(KeyError):
        g.parse_judge('{"verdict": "great"}')
    ok = g.GraderResult("exact", True, 1.0, "", weight=3)
    partial = g.GraderResult("contains", False, 0.5, "", weight=1)
    assert g.combine([ok, partial], 0.5) == ("failed", 0.875)  # every grader must pass
    assert g.combine([ok], 1.0) == ("passed", 1.0)
    assert g.combine([], 1.0) == ("errored", None)
    timeout = g.GraderResult("regex", False, 0.0, "", error="regex_timeout")
    assert g.combine([ok, timeout], 0.0) == ("errored", None)
    assert ok.as_dict()["weight"] == 3


# ---------------------------------------------------------------- helpers


async def _suite(owner: Account, workspace_id: str, **extra: Any) -> dict[str, Any]:
    response = await owner.client.post(
        f"/api/v1/workspaces/{workspace_id}/evaluations/suites",
        json={"name": extra.pop("name", "Support quality"), **extra},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def _import(
    owner: Account, suite_id: str, cases: list[dict[str, Any]], *, replace: bool = False
) -> list[dict[str, Any]]:
    response = await owner.client.post(
        f"/api/v1/evaluations/suites/{suite_id}/cases/import",
        json={"cases": cases, "replace": replace},
    )
    assert response.status_code == 200, response.text
    body: list[dict[str, Any]] = response.json()
    return body


async def _run(owner: Account, suite_id: str, agent_id: str, **extra: Any) -> dict[str, Any]:
    response = await owner.client.post(
        "/api/v1/evaluations/runs", json={"suite_id": suite_id, "agent_id": agent_id, **extra}
    )
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    return body


async def _settle() -> None:
    """The worker loop in miniature: run the queued executions, then grade them."""
    await drain()
    while await grade_pending() > 0:
        pass


async def _detail(owner: Account, run_id: str) -> dict[str, Any]:
    response = await owner.client.get(f"/api/v1/evaluations/runs/{run_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# ---------------------------------------------------------------- API flows


async def test_compare_two_agent_versions(lab: dict[str, Any]) -> None:
    """Phase 6 exit criterion: one suite, two versions of an agent, a case-by-case verdict."""
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    suite = await _suite(
        owner,
        ws["id"],
        agent_id=agent["id"],
        default_graders=[{"type": "json_schema", "schema": JSON_ANSWER}],
    )
    assert suite["agent_name"] == "Helper"
    await _import(
        owner,
        suite["id"],
        [
            {"name": "Refund request", "input": "I want a refund for order 12"},
            {"name": "Invoice copy", "input": "Send me an invoice copy", "tags": ["billing"]},
            {"name": "Bug report", "input": "The export button does nothing"},
        ],
    )
    baseline = await _run(owner, suite["id"], agent["id"], label="Plain text")
    assert baseline["status"] == "running"
    assert baseline["summary"]["pending"] == 3
    assert baseline["agent_version"] == 1

    # Version 2 answers in JSON mode: the change under evaluation.
    patched = await owner.client.patch(
        f"/api/v1/agents/{agent['id']}", json={"parameters": {"response_format": "json"}}
    )
    assert patched.status_code == 200, patched.text
    candidate = await _run(owner, suite["id"], agent["id"])
    assert candidate["agent_version"] == 2
    assert candidate["label"] == "Helper v2"
    await _settle()

    first, second = await _detail(owner, baseline["id"]), await _detail(owner, candidate["id"])
    assert first["status"] == second["status"] == "completed"
    assert first["finished_at"] is not None
    assert first["summary"]["pass_rate"] == 0.0
    assert second["summary"]["pass_rate"] == 1.0
    assert [r["case_name"] for r in second["results"]] == [
        "Refund request",
        "Invoice copy",
        "Bug report",
    ]
    assert {r["status"] for r in second["results"]} == {"passed"}
    assert second["results"][0]["grader_results"][0]["type"] == "json_schema"
    assert second["results"][0]["output_text"].startswith('{"answer"')
    assert second["summary"]["input_tokens"] > 0
    assert second["summary"]["avg_duration_ms"] is not None

    comparison = await owner.client.get(
        "/api/v1/evaluations/compare",
        params={"base": baseline["id"], "candidate": candidate["id"]},
    )
    assert comparison.status_code == 200, comparison.text
    verdict = comparison.json()
    assert verdict["pass_rate_delta"] == 1.0
    assert (verdict["improved"], verdict["regressed"], verdict["unchanged"]) == (3, 0, 0)
    assert [c["change"] for c in verdict["cases"]] == ["improved"] * 3
    assert verdict["cases"][0]["base"]["status"] == "failed"
    assert verdict["cases"][0]["candidate"]["status"] == "passed"
    reverse = (
        await owner.client.get(
            "/api/v1/evaluations/compare",
            params={"base": candidate["id"], "candidate": baseline["id"]},
        )
    ).json()
    assert reverse["regressed"] == 3

    suites = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/evaluations/suites")).json()
    assert suites[0]["last_run"]["id"] == candidate["id"]
    assert suites[0]["case_count"] == 3
    runs = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/evaluations/runs",
            params={"suite_id": suite["id"], "limit": 1},
        )
    ).json()
    assert [r["id"] for r in runs["data"]] == [candidate["id"]]
    assert runs["next_cursor"]


async def test_variant_run_overrides_the_prompt_without_a_new_version(
    lab: dict[str, Any],
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    suite = await _suite(owner, ws["id"])
    await _import(
        owner, suite["id"], [{"name": "Echo", "input": "hello", "expected": "Echo: hello"}]
    )
    run = await _run(
        owner, suite["id"], agent["id"], model="gouvra-test-1", instructions="Be terse."
    )
    assert run["label"] == "Helper v1 · gouvra-test-1 · custom prompt"
    assert set(run["overrides"]) == {"model", "instructions"}
    await _settle()
    detail = await _detail(owner, run["id"])
    assert detail["results"][0]["status"] == "passed"
    assert detail["results"][0]["score"] == 1.0
    execution_id = detail["results"][0]["execution_id"]
    started = next(e for e in await events_of(execution_id) if e.type == "execution.started")
    assert set(started.data["overrides"]) == {"model", "instructions"}
    execution = (await owner.client.get(f"/api/v1/executions/{execution_id}")).json()
    assert execution["trigger"] == "evaluation"
    # The agent itself is untouched: still one version.
    versions = (await owner.client.get(f"/api/v1/agents/{agent['id']}/versions")).json()
    assert len(versions) == 1


async def test_failures_are_reported_per_case_and_runs_can_be_cancelled(
    lab: dict[str, Any],
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    suite = await _suite(owner, ws["id"])
    await _import(
        owner,
        suite["id"],
        [
            {"name": "Provider down", "input": "help [fail:provider_unavailable]", "expected": "x"},
            {"name": "No grader", "input": "hello"},
            {"name": "Wrong answer", "input": "hello", "expected": "Goodbye"},
        ],
    )
    run = await _run(owner, suite["id"], agent["id"])
    await _settle()
    detail = await _detail(owner, run["id"])
    by_name = {r["case_name"]: r for r in detail["results"]}
    assert by_name["Provider down"]["status"] == "errored"
    assert by_name["Provider down"]["error"]["code"] == "provider_unavailable"
    assert by_name["No grader"]["error"]["code"] == "no_graders"
    assert by_name["Wrong answer"]["status"] == "failed"
    summary = detail["summary"]
    assert (summary["errored"], summary["failed"], summary["pass_rate"]) == (2, 1, 0.0)

    # Cancelling: queued cases never run and the run settles at once.
    second = await _run(owner, suite["id"], agent["id"])
    cancelled = await owner.client.post(f"/api/v1/evaluations/runs/{second['id']}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    detail = await _detail(owner, second["id"])
    assert {r["status"] for r in detail["results"]} == {"cancelled"}
    assert detail["summary"]["cancelled"] == 3
    again = await owner.client.post(f"/api/v1/evaluations/runs/{second['id']}/cancel")
    assert again.status_code == 409
    assert await drain() == 0  # nothing left in the queue


async def test_llm_judge_scores_with_a_workspace_provider(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws, agent, provider = lab["ws"], lab["agent"], lab["provider"]

    def judge(rubric: str, **extra: Any) -> dict[str, Any]:
        return {
            "type": "llm_judge",
            "provider_id": provider["id"],
            "model": "gouvra-test-1",
            "rubric": rubric,
            **extra,
        }

    suite = await _suite(
        owner,
        ws["id"],
        default_graders=[judge("Answer politely. [score:0.9]")],
        pass_threshold=0.5,
    )
    await _import(
        owner,
        suite["id"],
        [
            {"name": "Polite", "input": "hello"},
            {"name": "Strict", "input": "hello", "graders": [judge("Be perfect. [score:0.2]")]},
            {"name": "Mute judge", "input": "hello", "graders": [judge("No verdict in here.")]},
        ],
    )
    run = await _run(owner, suite["id"], agent["id"])
    await _settle()
    by_name = {r["case_name"]: r for r in (await _detail(owner, run["id"]))["results"]}
    assert (by_name["Polite"]["status"], by_name["Polite"]["score"]) == ("passed", 0.9)
    assert by_name["Polite"]["grader_results"][0]["details"] == "Scripted verdict."
    assert (by_name["Strict"]["status"], by_name["Strict"]["score"]) == ("failed", 0.2)
    assert by_name["Mute judge"]["status"] == "errored"
    assert by_name["Mute judge"]["grader_results"][0]["error"] == "judge_unparseable"
    async with get_sessionmaker()() as db:
        judged = (
            await db.execute(select(UsageRecord).where(UsageRecord.kind == "judge"))
        ).scalars()
        assert len(list(judged)) == 3  # judge calls are metered apart from the agent's own


async def test_suite_and_case_management(lab: dict[str, Any], make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    suite = await _suite(owner, ws["id"], description="Weekly regression", pass_threshold=0.8)
    assert (suite["case_count"], suite["last_run"], suite["archived"]) == (0, None, False)
    taken = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/evaluations/suites", json={"name": "Support quality"}
    )
    assert taken.status_code == 422
    bad = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/evaluations/suites",
        json={"name": "Bad", "default_graders": [{"type": "regex", "pattern": ""}]},
    )
    assert bad.status_code == 422

    # Cases: add, import (append / replace), edit, delete.
    empty = await owner.client.post(
        "/api/v1/evaluations/runs", json={"suite_id": suite["id"], "agent_id": agent["id"]}
    )
    assert empty.status_code == 409
    assert empty.json()["code"] == "suite_empty"
    added = await owner.client.post(
        f"/api/v1/evaluations/suites/{suite['id']}/cases",
        json={"name": "Structured", "input": {"order": 12}, "expected": {"status": "refunded"}},
    )
    assert added.status_code == 201, added.text
    case = added.json()
    assert case["input"] == {"json": {"order": 12}}
    assert case["expected"] == {"json": {"status": "refunded"}}
    await _import(owner, suite["id"], [{"name": f"Case {i}", "input": f"q{i}"} for i in range(3)])
    cases = (await owner.client.get(f"/api/v1/evaluations/suites/{suite['id']}/cases")).json()
    assert [c["position"] for c in cases] == [0, 1, 2, 3]
    edited = await owner.client.patch(
        f"/api/v1/evaluations/cases/{case['id']}",
        json={"name": "Structured order", "tags": ["json", "json"], "expected": "refunded"},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["tags"] == ["json"]
    assert edited.json()["expected"] == {"text": "refunded"}
    deleted = await owner.client.delete(f"/api/v1/evaluations/cases/{case['id']}")
    assert deleted.status_code == 204
    replaced = await _import(owner, suite["id"], [{"name": "Only", "input": "x"}], replace=True)
    assert [c["position"] for c in replaced] == [0]

    # Judges must use a provider of this workspace.
    other = await signup(make_client(), outbox, "elsewhere@example.com")
    foreign_ws = await create_workspace(other, "Elsewhere")
    foreign_provider = await create_provider(other, foreign_ws["id"])
    smuggled = await owner.client.post(
        f"/api/v1/evaluations/suites/{suite['id']}/cases",
        json={
            "name": "Smuggled judge",
            "input": "x",
            "graders": [
                {
                    "type": "llm_judge",
                    "provider_id": foreign_provider["id"],
                    "model": "gouvra-test-1",
                    "rubric": "Grade the answer fairly.",
                }
            ],
        },
    )
    assert smuggled.status_code == 422
    foreign_agent = await create_agent(other, foreign_ws["id"], foreign_provider["id"])
    foreign_agent_run = await owner.client.post(
        "/api/v1/evaluations/runs",
        json={"suite_id": suite["id"], "agent_id": foreign_agent["id"]},
    )
    assert foreign_agent_run.status_code == 422

    # Suite edits and archiving.
    patched = await owner.client.patch(
        f"/api/v1/evaluations/suites/{suite['id']}",
        json={"name": "Support regression", "pass_threshold": 0.6, "agent_id": agent["id"]},
    )
    assert patched.status_code == 200, patched.text
    assert (patched.json()["name"], patched.json()["pass_threshold"]) == ("Support regression", 0.6)
    assert (
        await owner.client.delete(f"/api/v1/evaluations/suites/{suite['id']}")
    ).status_code == 204
    listed = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/evaluations/suites")).json()
    assert listed == []
    archived = (
        await owner.client.get(
            f"/api/v1/workspaces/{ws['id']}/evaluations/suites",
            params={"include_archived": "true"},
        )
    ).json()
    assert archived[0]["archived"] is True
    blocked = await owner.client.post(
        "/api/v1/evaluations/runs", json={"suite_id": suite["id"], "agent_id": agent["id"]}
    )
    assert blocked.status_code == 409
    assert blocked.json()["code"] == "suite_archived"


async def test_grader_preview(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    preview = await owner.client.post(
        "/api/v1/evaluations/graders/preview",
        json={"grader": {"type": "regex", "pattern": r"#\d+"}, "output": "Ticket #12"},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["passed"] is True
    exact = await owner.client.post(
        "/api/v1/evaluations/graders/preview",
        json={"grader": {"type": "exact"}, "output": "Yes", "expected": "yes"},
    )
    assert exact.json()["passed"] is True
    judge = await owner.client.post(
        "/api/v1/evaluations/graders/preview",
        json={
            "grader": {
                "type": "llm_judge",
                "provider_id": lab["provider"]["id"],
                "model": "gouvra-test-1",
                "rubric": "Grade the answer fairly.",
            },
            "output": "x",
        },
    )
    assert judge.status_code == 400


async def test_roles_viewers_read_members_run(
    lab: dict[str, Any], make_client, outbox: Outbox
) -> None:  # type: ignore[no-untyped-def]
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    suite = await _suite(owner, ws["id"])
    await _import(owner, suite["id"], [{"name": "Echo", "input": "hi", "expected": "Echo: hi"}])
    viewer = await signup(make_client(), outbox, "viewer@example.com")
    await add_member(owner, ws["id"], viewer, outbox, "viewer")
    member = await signup(make_client(), outbox, "member@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")

    assert (await viewer.client.get(f"/api/v1/evaluations/suites/{suite['id']}")).status_code == 200
    denied = await viewer.client.post(
        "/api/v1/evaluations/runs", json={"suite_id": suite["id"], "agent_id": agent["id"]}
    )
    assert denied.status_code == 403
    rename = await viewer.client.patch(
        f"/api/v1/evaluations/suites/{suite['id']}", json={"name": "Mine"}
    )
    assert rename.status_code == 403
    run = await _run(member, suite["id"], agent["id"])
    assert run["created_by"] == "Test User"


async def test_worker_grades_as_soon_as_executions_finish(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    suite = await _suite(owner, lab["ws"]["id"])
    await _import(owner, suite["id"], [{"name": "Echo", "input": "hi", "expected": "Echo: hi"}])
    run = await _run(owner, suite["id"], lab["agent"]["id"])
    stop = asyncio.Event()
    grader = asyncio.create_task(evaluation_service(stop))
    try:
        await drain()  # the engine's finish hook wakes the evaluation worker
        for _ in range(100):
            if (await _detail(owner, run["id"]))["status"] == "completed":
                break
            await asyncio.sleep(0.05)
        assert (await _detail(owner, run["id"]))["summary"]["passed"] == 1
    finally:
        stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(grader, timeout=10)


@pytest.mark.real
async def test_real_deepseek_judge(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    key = get_settings().deepseek_api_key.get_secret_value()
    if not key:
        pytest.skip("DEEPSEEK_API_KEY not configured")
    owner = await signup(make_client(), outbox, "judge@example.com")
    ws = await create_workspace(owner, "Judged")
    scripted = await create_provider(owner, ws["id"])
    deepseek = await create_provider(owner, ws["id"], kind="deepseek", api_key=key, name="DeepSeek")
    agent = (
        await owner.client.post(
            f"/api/v1/workspaces/{ws['id']}/agents",
            json={"name": "Echo", "provider_id": scripted["id"], "model": "gouvra-test-1"},
        )
    ).json()
    suite = await _suite(
        owner,
        ws["id"],
        default_graders=[
            {
                "type": "llm_judge",
                "provider_id": deepseek["id"],
                "model": "deepseek-flash",
                "rubric": "Score 1 if the response repeats the user's greeting, otherwise 0.",
            }
        ],
    )
    await _import(owner, suite["id"], [{"name": "Greeting", "input": "Good morning"}])
    run = await _run(owner, suite["id"], agent["id"])
    await _settle()
    result = (await _detail(owner, run["id"]))["results"][0]
    assert result["status"] == "passed", result
    assert result["grader_results"][0]["model"] == "deepseek-flash"
    assert result["grader_results"][0].get("cost") is not None
