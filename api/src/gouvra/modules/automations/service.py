"""Automations: definitions, the launcher shared by every trigger, schedules, webhooks."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core import ratelimit
from gouvra.core.authz import Actor, Permission, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.crypto import decrypt_secret, encrypt_secret
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.errors import AppError, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.core.logging import get_logger
from gouvra.modules.agents.models import Agent
from gouvra.modules.agents.service import readiness
from gouvra.modules.audit.service import record_for
from gouvra.modules.automations import signing
from gouvra.modules.automations.models import (
    Automation,
    AutomationFire,
    AutomationKind,
    FireStatus,
)
from gouvra.modules.automations.schemas import AutomationCreateIn, AutomationUpdateIn
from gouvra.modules.executions.models import TERMINAL, Execution, Trigger
from gouvra.modules.workflows import graph as g
from gouvra.modules.workflows.models import Workflow, WorkflowRun
from gouvra.modules.workspaces.models import Workspace

log = get_logger(__name__)

SECRET_PURPOSE = "automation_secret"  # noqa: S105 - key purpose label, not a secret
MAX_FAILURES = 5
PENDING_TIMEOUT = timedelta(minutes=5)
CRON_MACROS = {"@hourly", "@daily", "@weekly", "@monthly", "@yearly", "@annually"}


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


# ---------------------------------------------------------------- schedules


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise _invalid("timezone", f"Unknown time zone “{name}”.", "unknown_timezone") from exc


def check_cron(expression: str) -> str:
    expression = " ".join(expression.split())
    if expression.lower() in CRON_MACROS:
        return expression.lower()
    if len(expression.split(" ")) != 5 or not croniter.is_valid(expression):
        raise _invalid(
            "cron",
            "Use five fields: minute hour day-of-month month day-of-week (e.g. 0 9 * * 1-5).",
            "invalid_cron",
        )
    return expression


def upcoming(expression: str, timezone: str, after: datetime, count: int = 5) -> list[datetime]:
    """Next run times (UTC), computed in the schedule's time zone (daylight saving included)."""
    tz = zone(timezone)
    iterator = croniter(expression, after.astimezone(tz))
    return [iterator.get_next(datetime).astimezone(ZoneInfo("UTC")) for _ in range(count)]


def next_after(expression: str, timezone: str, after: datetime) -> datetime:
    return upcoming(expression, timezone, after, 1)[0]


# ---------------------------------------------------------------- targets


async def target_of(
    db: AsyncSession, automation: Automation
) -> tuple[Agent | Workflow | None, str | None]:
    """The agent or workflow an automation starts, or why it cannot start it."""
    if automation.target_type == "agent":
        agent = await db.get(Agent, automation.agent_id) if automation.agent_id else None
        if agent is None or agent.workspace_id != automation.workspace_id:
            return None, "The agent no longer exists."
        if agent.archived_at is not None:
            return agent, "The agent is archived."
        from gouvra.modules.agents.models import AgentVersion

        version = (
            await db.get(AgentVersion, agent.current_version_id)
            if agent.current_version_id
            else None
        )
        if not (await readiness(db, version)).ready:
            return agent, "The agent cannot run yet (provider or model missing)."
        return agent, None
    workflow = await db.get(Workflow, automation.workflow_id) if automation.workflow_id else None
    if workflow is None or workflow.workspace_id != automation.workspace_id:
        return None, "The workflow no longer exists."
    if workflow.archived_at is not None:
        return workflow, "The workflow is archived."
    if workflow.current_version_id is None:
        return workflow, "The workflow has no published version."
    return workflow, None


async def _check_target(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    target_type: str,
    agent_id: uuid.UUID | None,
    workflow_id: uuid.UUID | None,
) -> None:
    if target_type == "agent":
        agent = await db.get(Agent, agent_id) if agent_id else None
        if agent is None or agent.workspace_id != workspace_id:
            raise _invalid("agent_id", "Choose an agent of this workspace.", "unknown_agent")
        if agent.archived_at is not None:
            raise _invalid("agent_id", "This agent is archived.", "agent_archived")
    else:
        workflow = await db.get(Workflow, workflow_id) if workflow_id else None
        if workflow is None or workflow.workspace_id != workspace_id:
            raise _invalid(
                "workflow_id", "Choose a workflow of this workspace.", "unknown_workflow"
            )
        if workflow.current_version_id is None:
            raise _invalid(
                "workflow_id",
                "Publish this workflow first: automations run its published version.",
                "workflow_not_published",
            )


def _raw_input(value: str | dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            raise _invalid("input", "Give the runs something to work on.", "empty")
        return {"text": value}
    return {"json": value}


def _as_launch_input(stored: dict[str, Any]) -> str | dict[str, Any]:
    if "json" in stored:
        value = stored["json"]
        return value if isinstance(value, dict) else {"items": value}
    return str(stored.get("text") or "")


# ---------------------------------------------------------------- definitions


def new_secret() -> str:
    return "gvwhsec_" + secrets.token_urlsafe(32)


def _seal(automation: Automation, secret: str) -> None:
    sealed = encrypt_secret(
        secret,
        workspace_id=automation.workspace_id,
        resource_id=automation.id,
        purpose=SECRET_PURPOSE,
    )
    automation.secret_ciphertext = sealed.ciphertext
    automation.secret_key_id = sealed.key_id
    automation.secret_hint = sealed.last4


def webhook_secret(automation: Automation) -> str:
    if automation.secret_ciphertext is None or automation.secret_key_id is None:
        raise RuntimeError("webhook without a secret")
    return decrypt_secret(
        automation.secret_ciphertext,
        automation.secret_key_id,
        workspace_id=automation.workspace_id,
        resource_id=automation.id,
        purpose=SECRET_PURPOSE,
    )


def hook_url(automation: Automation) -> str | None:
    if not automation.hook_token:
        return None
    return f"{get_settings().api_public_url.rstrip('/')}/api/v1/hooks/{automation.hook_token}"


async def create(
    db: AsyncSession, ctx: WorkspaceContext, payload: AutomationCreateIn
) -> tuple[Automation, str | None]:
    ctx.require(Permission.AUTOMATIONS_MANAGE)
    from gouvra.modules.usage.limits import require_capacity

    await require_capacity(db, ctx.workspace_id, "automations")
    await _check_target(
        db, ctx.workspace_id, payload.target_type, payload.agent_id, payload.workflow_id
    )
    automation = Automation(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        name=payload.name,
        description=payload.description,
        kind=payload.kind,
        target_type=payload.target_type,
        agent_id=payload.agent_id if payload.target_type == "agent" else None,
        workflow_id=payload.workflow_id if payload.target_type == "workflow" else None,
        enabled=payload.enabled,
        # A tick may be skipped; an event (a webhook delivery) is never dropped by default.
        overlap=payload.overlap or ("skip" if payload.kind == "schedule" else "allow"),
        created_by_id=ctx.actor.user_id,
    )
    secret: str | None = None
    if payload.kind == "schedule":
        if not payload.cron:
            raise _invalid("cron", "A schedule needs a cron expression.", "required")
        automation.cron = check_cron(payload.cron)
        automation.timezone = zone(payload.timezone).key
        automation.input = _raw_input(payload.input)
        if automation.input is None:
            raise _invalid("input", "Give the runs something to work on.", "required")
        automation.next_run_at = next_after(automation.cron, automation.timezone, utcnow())
    else:
        automation.hook_token = secrets.token_urlsafe(24)
        automation.signature_format = payload.signature_format
        automation.input_template = payload.input_template or None
        secret = new_secret()
        _seal(automation, secret)
    db.add(automation)
    await record_for(
        db,
        ctx.actor,
        "automation.created",
        workspace_id=ctx.workspace_id,
        target_type="automation",
        target_id=automation.id,
        data={"name": automation.name, "kind": automation.kind},
    )
    await db.commit()
    return automation, secret


async def update_automation(
    db: AsyncSession, ctx: WorkspaceContext, automation: Automation, payload: AutomationUpdateIn
) -> Automation:
    ctx.require(Permission.AUTOMATIONS_MANAGE)
    fields = payload.model_fields_set
    if "name" in fields and payload.name:
        automation.name = payload.name
    if "description" in fields and payload.description is not None:
        automation.description = payload.description
    if fields & {"target_type", "agent_id", "workflow_id"}:
        target_type = payload.target_type or automation.target_type
        agent_id = payload.agent_id if "agent_id" in fields else automation.agent_id
        workflow_id = payload.workflow_id if "workflow_id" in fields else automation.workflow_id
        await _check_target(db, ctx.workspace_id, target_type, agent_id, workflow_id)
        automation.target_type = target_type
        automation.agent_id = agent_id if target_type == "agent" else None
        automation.workflow_id = workflow_id if target_type == "workflow" else None
    if "overlap" in fields and payload.overlap:
        automation.overlap = payload.overlap
    if automation.kind == AutomationKind.SCHEDULE:
        if "input" in fields:
            stored = _raw_input(payload.input)
            if stored is None:
                raise _invalid("input", "Give the runs something to work on.", "required")
            automation.input = stored
        if "cron" in fields and payload.cron:
            automation.cron = check_cron(payload.cron)
        if "timezone" in fields and payload.timezone:
            automation.timezone = zone(payload.timezone).key
    else:
        if "input_template" in fields:
            automation.input_template = payload.input_template or None
        if "signature_format" in fields and payload.signature_format:
            automation.signature_format = payload.signature_format
    if "enabled" in fields and payload.enabled is not None:
        automation.enabled = payload.enabled
        if payload.enabled:
            automation.paused_reason = None
            automation.consecutive_failures = 0
    if automation.kind == AutomationKind.SCHEDULE and automation.cron and automation.timezone:
        automation.next_run_at = (
            next_after(automation.cron, automation.timezone, utcnow())
            if automation.enabled
            else None
        )
    automation.updated_at = utcnow()
    await record_for(
        db,
        ctx.actor,
        "automation.updated",
        workspace_id=ctx.workspace_id,
        target_type="automation",
        target_id=automation.id,
        data={"fields": sorted(fields)},
    )
    await db.commit()
    return automation


async def delete_automation(
    db: AsyncSession, ctx: WorkspaceContext, automation: Automation
) -> None:
    ctx.require(Permission.AUTOMATIONS_MANAGE)
    await record_for(
        db,
        ctx.actor,
        "automation.deleted",
        workspace_id=ctx.workspace_id,
        target_type="automation",
        target_id=automation.id,
        data={"name": automation.name},
    )
    await db.delete(automation)
    await db.commit()


async def rotate_secret(db: AsyncSession, ctx: WorkspaceContext, automation: Automation) -> str:
    ctx.require(Permission.AUTOMATIONS_MANAGE)
    if automation.kind != AutomationKind.WEBHOOK:
        raise _invalid("kind", "Only webhooks have a signing secret.", "not_a_webhook")
    secret = new_secret()
    _seal(automation, secret)
    await record_for(
        db,
        ctx.actor,
        "automation.secret_rotated",
        workspace_id=ctx.workspace_id,
        target_type="automation",
        target_id=automation.id,
    )
    await db.commit()
    return secret


# ---------------------------------------------------------------- firing


async def _overlapping(db: AsyncSession, automation: Automation) -> bool:
    """Is the run started by the previous launch still going?"""
    last = (
        await db.execute(
            select(AutomationFire)
            .where(
                AutomationFire.automation_id == automation.id,
                AutomationFire.status == FireStatus.LAUNCHED,
            )
            .order_by(AutomationFire.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if last is None:
        return False
    if last.execution_id:
        execution = await db.get(Execution, last.execution_id)
        return execution is not None and execution.status not in TERMINAL
    if last.workflow_run_id:
        run = await db.get(WorkflowRun, last.workflow_run_id)
        return run is not None and run.status == "running"
    return False


def _actor(automation: Automation) -> Actor:
    return Actor(extra={"automation_id": str(automation.id), "automation_name": automation.name})


_TRIGGERS = {
    "schedule": Trigger.SCHEDULE,
    "webhook": Trigger.WEBHOOK,
    "manual": Trigger.MANUAL,
    "test": Trigger.MANUAL,
}


async def fire(
    db: AsyncSession,
    automation: Automation,
    *,
    source: str,
    run_input: str | dict[str, Any],
    delivery_id: str | None = None,
    scheduled_for: datetime | None = None,
    meta: dict[str, Any] | None = None,
    preview: str | None = None,
    actor: Actor | None = None,
) -> AutomationFire:
    """Start the automation's agent or workflow once, and record how it went."""
    record = AutomationFire(
        id=uuid7(),
        automation_id=automation.id,
        workspace_id=automation.workspace_id,
        source=source,
        scheduled_for=scheduled_for,
        delivery_id=delivery_id,
        status=FireStatus.PENDING,
        request_meta=meta,
        payload_preview=(preview or "")[:500] or None,
    )
    db.add(record)
    await db.flush()
    target, problem = await target_of(db, automation)
    if problem is None and automation.overlap == "skip" and await _overlapping(db, automation):
        record.status = FireStatus.SKIPPED
        record.reason = {"code": "overlap", "message": "The previous run is still in progress."}
    elif problem is not None or target is None:
        record.status = FireStatus.FAILED
        record.reason = {"code": "target_unavailable", "message": problem or "No target."}
    else:
        workspace = await db.get(Workspace, automation.workspace_id)
        if workspace is None:  # pragma: no cover - cascades with the workspace
            return record
        ctx = WorkspaceContext(
            workspace=workspace, role="member", actor=actor or _actor(automation)
        )
        try:
            await _launch(db, ctx, automation, target, record, source, run_input)
            record.status = FireStatus.LAUNCHED
        except AppError as exc:
            await db.rollback()
            record = await _failed_after_rollback(db, record, exc)
    _account(automation, record)
    await db.commit()
    return record


async def _launch(
    db: AsyncSession,
    ctx: WorkspaceContext,
    automation: Automation,
    target: Agent | Workflow,
    record: AutomationFire,
    source: str,
    run_input: str | dict[str, Any],
) -> None:
    trigger = _TRIGGERS[source]
    if isinstance(target, Agent):
        from gouvra.modules.executions.service import launch

        execution, _ = await launch(
            db,
            ctx,
            target,
            run_input,
            trigger=trigger,
            source_id=str(automation.id),
            metadata={"automation": automation.name, "automation_fire": str(record.id)},
        )
        record.execution_id = execution.id
    else:
        from gouvra.modules.workflows.schemas import WorkflowRunCreateIn
        from gouvra.modules.workflows.service import start_run

        run, _ = await start_run(
            db,
            ctx,
            target,
            WorkflowRunCreateIn(input=run_input),
            trigger=trigger,
            source_id=str(automation.id),
        )
        record.workflow_run_id = run.id


async def _failed_after_rollback(
    db: AsyncSession, record: AutomationFire, error: AppError
) -> AutomationFire:
    """A launch refused (quota, rate limit, invalid input…): keep a trace of the attempt."""
    stored = await db.get(AutomationFire, record.id)
    if stored is None:
        stored = AutomationFire(
            id=record.id,
            automation_id=record.automation_id,
            workspace_id=record.workspace_id,
            source=record.source,
            scheduled_for=record.scheduled_for,
            delivery_id=record.delivery_id,
            request_meta=record.request_meta,
            payload_preview=record.payload_preview,
        )
        db.add(stored)
    stored.status = FireStatus.FAILED
    stored.reason = {"code": error.code, "message": error.message}
    return stored


def _account(automation: Automation, record: AutomationFire) -> None:
    automation.last_fired_at = utcnow()
    automation.last_status = record.status
    automation.fire_count += 1
    if record.status == FireStatus.LAUNCHED:
        automation.consecutive_failures = 0
    elif record.status == FireStatus.FAILED:
        automation.consecutive_failures += 1
        if automation.consecutive_failures >= MAX_FAILURES and automation.enabled:
            automation.enabled = False
            automation.next_run_at = None
            message = (record.reason or {}).get("message", "")
            automation.paused_reason = (
                f"Paused after {MAX_FAILURES} failed attempts in a row. {message}"
            )[:200]


async def run_now(
    db: AsyncSession,
    ctx: WorkspaceContext,
    automation: Automation,
    sample: str | dict[str, Any] | None,
) -> AutomationFire:
    """Fire on demand: a schedule with its input (or another), a webhook with a sample payload."""
    ctx.require(Permission.AUTOMATIONS_MANAGE)
    if automation.kind == AutomationKind.SCHEDULE:
        stored = _raw_input(sample) if sample is not None else automation.input
        if stored is None:
            raise _invalid("input", "Give the run something to work on.", "required")
        run_input = _as_launch_input(stored)
        source = "manual"
    else:
        body = (
            json.dumps(sample).encode() if isinstance(sample, dict) else (sample or "{}").encode()
        )
        run_input = webhook_input(body, automation.input_template)
        source = "test"
    return await fire(
        db,
        automation,
        source=source,
        run_input=run_input,
        preview=_preview(run_input),
        actor=ctx.actor,
    )


def _preview(value: str | dict[str, Any]) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------- webhooks


def webhook_input(body: bytes, template: str | None) -> str | dict[str, Any]:
    """The run input built from a delivery: the JSON payload (or text), through the template."""
    text = body.decode("utf-8", errors="replace")
    parsed = g.parse_json(text)
    payload: dict[str, Any] = {"json": parsed} if parsed is not None else {"text": text}
    if template:
        rendered = g.render(template, g.RunContext(input=payload))
        as_json = g.parse_json(rendered)
        if isinstance(as_json, dict):
            return as_json
        return rendered if rendered.strip() else text
    if parsed is None:
        return text if text.strip() else "(empty payload)"
    return parsed if isinstance(parsed, dict) else {"items": parsed}


class HookError(AppError):
    status_code = 400


class HookUnauthorized(HookError):
    status_code = 401
    code = "invalid_signature"
    title = "Invalid signature"


def _delivery_id(automation: Automation, headers: dict[str, str], verdict: signing.Verdict) -> str:
    explicit = (
        headers.get("idempotency-key")
        or headers.get("gouvra-delivery")
        or headers.get("x-github-delivery")
    )
    if explicit:
        return explicit.strip()[:160]
    # The same signed request is the same delivery: its timestamp and digest identify it.
    seed = f"{verdict.timestamp}:{verdict.digest}"
    return "sig_" + hashlib.sha256(seed.encode()).hexdigest()[:40]


async def receive(
    db: AsyncSession,
    token: str,
    body: bytes,
    headers: dict[str, str],
    client_ip: str | None,
) -> tuple[AutomationFire, bool]:
    """Verify, de-duplicate and fire one delivery. Returns (fire, duplicate)."""
    from gouvra.core.errors import Conflict, NotFound, PayloadTooLarge

    automation = (
        await db.execute(
            select(Automation).where(
                Automation.hook_token == token, Automation.kind == AutomationKind.WEBHOOK
            )
        )
    ).scalar_one_or_none()
    if automation is None:
        raise NotFound("No webhook at this address.", code="unknown_webhook")
    await ratelimit.hit(ratelimit.WEBHOOK_PER_TRIGGER, str(automation.id))
    limit = get_settings().max_execution_input_bytes
    if len(body) > limit:
        raise PayloadTooLarge(
            f"The payload is {len(body)} bytes; the limit is {limit} bytes.",
            details={"limit_bytes": limit},
        )
    secret = webhook_secret(automation)
    if automation.signature_format == "github":
        verdict = signing.verify_github(secret, headers.get(signing.GITHUB_HEADER), body)
        if verdict.ok and not headers.get("x-github-delivery"):
            verdict = signing.Verdict(False, "missing_delivery", "X-GitHub-Delivery is missing.")
    else:
        verdict = signing.verify_gouvra(
            secret, headers.get(signing.GOUVRA_HEADER), body, time.time()
        )
    meta = {
        "ip": client_ip,
        "content_type": headers.get("content-type"),
        "size": len(body),
        "user_agent": (headers.get("user-agent") or "")[:200] or None,
    }
    if not verdict.ok:
        rejected = AutomationFire(
            id=uuid7(),
            automation_id=automation.id,
            workspace_id=automation.workspace_id,
            source="webhook",
            status=FireStatus.REJECTED,
            reason={"code": verdict.code, "message": verdict.message},
            request_meta=meta,
        )
        db.add(rejected)
        automation.last_status = FireStatus.REJECTED
        await db.commit()
        raise HookUnauthorized(verdict.message or "Invalid signature.", code=verdict.code)
    delivery = _delivery_id(automation, headers, verdict)
    existing = (
        await db.execute(
            select(AutomationFire).where(
                AutomationFire.automation_id == automation.id,
                AutomationFire.delivery_id == delivery,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing, True
    if not automation.enabled:
        raise Conflict(
            "This automation is paused: deliveries are refused until it is resumed.",
            code="automation_paused",
        )
    run_input = webhook_input(body, automation.input_template)
    try:
        record = await fire(
            db,
            automation,
            source="webhook",
            run_input=run_input,
            delivery_id=delivery,
            meta=meta,
            preview=body.decode("utf-8", errors="replace"),
        )
    except IntegrityError:  # the same delivery, received twice at the same moment
        await db.rollback()
        existing = (
            await db.execute(
                select(AutomationFire).where(
                    AutomationFire.automation_id == automation.id,
                    AutomationFire.delivery_id == delivery,
                )
            )
        ).scalar_one()
        return existing, True
    return record, False


# ---------------------------------------------------------------- the scheduler (worker)


async def run_due(limit: int = 20) -> int:
    """Fire the schedules that are due, once each, then plan their next run."""
    fired = 0
    for _ in range(limit):
        async with get_sessionmaker()() as db:
            now = utcnow()
            automation = (
                await db.execute(
                    select(Automation)
                    .where(
                        Automation.kind == AutomationKind.SCHEDULE,
                        Automation.enabled.is_(True),
                        Automation.next_run_at <= now,
                    )
                    .order_by(Automation.next_run_at)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
            ).scalar_one_or_none()
            if automation is None or automation.cron is None or automation.timezone is None:
                return fired
            scheduled_for = automation.next_run_at or now
            # A missed tick (worker down) fires once, late; the next one is in the future.
            # Planned and committed first: a failing launch can never make the tick repeat.
            automation.next_run_at = next_after(automation.cron, automation.timezone, now)
            await db.commit()
            late_by = int((now - scheduled_for).total_seconds())
            if automation.input is None:  # pragma: no cover - required on creation
                continue
            try:
                await fire(
                    db,
                    automation,
                    source="schedule",
                    run_input=_as_launch_input(automation.input),
                    scheduled_for=scheduled_for,
                    meta={"late_by_s": late_by} if late_by > 60 else None,
                )
            except Exception:
                log.exception("schedule_fire_failed", automation_id=str(automation.id))
                await db.rollback()
                continue
            fired += 1
    return fired


async def reap_pending() -> int:
    """Fires left pending by a crash between their record and their launch."""
    async with get_sessionmaker()() as db:
        result = await db.execute(
            update(AutomationFire)
            .where(
                AutomationFire.status == FireStatus.PENDING,
                AutomationFire.created_at < utcnow() - PENDING_TIMEOUT,
            )
            .values(
                status=FireStatus.FAILED,
                reason={"code": "worker_lost", "message": "The launch was interrupted."},
            )
            .returning(AutomationFire.id)
        )
        count = len(result.all())
        await db.commit()
        return count
