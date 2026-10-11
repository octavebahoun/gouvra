"""Workflow orchestrator: advances runs step by step, in the worker.

A run is a small state machine stored in PostgreSQL. `advance_run` locks one run, settles the
steps whose work finished, then walks the graph once in topological order: a step becomes ready
when all its inputs are settled and at least one incoming link is active (a successful source,
the matching branch of a condition, or a failed source allowed to continue); otherwise it is
skipped. Light steps (input, transform, condition, output) complete inline; agent steps queue an
ordinary execution; tool steps are handed back to the worker to run outside the lock. Whatever
happens next — a finished execution, a tool result, a cancellation, the deadline — wakes the run.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.errors import AppError
from gouvra.core.ids import uuid7
from gouvra.core.logging import get_logger
from gouvra.modules.agents.models import Agent
from gouvra.modules.agents.service import readiness
from gouvra.modules.executions.events import (
    append_event,
    cap,
    publish,
    publish_event,
    publish_status,
    workspace_channel,
)
from gouvra.modules.executions.models import (
    TERMINAL,
    Execution,
    ExecutionEvent,
    ExecutionStatus,
    Trigger,
)
from gouvra.modules.executions.queue import notify_cancel, notify_queue
from gouvra.modules.executions.service import normalise_input
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.tools.models import Tool
from gouvra.modules.tools.runtime import run_tool
from gouvra.modules.workflows import graph as g
from gouvra.modules.workflows.models import (
    RUN_TERMINAL,
    STEP_TERMINAL,
    RunStatus,
    StepStatus,
    WorkflowRun,
    WorkflowStep,
)
from gouvra.modules.workflows.service import WF_CHANNEL, _agent_version

log = get_logger(__name__)

RECHECK = timedelta(seconds=30)  # a running run is looked at again at least this often
TOOL_GRACE = timedelta(seconds=30)  # beyond the tool's own timeout, before its step is lost


def run_channel(run_id: uuid.UUID | str) -> str:
    return f"gouvra:wfrun:{run_id}"


@dataclass
class ToolJob:
    run_id: uuid.UUID
    step_id: uuid.UUID
    tool_id: uuid.UUID
    arguments: dict[str, Any]


@dataclass
class _Advance:
    """What one advance produced, to act on after its transaction commits."""

    jobs: list[ToolJob] = field(default_factory=list)
    events: list[ExecutionEvent] = field(default_factory=list)
    executions: list[uuid.UUID] = field(default_factory=list)


# ---------------------------------------------------------------- live view


def step_dict(step: WorkflowStep) -> dict[str, Any]:
    return {
        "id": str(step.id),
        "node_id": step.node_id,
        "node_type": step.node_type,
        "label": step.label,
        "position": step.position,
        "status": step.status,
        "input": cap(step.input),
        "output": cap(step.output),
        "error": step.error,
        "branch": step.branch,
        "execution_id": str(step.execution_id) if step.execution_id else None,
        "attempt": step.attempt,
        "started_at": step.started_at.isoformat() if step.started_at else None,
        "finished_at": step.finished_at.isoformat() if step.finished_at else None,
        "duration_ms": step.duration_ms,
        "input_tokens": step.input_tokens,
        "output_tokens": step.output_tokens,
        "cost_amount": str(step.cost_amount) if step.cost_amount is not None else None,
        "cost_source": step.cost_source,
    }


def run_head(run: WorkflowRun) -> dict[str, Any]:
    return {
        "id": str(run.id),
        "status": run.status,
        "output": cap(run.output),
        "error": run.error,
        "steps_done": run.steps_done,
        "steps_total": run.steps_total,
        "duration_ms": run.duration_ms,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "cancel_requested_at": run.cancel_requested_at.isoformat()
        if run.cancel_requested_at
        else None,
        "input_tokens": run.input_tokens,
        "output_tokens": run.output_tokens,
        "cost_amount": str(run.cost_amount) if run.cost_amount is not None else None,
        "cost_source": run.cost_source,
        "cost_partial": run.cost_partial,
    }


def snapshot(run: WorkflowRun, steps: list[WorkflowStep]) -> dict[str, Any]:
    """The whole live state (a run has at most 60 steps): a reconnecting viewer loses nothing."""
    return {"kind": "snapshot", "run": run_head(run), "steps": [step_dict(s) for s in steps]}


async def publish_run(run: WorkflowRun, steps: list[WorkflowStep]) -> None:
    await publish(run_channel(run.id), snapshot(run, steps))
    await publish(
        workspace_channel(run.workspace_id),
        {
            "kind": "workflow_run.status",
            "run_id": str(run.id),
            "workflow_id": str(run.workflow_id) if run.workflow_id else None,
            "status": run.status,
            "at": utcnow().isoformat(),
        },
    )


# ---------------------------------------------------------------- waking runs up


async def notify_workflows(run_id: uuid.UUID | None = None) -> None:
    """Wake the orchestrator, flagging one run as needing attention."""
    async with get_sessionmaker()() as db:
        if run_id is not None:
            await db.execute(
                update(WorkflowRun)
                .where(WorkflowRun.id == run_id, WorkflowRun.status == RunStatus.RUNNING)
                .values(needs_advance=True)
            )
        await db.execute(
            text("SELECT pg_notify(:c, :p)"), {"c": WF_CHANNEL, "p": str(run_id or "")}
        )
        await db.commit()


async def due_runs(limit: int = 20) -> list[uuid.UUID]:
    async with get_sessionmaker()() as db:
        rows = await db.execute(
            select(WorkflowRun.id)
            .where(
                WorkflowRun.status == RunStatus.RUNNING,
                or_(WorkflowRun.needs_advance.is_(True), WorkflowRun.wake_at <= utcnow()),
            )
            .order_by(WorkflowRun.wake_at)
            .limit(limit)
        )
        return list(rows.scalars())


# ---------------------------------------------------------------- step helpers


def _finish(step: WorkflowStep, status: StepStatus, now: datetime) -> None:
    step.status = status
    step.started_at = step.started_at or now
    step.finished_at = now
    step.deadline_at = None
    step.duration_ms = int((now - step.started_at).total_seconds() * 1000)


def _succeed(step: WorkflowStep, text_out: str | None, json_out: Any, now: datetime) -> None:
    step.output = {"text": text_out, "json": json_out}
    step.error = None
    _finish(step, StepStatus.SUCCEEDED, now)


def _fail(step: WorkflowStep, error: dict[str, Any], now: datetime) -> None:
    step.error = error
    _finish(step, StepStatus.FAILED, now)


def _value_of(step: WorkflowStep) -> g.StepValue:
    output = step.output or {}
    return g.StepValue(
        output=output.get("text"),
        json=output.get("json"),
        status=step.status,
        error=(step.error or {}).get("message"),
    )


def _continues(analysis: g.Analysis, node_id: str) -> bool:
    return getattr(analysis.nodes.get(node_id), "on_error", "fail") == "continue"


def _incoming(node_id: str, analysis: g.Analysis, steps: dict[str, WorkflowStep]) -> str:
    """'wait' while a source is unsettled; then 'ready' if a link is active, else 'skip'."""
    edges = analysis.parents[node_id]
    if not edges:
        return "ready"
    active = False
    for edge in edges:
        source = steps[edge.source]
        if source.status in (StepStatus.PENDING, StepStatus.RUNNING):
            return "wait"
        if source.status == StepStatus.SUCCEEDED:
            active = active or edge.branch is None or edge.branch == source.branch
        elif source.status == StepStatus.FAILED:
            active = active or _continues(analysis, edge.source)
    return "ready" if active else "skip"


def _execution_output(execution: Execution) -> tuple[str | None, Any]:
    output = execution.output or {}
    text_out = output.get("text") if isinstance(output.get("text"), str) else None
    json_out = output["json"] if "json" in output else g.parse_json(text_out)
    return text_out, json_out


def _tool_output(value: Any) -> tuple[str, Any]:
    if isinstance(value, str):
        return value, g.parse_json(value)
    return g.stringify(value), value


async def _launch_agent(
    db: AsyncSession,
    run: WorkflowRun,
    step: WorkflowStep,
    node: g.AgentNode,
    text_in: str,
    now: datetime,
    out: _Advance,
) -> str | None:
    """Queue the agent's execution for this step. Returns an error code when it cannot run."""
    agent = (
        await db.execute(
            select(Agent).where(Agent.id == node.agent_id, Agent.workspace_id == run.workspace_id)
        )
    ).scalar_one_or_none()
    if agent is None or agent.archived_at is not None:
        return "unknown_agent"
    version = await _agent_version(db, agent, node.version)
    if version is None or not (await readiness(db, version)).ready:
        return "agent_not_ready"
    from gouvra.modules.usage.guard import check_launch_allowed

    try:
        await check_launch_allowed(db, run.workspace_id)
    except AppError as exc:
        return exc.code
    settings = get_settings()
    provider = (
        await db.get(ProviderConfig, version.provider_config_id)
        if version.provider_config_id
        else None
    )
    remaining = max(5, int((run.deadline_at - now).total_seconds()))
    timeout = min(
        int((version.limits or {}).get("timeout_s", settings.default_execution_timeout_s)),
        settings.max_execution_timeout_s,
        remaining,
    )
    execution = Execution(
        id=uuid7(),
        workspace_id=run.workspace_id,
        agent_id=agent.id,
        agent_version_id=version.id,
        workflow_run_id=run.id,
        trigger=Trigger.WORKFLOW,
        triggered_by_user_id=run.triggered_by_user_id,
        api_key_id=run.api_key_id,
        source_id=str(run.id),
        status=ExecutionStatus.QUEUED,
        input=normalise_input(text_in if text_in.strip() else "(empty)"),
        metadata_={"workflow": run.workflow_name, "workflow_step": step.node_id},
        priority=0,
        timeout_s=timeout,
        provider_kind=provider.kind if provider else None,
        model=version.model,
        cost_source="unavailable",
    )
    db.add(execution)
    await db.flush()
    event = await append_event(
        db,
        execution.id,
        run.workspace_id,
        "execution.queued",
        {
            "trigger": Trigger.WORKFLOW.value,
            "agent": agent.name,
            "agent_version": version.number,
            "input_preview": text_in[:500],
            "timeout_s": timeout,
            "workflow": run.workflow_name,
            "workflow_step": step.label,
        },
    )
    if event is not None:
        out.events.append(event)
    out.executions.append(execution.id)
    step.execution_id = execution.id
    step.status = StepStatus.RUNNING
    step.started_at = step.started_at or now
    step.attempt += 1
    step.input = {"text": text_in}
    await notify_queue(db)
    return None


async def _stop_children(
    db: AsyncSession, run: WorkflowRun, steps: list[WorkflowStep], reason: str, out: _Advance
) -> None:
    """Stop the executions still working for this run, with their trace saying why."""
    ids = [s.execution_id for s in steps if s.status == StepStatus.RUNNING and s.execution_id]
    if not ids:
        return
    now = utcnow()
    error = {"code": "cancelled", "message": reason, "retryable": False}
    queued = (
        await db.execute(
            update(Execution)
            .where(Execution.id.in_(ids), Execution.status == ExecutionStatus.QUEUED)
            .values(
                status=ExecutionStatus.CANCELLED,
                cancel_requested_at=now,
                finished_at=now,
                duration_ms=0,
                error=error,
            )
            .returning(Execution.id)
        )
    ).scalars()
    for execution_id in list(queued):
        event = await append_event(
            db,
            execution_id,
            run.workspace_id,
            "execution.cancelled",
            {"error": error, "duration_ms": 0},
            level="warning",
        )
        if event is not None:
            out.events.append(event)
        out.executions.append(execution_id)
    for execution_id in ids:
        event = await append_event(
            db,
            execution_id,
            run.workspace_id,
            "execution.cancel_requested",
            {"by": "workflow", "reason": reason},
            level="warning",
            extra_values={"cancel_requested_at": now},
            only_if_status=ExecutionStatus.RUNNING,
        )
        if event is not None:
            out.events.append(event)
            await notify_cancel(db, execution_id)


def _close(run: WorkflowRun, now: datetime) -> None:
    run.finished_at = now
    run.needs_advance = False
    if run.started_at is not None:
        run.duration_ms = int((now - run.started_at).total_seconds() * 1000)


def _halt(
    run: WorkflowRun,
    steps: list[WorkflowStep],
    status: RunStatus,
    error: dict[str, Any],
    now: datetime,
) -> None:
    for step in steps:
        if step.status == StepStatus.PENDING:
            _finish(step, StepStatus.SKIPPED, now)
        elif step.status == StepStatus.RUNNING:
            step.error = {"code": error["code"], "message": error["message"]}
            _finish(step, StepStatus.CANCELLED, now)
    run.status = status
    run.error = error
    _close(run, now)


def _totals(run: WorkflowRun, steps: list[WorkflowStep]) -> None:
    run.steps_done = sum(1 for s in steps if s.status in STEP_TERMINAL)
    run.input_tokens = sum(s.input_tokens for s in steps)
    run.output_tokens = sum(s.output_tokens for s in steps)
    priced = [s for s in steps if s.cost_amount is not None]
    if not priced:
        run.cost_amount, run.cost_currency, run.cost_source = None, None, "unavailable"
        run.cost_partial = False
        return
    run.cost_amount = sum((s.cost_amount or Decimal(0) for s in priced), Decimal(0))
    run.cost_currency = "USD"
    reported = all(s.cost_source == "provider_reported" for s in priced)
    run.cost_source = "provider_reported" if reported else "estimated"
    run.cost_partial = len(priced) < sum(1 for s in steps if s.execution_id is not None)


def _complete(
    run: WorkflowRun, analysis: g.Analysis, steps: dict[str, WorkflowStep], now: datetime
) -> None:
    ends = [
        steps[node_id]
        for node_id in analysis.order
        if isinstance(analysis.nodes[node_id], g.EndNode)
        and steps[node_id].status == StepStatus.SUCCEEDED
    ]
    if not ends:
        run.status = RunStatus.FAILED
        run.error = {
            "code": "no_output",
            "message": "No output step was reached: every path stopped before one.",
        }
    elif len(ends) == 1:
        run.status = RunStatus.SUCCEEDED
        run.output = ends[0].output
    else:
        run.status = RunStatus.SUCCEEDED
        merged: dict[str, Any] = {}
        for end in ends:
            value = _value_of(end)
            merged[end.node_id] = value.json if value.json is not None else value.output
        run.output = {"text": g.stringify(merged), "json": merged}
    _close(run, now)


# ---------------------------------------------------------------- advancing


async def advance_run(run_id: uuid.UUID) -> list[ToolJob]:
    """Move one run forward as far as possible. Returns tool calls to run outside the lock."""
    out = _Advance()
    async with get_sessionmaker()() as db:
        run = (
            await db.execute(
                select(WorkflowRun)
                .where(WorkflowRun.id == run_id)
                .with_for_update(skip_locked=True)
            )
        ).scalar_one_or_none()
        if run is None or run.status in RUN_TERMINAL:
            return []
        run.needs_advance = False
        analysis = g.analyse(g.Graph.model_validate(run.graph))
        step_list = list(
            (
                await db.execute(
                    select(WorkflowStep)
                    .where(WorkflowStep.run_id == run.id)
                    .order_by(WorkflowStep.position)
                )
            ).scalars()
        )
        steps = {s.node_id: s for s in step_list}
        now = utcnow()
        await _settle(db, run, analysis, step_list, now, out)
        if run.cancel_requested_at is not None:
            await _stop_children(db, run, step_list, "The workflow run was cancelled.", out)
            _halt(
                run,
                step_list,
                RunStatus.CANCELLED,
                {"code": "cancelled", "message": "Cancelled on request."},
                now,
            )
        elif now >= run.deadline_at:
            await _stop_children(db, run, step_list, "The workflow ran out of time.", out)
            _halt(
                run,
                step_list,
                RunStatus.TIMED_OUT,
                {
                    "code": "timeout",
                    "message": f"The workflow did not finish within {run.timeout_s} s.",
                },
                now,
            )
        else:
            await _walk(db, run, analysis, steps, now, out)
            await _conclude(db, run, analysis, steps, now, out)
        _totals(run, step_list)
        deadlines = [s.deadline_at for s in step_list if s.deadline_at is not None]
        run.wake_at = min([run.deadline_at, now + RECHECK, *deadlines])
        await db.commit()
        await publish_run(run, step_list)
    for event in out.events:
        await publish_event(event)
    if out.executions:
        async with get_sessionmaker()() as db:
            for execution_id in out.executions:
                execution = await db.get(Execution, execution_id)
                if execution is not None:
                    await publish_status(execution)
    return out.jobs


async def _conclude(
    db: AsyncSession,
    run: WorkflowRun,
    analysis: g.Analysis,
    steps: dict[str, WorkflowStep],
    now: datetime,
    out: _Advance,
) -> None:
    """A failed step stops the run (unless it may continue); a settled graph completes it."""
    step_list = list(steps.values())
    fatal = next(
        (
            step
            for node_id in analysis.order
            if (step := steps[node_id]).status == StepStatus.FAILED
            and not _continues(analysis, node_id)
        ),
        None,
    )
    if fatal is not None:
        out.jobs.clear()  # nothing new starts once the run has failed
        await _stop_children(db, run, step_list, "Another step of the workflow failed.", out)
        error = dict(fatal.error or {})
        cause = error.get("message") or error.get("code") or "unknown error"
        error.update(
            code=error.get("code") or "step_failed",
            step=fatal.node_id,
            message=f"Step “{fatal.label}” failed: {cause}",
        )
        _halt(run, step_list, RunStatus.FAILED, error, now)
    elif all(step.status in STEP_TERMINAL for step in step_list):
        _complete(run, analysis, steps, now)


async def _settle(
    db: AsyncSession,
    run: WorkflowRun,
    analysis: g.Analysis,
    step_list: list[WorkflowStep],
    now: datetime,
    out: _Advance,
) -> None:
    """Record the outcome of the steps whose execution or tool call has finished."""
    for step in step_list:
        if step.status != StepStatus.RUNNING:
            continue
        if step.execution_id is None:
            # A tool step: its result is written by the worker that ran it.
            if step.deadline_at is not None and now > step.deadline_at:
                _fail(
                    step,
                    {
                        "code": "worker_lost",
                        "message": "The worker running this tool stopped responding.",
                        "retryable": True,
                    },
                    now,
                )
            continue
        execution = await db.get(Execution, step.execution_id)
        if execution is None:
            _fail(step, {"code": "execution_missing", "message": "The execution was deleted."}, now)
            continue
        if execution.status not in TERMINAL:
            continue
        step.input_tokens += execution.input_tokens
        step.output_tokens += execution.output_tokens
        if execution.cost_amount is not None:
            step.cost_amount = (step.cost_amount or Decimal(0)) + execution.cost_amount
            step.cost_source = execution.cost_source
        if execution.status == ExecutionStatus.SUCCEEDED:
            text_out, json_out = _execution_output(execution)
            _succeed(step, text_out, json_out, now)
            continue
        error = dict(
            execution.error
            or {"code": execution.status, "message": "The execution did not succeed."}
        )
        node = analysis.nodes.get(step.node_id)
        if (
            isinstance(node, g.AgentNode)
            and error.get("retryable")
            and step.attempt <= node.retries
            and execution.status != ExecutionStatus.CANCELLED
            and run.cancel_requested_at is None
        ):
            text_in = (step.input or {}).get("text") or ""
            problem = await _launch_agent(db, run, step, node, text_in, now, out)
            if problem is None:
                continue
            error = {"code": problem, "message": "The agent could not be launched again."}
        _fail(step, error, now)


async def _walk(
    db: AsyncSession,
    run: WorkflowRun,
    analysis: g.Analysis,
    steps: dict[str, WorkflowStep],
    now: datetime,
    out: _Advance,
) -> None:
    """One pass in topological order: every source is settled before its targets are seen."""
    context = g.RunContext(input=run.input, steps={k: _value_of(v) for k, v in steps.items()})
    for node_id in analysis.order:
        step = steps[node_id]
        if step.status != StepStatus.PENDING:
            continue
        state = _incoming(node_id, analysis, steps)
        if state == "wait":
            continue
        if state == "skip":
            _finish(step, StepStatus.SKIPPED, now)
        else:
            step.started_at = now
            node = analysis.nodes[node_id]
            try:
                await _start(db, run, step, node, context, analysis, steps, now, out)
            except g.ConditionError as exc:
                _fail(step, {"code": "condition_error", "message": str(exc)}, now)
        context.steps[node_id] = _value_of(step)


async def _start(
    db: AsyncSession,
    run: WorkflowRun,
    step: WorkflowStep,
    node: g.AnyNode,
    context: g.RunContext,
    analysis: g.Analysis,
    steps: dict[str, WorkflowStep],
    now: datetime,
    out: _Advance,
) -> None:
    if isinstance(node, g.StartNode):
        if "json" in run.input:
            _succeed(step, g.stringify(run.input["json"]), run.input["json"], now)
        else:
            text_in = run.input.get("text")
            _succeed(step, text_in, g.parse_json(text_in), now)
    elif isinstance(node, g.TransformNode):
        rendered = g.render(node.template, context)
        parsed = g.parse_json(rendered)
        if node.output == "json" and parsed is None:
            step.input = {"rendered": rendered[:2000]}
            _fail(step, {"code": "invalid_json", "message": "The result is not valid JSON."}, now)
        else:
            _succeed(step, rendered, parsed, now)
    elif isinstance(node, g.ConditionNode):
        result, value = g.evaluate(node, context)
        step.branch = "true" if result else "false"
        step.input = {"value": value[:2000], "operator": node.operator, "operand": node.operand}
        _succeed(step, step.branch, {"result": result, "value": value[:2000]}, now)
    elif isinstance(node, g.EndNode):
        _end(step, node, context, analysis, steps, now)
    elif isinstance(node, g.AgentNode):
        rendered = g.render(node.input, context)
        problem = await _launch_agent(db, run, step, node, rendered, now, out)
        if problem is not None:
            _fail(step, {"code": problem, "message": "The agent could not be started."}, now)
    elif isinstance(node, g.ToolNode):
        arguments = g.render_value(node.arguments, context)
        step.input = arguments
        step.attempt += 1
        tool = await db.get(Tool, node.tool_id)
        if tool is None or tool.workspace_id != run.workspace_id:
            _fail(step, {"code": "tool_unavailable", "message": "The tool no longer exists."}, now)
            return
        step.status = StepStatus.RUNNING
        step.deadline_at = now + timedelta(milliseconds=tool.timeout_ms) + TOOL_GRACE
        out.jobs.append(ToolJob(run.id, step.id, tool.id, arguments))


def _end(
    step: WorkflowStep,
    node: g.EndNode,
    context: g.RunContext,
    analysis: g.Analysis,
    steps: dict[str, WorkflowStep],
    now: datetime,
) -> None:
    """An output step renders its template, or passes on the result of the step before it."""
    if node.output:
        rendered = g.render(node.output, context)
        _succeed(step, rendered, g.parse_json(rendered), now)
        return
    source = next(
        (
            steps[edge.source]
            for edge in analysis.parents[step.node_id]
            if steps[edge.source].status == StepStatus.SUCCEEDED
        ),
        None,
    )
    value = _value_of(source) if source is not None else g.StepValue()
    _succeed(step, value.output, value.json, now)


# ---------------------------------------------------------------- tool steps (outside the lock)


async def run_tool_step(job: ToolJob) -> None:
    async with get_sessionmaker()() as db:
        tool = await db.get(Tool, job.tool_id)
    result = await run_tool(tool, job.arguments) if tool is not None else None
    now = utcnow()
    async with get_sessionmaker()() as db:
        step = (
            await db.execute(
                select(WorkflowStep).where(WorkflowStep.id == job.step_id).with_for_update()
            )
        ).scalar_one_or_none()
        if step is None or step.status != StepStatus.RUNNING:
            return  # the run stopped meanwhile
        if result is not None and result.ok:
            text_out, json_out = _tool_output(result.output)
            _succeed(step, text_out, json_out, now)
            step.duration_ms = result.duration_ms
        elif result is not None:
            error = {"code": result.error_code, "message": result.error_message}
            _fail(step, error, now)
        else:
            _fail(step, {"code": "tool_unavailable", "message": "The tool no longer exists."}, now)
        await db.execute(
            update(WorkflowRun).where(WorkflowRun.id == job.run_id).values(needs_advance=True)
        )
        await db.execute(text("SELECT pg_notify(:c, :p)"), {"c": WF_CHANNEL, "p": str(job.run_id)})
        await db.commit()
    log.info("workflow_tool_step", run_id=str(job.run_id), ok=bool(result and result.ok))
