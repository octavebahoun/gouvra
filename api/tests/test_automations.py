"""Automations: signatures, cron schedules, the scheduler, and signed, idempotent webhooks.

Phase 8 exit criterion: a scheduled task and a signed webhook, tested.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import select, update

from gouvra.core import ratelimit
from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.errors import ValidationFailed
from gouvra.modules.automations import service, signing
from gouvra.modules.automations.models import Automation, AutomationFire
from gouvra.modules.automations.worker import automation_service
from gouvra.modules.executions.models import Execution
from gouvra.modules.workflows.models import WorkflowRun
from tests.helpers import Account, Outbox, add_member, create_agent, drain, signup

pytestmark = pytest.mark.usefixtures("outbox")


# ---------------------------------------------------------------- signatures and cron (pure)


def test_gouvra_signatures() -> None:
    body = b'{"ticket": 42}'
    now = time.time()
    header = signing.sign("s3cret", body, int(now))
    assert signing.verify_gouvra("s3cret", header, body, now).ok
    # Several v1 values (rotation): one valid is enough.
    assert signing.verify_gouvra("s3cret", header.replace("v1=", "v1=bad,v1="), body, now).ok
    assert signing.verify_gouvra("other", header, body, now).code == "invalid_signature"
    assert signing.verify_gouvra("s3cret", header, body + b" ", now).code == "invalid_signature"
    stale = signing.sign("s3cret", body, int(now) - 301)
    assert signing.verify_gouvra("s3cret", stale, body, now).code == "stale_signature"
    assert signing.verify_gouvra("s3cret", None, body, now).code == "missing_signature"
    assert signing.verify_gouvra("s3cret", "v1=abc", body, now).code == "malformed_signature"


def test_github_signatures() -> None:
    body = b'{"action": "opened"}'
    header = signing.sign_github("hush", body)
    assert header.startswith("sha256=")
    assert signing.verify_github("hush", header, body).ok
    assert signing.verify_github("hush", header, b"{}").code == "invalid_signature"
    assert signing.verify_github("hush", None, body).code == "missing_signature"


def test_cron_validation_and_time_zones() -> None:
    assert service.check_cron("  0   9 * * 1-5 ") == "0 9 * * 1-5"
    assert service.check_cron("@Daily") == "@daily"
    for bad in ("0 9 * *", "0 0 9 * * 1", "61 * * * *", "every day"):
        with pytest.raises(ValidationFailed) as caught:
            service.check_cron(bad)
        assert caught.value.errors[0]["code"] == "invalid_cron"
    with pytest.raises(ValidationFailed) as caught:
        service.zone("Mars/Olympus")
    assert caught.value.errors[0]["code"] == "unknown_timezone"
    # 09:00 in Paris is 07:00 UTC in summer and 08:00 UTC in winter (DST ends 2026-10-25).
    after = datetime(2026, 10, 23, 12, tzinfo=UTC)
    runs = service.upcoming("0 9 * * *", "Europe/Paris", after, 4)
    assert [r.isoformat() for r in runs] == [
        "2026-10-24T07:00:00+00:00",
        "2026-10-25T08:00:00+00:00",
        "2026-10-26T08:00:00+00:00",
        "2026-10-27T08:00:00+00:00",
    ]


def test_webhook_payloads_become_run_inputs() -> None:
    assert service.webhook_input(b'{"a": 1}', None) == {"a": 1}
    assert service.webhook_input(b"[1, 2]", None) == {"items": [1, 2]}
    assert service.webhook_input(b"plain text", None) == "plain text"
    assert service.webhook_input(b"", None) == "(empty payload)"
    template = "Ticket {{input.ticket.id}}: {{input.ticket.title}}"
    body = b'{"ticket": {"id": 7, "title": "Refund"}}'
    assert service.webhook_input(body, template) == "Ticket 7: Refund"
    assert service.webhook_input(body, '{"id": {{input.ticket.id}}}') == {"id": 7}


# ---------------------------------------------------------------- helpers


async def _create(owner: Account, workspace_id: str, **body: Any) -> dict[str, Any]:
    response = await owner.client.post(f"/api/v1/workspaces/{workspace_id}/automations", json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


async def _make_due(automation_id: str) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Automation)
            .where(Automation.id == automation_id)
            .values(next_run_at=utcnow() - timedelta(minutes=1))
        )
        await db.commit()


async def _fires(owner: Account, automation_id: str) -> list[dict[str, Any]]:
    response = await owner.client.get(f"/api/v1/automations/{automation_id}/fires")
    assert response.status_code == 200, response.text
    data: list[dict[str, Any]] = response.json()["data"]
    return data


def _signed(secret: str, payload: Any, **extra: str) -> tuple[bytes, dict[str, str]]:
    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "Gouvra-Signature": signing.sign(secret, body, int(time.time())),
        **extra,
    }
    return body, headers


# ---------------------------------------------------------------- schedules


async def test_scheduled_task_runs_an_agent_and_plans_the_next_one(lab: dict[str, Any]) -> None:
    """Phase 8 exit criterion (1/2): a scheduled task fires, once per tick, on time."""
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    schedule = await _create(
        owner,
        ws["id"],
        name="Morning digest",
        kind="schedule",
        target_type="agent",
        agent_id=agent["id"],
        cron="0 9 * * 1-5",
        timezone="Europe/Paris",
        input="Summarise yesterday's tickets",
    )
    assert schedule["secret"] is None
    assert schedule["target_name"] == "Helper"
    assert schedule["target_problem"] is None
    assert len(schedule["upcoming"]) == 5
    first = datetime.fromisoformat(schedule["next_run_at"])
    assert first > datetime.now(UTC)
    assert first.astimezone(service.zone("Europe/Paris")).hour == 9
    assert first.astimezone(service.zone("Europe/Paris")).weekday() < 5

    await _make_due(schedule["id"])
    assert await service.run_due() == 1
    assert await service.run_due() == 0  # planned again, in the future
    fires = await _fires(owner, schedule["id"])
    assert [(f["source"], f["status"]) for f in fires] == [("schedule", "launched")]
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, fires[0]["execution_id"])
        assert execution is not None
        assert (execution.trigger, execution.source_id) == ("schedule", schedule["id"])
        assert execution.input == {"text": "Summarise yesterday's tickets"}
        automation = await db.get(Automation, schedule["id"])
        assert automation is not None
        assert automation.next_run_at is not None
        assert automation.next_run_at > utcnow()
        assert (automation.fire_count, automation.last_status) == (1, "launched")

    # The previous run has not finished: the next tick is skipped, not stacked.
    await _make_due(schedule["id"])
    await service.run_due()
    fires = await _fires(owner, schedule["id"])
    assert fires[0]["status"] == "skipped"
    assert fires[0]["reason"]["code"] == "overlap"
    await drain()
    await _make_due(schedule["id"])
    await service.run_due()
    fires = await _fires(owner, schedule["id"])
    assert fires[0]["status"] == "launched"
    assert [f["status"] for f in fires] == ["launched", "skipped", "launched"]
    assert fires[2]["run_status"] == "succeeded"

    detail = (await owner.client.get(f"/api/v1/automations/{schedule['id']}")).json()
    assert detail["fire_count"] == 3


async def test_schedules_start_workflows_and_pause_after_repeated_failures(
    lab: dict[str, Any],
) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    workflow = (
        await owner.client.post(f"/api/v1/workspaces/{ws['id']}/workflows", json={"name": "Flow"})
    ).json()
    refused = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/automations",
        json={
            "name": "Nightly flow",
            "kind": "schedule",
            "target_type": "workflow",
            "workflow_id": workflow["id"],
            "cron": "@daily",
            "input": "go",
        },
    )
    assert refused.status_code == 422
    assert refused.json()["errors"][0]["code"] == "workflow_not_published"
    await owner.client.post(f"/api/v1/workflows/{workflow['id']}/publish", json={})
    nightly = await _create(
        owner,
        ws["id"],
        name="Nightly flow",
        kind="schedule",
        target_type="workflow",
        workflow_id=workflow["id"],
        cron="@daily",
        input={"day": "today"},
    )
    await _make_due(nightly["id"])
    await service.run_due()
    fire = (await _fires(owner, nightly["id"]))[0]
    assert fire["status"] == "launched"
    async with get_sessionmaker()() as db:
        run = await db.get(WorkflowRun, fire["workflow_run_id"])
        assert run is not None
        assert (run.trigger, run.input) == ("schedule", {"json": {"day": "today"}})

    # A target that cannot run: each tick fails, and the fifth pauses the automation.
    spare = await create_agent(owner, ws["id"], lab["provider"]["id"], name="Spare")
    failing = await _create(
        owner,
        ws["id"],
        name="Doomed",
        kind="schedule",
        target_type="agent",
        agent_id=spare["id"],
        cron="* * * * *",
        input="hi",
    )
    await owner.client.post(f"/api/v1/agents/{spare['id']}/archive")
    for _ in range(service.MAX_FAILURES):
        await _make_due(failing["id"])
        await service.run_due()
    detail = (await owner.client.get(f"/api/v1/automations/{failing['id']}")).json()
    assert detail["enabled"] is False
    assert detail["paused_reason"].startswith("Paused after 5 failed attempts")
    assert detail["target_problem"] == "The agent is archived."
    assert detail["next_run_at"] is None
    assert {f["status"] for f in await _fires(owner, failing["id"])} == {"failed"}
    await owner.client.post(f"/api/v1/agents/{spare['id']}/restore")
    resumed = await owner.client.patch(
        f"/api/v1/automations/{failing['id']}", json={"enabled": True}
    )
    assert resumed.json()["paused_reason"] is None
    assert resumed.json()["consecutive_failures"] == 0
    assert resumed.json()["next_run_at"] is not None


async def test_schedule_definitions_are_validated(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    base = {"name": "Bad", "kind": "schedule", "target_type": "agent", "agent_id": agent["id"]}
    url = f"/api/v1/workspaces/{ws['id']}/automations"
    cases = [
        ({"cron": "every day", "input": "x"}, "invalid_cron"),
        ({"cron": "0 9 * * *", "timezone": "Mars/Olympus", "input": "x"}, "unknown_timezone"),
        ({"cron": "0 9 * * *"}, "required"),
        ({"input": "x"}, "required"),
        ({"cron": "0 9 * * *", "input": "   "}, "empty"),
    ]
    for extra, code in cases:
        response = await owner.client.post(url, json={**base, **extra})
        assert response.status_code == 422, (extra, response.text)
        assert response.json()["errors"][0]["code"] == code
    stranger = await owner.client.post(
        url,
        json={
            **base,
            "agent_id": "00000000-0000-0000-0000-000000000000",
            "cron": "@hourly",
            "input": "x",
        },
    )
    assert stranger.json()["errors"][0]["code"] == "unknown_agent"

    preview = await owner.client.post(
        "/api/v1/automations/cron-preview", json={"cron": "30 8 * * 1", "timezone": "UTC"}
    )
    assert preview.json()["valid"] is True
    assert len(preview.json()["upcoming"]) == 5
    assert datetime.fromisoformat(preview.json()["upcoming"][0]).weekday() == 0
    wrong = await owner.client.post("/api/v1/automations/cron-preview", json={"cron": "nope"})
    assert wrong.json()["valid"] is False
    assert "five fields" in wrong.json()["message"]

    schedule = await _create(owner, ws["id"], **{**base, "cron": "0 9 * * *", "input": "x"})
    edited = await owner.client.patch(
        f"/api/v1/automations/{schedule['id']}", json={"cron": "0 18 * * *", "timezone": "UTC"}
    )
    assert datetime.fromisoformat(edited.json()["next_run_at"]).hour == 18
    paused = await owner.client.patch(
        f"/api/v1/automations/{schedule['id']}", json={"enabled": False}
    )
    assert (paused.json()["next_run_at"], paused.json()["upcoming"]) == (None, [])

    manual = await owner.client.post(f"/api/v1/automations/{schedule['id']}/run", json={})
    assert manual.status_code == 202, manual.text
    assert (manual.json()["source"], manual.json()["status"]) == ("manual", "launched")
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, manual.json()["execution_id"])
        assert execution is not None
        assert execution.triggered_by_user_id is not None  # the person who clicked "Run now"

    gone = await owner.client.delete(f"/api/v1/automations/{schedule['id']}")
    assert gone.status_code == 204
    async with get_sessionmaker()() as db:
        assert await db.get(Execution, manual.json()["execution_id"]) is not None  # history stays
    audit = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events")).json()
    assert {"automation.created", "automation.updated", "automation.deleted"} <= {
        e["action"] for e in audit["data"]
    }


# ---------------------------------------------------------------- webhooks


async def test_signed_webhook_starts_a_run_once(lab: dict[str, Any], make_client: Any) -> None:
    """Phase 8 exit criterion (2/2): a signed webhook starts a run, and only once."""
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    hook = await _create(
        owner,
        ws["id"],
        name="Ticket created",
        kind="webhook",
        target_type="agent",
        agent_id=agent["id"],
        input_template="New ticket {{input.ticket.id}}: {{input.ticket.title}}",
    )
    secret = hook["secret"]
    assert secret.startswith("gvwhsec_")
    assert hook["secret_hint"] == secret[-4:]
    assert hook["hook_url"].startswith(get_settings().api_public_url.rstrip("/") + "/api/v1/hooks/")
    path = "/api/v1" + hook["hook_url"].split("/api/v1", 1)[1]
    detail = (await owner.client.get(f"/api/v1/automations/{hook['id']}")).json()
    assert "secret" not in detail  # never shown again

    sender = make_client(csrf=False)  # an outside system: no session, no CSRF token
    body, headers = _signed(secret, {"ticket": {"id": 42, "title": "Refund"}})
    accepted = await sender.post(path, content=body, headers=headers)
    assert accepted.status_code == 202, accepted.text
    first = accepted.json()
    assert (first["status"], first["duplicate"]) == ("launched", False)
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, first["execution_id"])
        assert execution is not None
        assert execution.trigger == "webhook"
        assert execution.input == {"text": "New ticket 42: Refund"}

    # The same signed request again (a retry, or a replay within 5 minutes): no second run.
    replay = await sender.post(path, content=body, headers=headers)
    assert replay.status_code == 200
    assert (replay.json()["fire_id"], replay.json()["duplicate"]) == (first["fire_id"], True)
    # An explicit delivery id de-duplicates across different signatures too.
    for _ in range(2):
        body2, headers2 = _signed(
            secret, {"ticket": {"id": 43, "title": "Bug"}}, **{"Idempotency-Key": "evt_43"}
        )
        again = await sender.post(path, content=body2, headers=headers2)
    assert again.json()["duplicate"] is True
    assert again.json()["delivery_id"] == "evt_43"

    # Refused: no signature, a wrong one, an old one, a tampered body, an unknown address.
    attempts = [
        ({"Content-Type": "application/json"}, body, "missing_signature"),
        (
            {"Gouvra-Signature": signing.sign("wrong", body, int(time.time()))},
            body,
            "invalid_signature",
        ),
        (
            {"Gouvra-Signature": signing.sign(secret, body, int(time.time()) - 600)},
            body,
            "stale_signature",
        ),
        (headers, body.replace(b"42", b"99"), "invalid_signature"),
    ]
    for attempt_headers, attempt_body, code in attempts:
        refused = await sender.post(path, content=attempt_body, headers=attempt_headers)
        assert refused.status_code == 401, refused.text
        assert refused.json()["code"] == code
    assert (
        await sender.post("/api/v1/hooks/nope", content=body, headers=headers)
    ).status_code == 404
    fires = await _fires(owner, hook["id"])
    statuses = [f["status"] for f in fires]
    assert statuses.count("launched") == 2
    assert statuses.count("rejected") == 4
    rejected = next(f for f in fires if f["status"] == "rejected")
    assert rejected["request_meta"]["size"] > 0
    async with get_sessionmaker()() as db:
        launched = (
            await db.execute(select(Execution).where(Execution.source_id == hook["id"]))
        ).scalars()
        assert len(list(launched)) == 2

    # Rotation: the old secret stops working at once.
    rotated = await owner.client.post(f"/api/v1/automations/{hook['id']}/rotate-secret")
    new_secret = rotated.json()["secret"]
    assert new_secret != secret
    body3, old_headers = _signed(secret, {"ticket": {"id": 44, "title": "Late"}})
    assert (await sender.post(path, content=body3, headers=old_headers)).status_code == 401
    _, new_headers = _signed(new_secret, {"ticket": {"id": 44, "title": "Late"}})
    assert (await sender.post(path, content=body3, headers=new_headers)).status_code == 202

    # Paused: refused (and not recorded as a run); a test delivery from the interface still works.
    await owner.client.patch(f"/api/v1/automations/{hook['id']}", json={"enabled": False})
    body4, headers4 = _signed(new_secret, {"ticket": {"id": 45, "title": "Paused"}})
    paused = await sender.post(path, content=body4, headers=headers4)
    assert (paused.status_code, paused.json()["code"]) == (409, "automation_paused")
    test_fire = await owner.client.post(
        f"/api/v1/automations/{hook['id']}/run",
        json={"input": {"ticket": {"id": 1, "title": "Sample"}}},
    )
    assert (test_fire.json()["source"], test_fire.json()["status"]) == ("test", "launched")
    assert test_fire.json()["payload_preview"] == "New ticket 1: Sample"


async def test_github_style_webhooks_and_limits(
    lab: dict[str, Any], make_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    hook = await _create(
        owner,
        ws["id"],
        name="Issues",
        kind="webhook",
        target_type="agent",
        agent_id=agent["id"],
        signature_format="github",
    )
    path = "/api/v1" + hook["hook_url"].split("/api/v1", 1)[1]
    sender = make_client(csrf=False)
    body = b'{"action": "opened", "issue": {"number": 7}}'
    headers = {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signing.sign_github(hook["secret"], body),
        "X-GitHub-Delivery": "d1f0c3a0-0000-0000-0000-000000000001",
    }
    accepted = await sender.post(path, content=body, headers=headers)
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["delivery_id"] == headers["X-GitHub-Delivery"]
    assert (await sender.post(path, content=body, headers=headers)).json()["duplicate"] is True
    no_delivery = {k: v for k, v in headers.items() if k != "X-GitHub-Delivery"}
    refused = await sender.post(path, content=body, headers=no_delivery)
    assert refused.json()["code"] == "missing_delivery"

    monkeypatch.setattr(get_settings(), "max_execution_input_bytes", 64)
    big = b'{"blob": "' + b"x" * 100 + b'"}'
    big_headers = {**headers, "X-Hub-Signature-256": signing.sign_github(hook["secret"], big)}
    assert (await sender.post(path, content=big, headers=big_headers)).status_code == 413

    monkeypatch.setattr(ratelimit, "WEBHOOK_PER_TRIGGER", ratelimit.Limit("webhook:test", 1, 60))
    statuses = {
        (await sender.post(path, content=body, headers=headers)).status_code for _ in range(3)
    }
    assert 429 in statuses


async def test_automation_roles(lab: dict[str, Any], make_client: Any, outbox: Outbox) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    schedule = await _create(
        owner,
        ws["id"],
        name="Weekly",
        kind="schedule",
        target_type="agent",
        agent_id=agent["id"],
        cron="@weekly",
        input="x",
    )
    member = await signup(make_client(), outbox, "planner@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")
    listed = await member.client.get(f"/api/v1/workspaces/{ws['id']}/automations")
    assert [a["id"] for a in listed.json()] == [schedule["id"]]
    denied = [
        await member.client.post(
            f"/api/v1/workspaces/{ws['id']}/automations",
            json={"name": "x", "kind": "schedule", "target_type": "agent", "agent_id": agent["id"]},
        ),
        await member.client.patch(f"/api/v1/automations/{schedule['id']}", json={"enabled": False}),
        await member.client.post(f"/api/v1/automations/{schedule['id']}/run", json={}),
        await member.client.delete(f"/api/v1/automations/{schedule['id']}"),
    ]
    assert [r.status_code for r in denied] == [403] * 4


async def test_scheduler_service_and_secret_rotation(
    lab: dict[str, Any], make_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    schedule = await _create(
        owner,
        ws["id"],
        name="Every minute",
        kind="schedule",
        target_type="agent",
        agent_id=agent["id"],
        cron="* * * * *",
        input="tick",
    )
    await _make_due(schedule["id"])
    stop = asyncio.Event()
    task = asyncio.create_task(automation_service(stop))
    try:
        # A fire is committed as pending with its execution, then marked launched: wait for that.
        for _ in range(200):
            fires = await _fires(owner, schedule["id"])
            if fires and fires[0]["status"] != "pending":
                break
            await asyncio.sleep(0.05)
        assert fires
        assert fires[0]["status"] == "launched"
    finally:
        stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=10)

    # Encryption key rotation re-seals webhook secrets: deliveries keep verifying.
    hook = await _create(
        owner, ws["id"], name="Rotated", kind="webhook", target_type="agent", agent_id=agent["id"]
    )
    from gouvra.core.rotation import rotate_secrets

    settings = get_settings()
    current = settings.encryption_keys.get_secret_value()
    new_key = "k2026:" + "D" * 43
    monkeypatch.setattr(settings, "encryption_keys", SecretStr(f"{new_key},{current}"))
    report = await rotate_secrets()
    assert report.failed == 0
    assert report.rotated >= 1
    async with get_sessionmaker()() as db:
        stored = await db.get(Automation, hook["id"])
        assert stored is not None
        assert stored.secret_key_id == "k2026"
    path = "/api/v1" + hook["hook_url"].split("/api/v1", 1)[1]
    body, headers = _signed(hook["secret"], {"ok": True})
    response = await make_client(csrf=False).post(path, content=body, headers=headers)
    assert response.status_code == 202, response.text

    # A launch interrupted by a crash is closed after a while.
    async with get_sessionmaker()() as db:
        db.add(
            AutomationFire(
                automation_id=hook["id"],
                workspace_id=ws["id"],
                source="webhook",
                status="pending",
                created_at=utcnow() - timedelta(minutes=10),
            )
        )
        await db.commit()
    assert await service.reap_pending() == 1
