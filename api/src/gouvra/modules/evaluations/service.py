"""Evaluations: suites and cases, runs (one execution per case), grading, summaries, comparisons."""

from __future__ import annotations

import json
import statistics
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import Permission, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.core.logging import get_logger
from gouvra.modules.agents.models import Agent, AgentVersion
from gouvra.modules.agents.service import readiness
from gouvra.modules.audit.service import record_for
from gouvra.modules.evaluations import graders as g
from gouvra.modules.evaluations.models import EvalCase, EvalResult, EvalRun, EvalSuite
from gouvra.modules.evaluations.schemas import (
    MAX_CASES,
    CaseIn,
    CaseUpdateIn,
    RunCreateIn,
    RunSummary,
    SuiteCreateIn,
    SuiteUpdateIn,
)
from gouvra.modules.executions.events import EventEmitter
from gouvra.modules.executions.models import (
    TERMINAL,
    Execution,
    ExecutionStatus,
    Trigger,
    UsageRecord,
)
from gouvra.modules.executions.queue import notify_queue
from gouvra.modules.executions.service import normalise_input
from gouvra.modules.providers.catalog import find_model
from gouvra.modules.providers.gateway.types import ChatMessage, ChatRequest, GatewayError
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.providers.pricing import estimate
from gouvra.modules.providers.service import adapter_for

log = get_logger(__name__)
EVAL_CHANNEL = "gouvra_evaluations"


def _invalid(field: str, message: str, code: str = "invalid") -> ValidationFailed:
    return ValidationFailed(errors=[{"field": field, "code": code, "message": message}])


def _expected(value: str | dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {"text": value} if isinstance(value, str) else {"json": value}


def _dump_graders(specs: list[Any] | None) -> list[dict[str, Any]] | None:
    if specs is None:
        return None
    return [s.model_dump(mode="json", by_alias=True) for s in specs]


async def _check_agent(
    db: AsyncSession, workspace_id: uuid.UUID, agent_id: uuid.UUID | None
) -> Agent | None:
    if agent_id is None:
        return None
    agent = (
        await db.execute(
            select(Agent).where(Agent.id == agent_id, Agent.workspace_id == workspace_id)
        )
    ).scalar_one_or_none()
    if agent is None:
        raise _invalid("agent_id", "This agent does not exist in the workspace.", "not_found")
    return agent


async def _check_judges(
    db: AsyncSession, workspace_id: uuid.UUID, specs: list[Any] | None, field: str
) -> None:
    for spec in specs or []:
        if isinstance(spec, g.LlmJudgeGrader):
            try:
                provider_id = uuid.UUID(spec.provider_id)
            except ValueError as exc:
                raise _invalid(field, "The judge provider id is invalid.") from exc
            found = (
                await db.execute(
                    select(func.count())
                    .select_from(ProviderConfig)
                    .where(
                        ProviderConfig.id == provider_id,
                        ProviderConfig.workspace_id == workspace_id,
                    )
                )
            ).scalar_one()
            if not found:
                raise _invalid(
                    field, "The judge provider does not exist in the workspace.", "not_found"
                )


# ---------------------------------------------------------------- suites & cases


async def create_suite(
    db: AsyncSession, ctx: WorkspaceContext, payload: SuiteCreateIn
) -> EvalSuite:
    await _check_agent(db, ctx.workspace_id, payload.agent_id)
    await _check_judges(db, ctx.workspace_id, payload.default_graders, "default_graders")
    suite = EvalSuite(
        workspace_id=ctx.workspace_id,
        name=payload.name,
        description=payload.description,
        agent_id=payload.agent_id,
        default_graders=_dump_graders(payload.default_graders) or [],
        pass_threshold=payload.pass_threshold,
        created_by_id=ctx.actor.user_id,
    )
    db.add(suite)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A suite with this name already exists.", "taken") from exc
    await record_for(
        db,
        ctx.actor,
        "evaluation.suite_created",
        workspace_id=ctx.workspace_id,
        target_type="eval_suite",
        target_id=suite.id,
    )
    await db.commit()
    return suite


async def update_suite(
    db: AsyncSession, ctx: WorkspaceContext, suite: EvalSuite, payload: SuiteUpdateIn
) -> EvalSuite:
    fields = payload.model_fields_set
    if "name" in fields and payload.name:
        suite.name = payload.name
    if "description" in fields and payload.description is not None:
        suite.description = payload.description
    if "agent_id" in fields:
        await _check_agent(db, ctx.workspace_id, payload.agent_id)
        suite.agent_id = payload.agent_id
    if "default_graders" in fields and payload.default_graders is not None:
        await _check_judges(db, ctx.workspace_id, payload.default_graders, "default_graders")
        suite.default_graders = _dump_graders(payload.default_graders) or []
    if "pass_threshold" in fields and payload.pass_threshold is not None:
        suite.pass_threshold = payload.pass_threshold
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _invalid("name", "A suite with this name already exists.", "taken") from exc
    await db.commit()
    return suite


async def archive_suite(db: AsyncSession, ctx: WorkspaceContext, suite: EvalSuite) -> None:
    suite.archived_at = utcnow()
    await record_for(
        db,
        ctx.actor,
        "evaluation.suite_archived",
        workspace_id=ctx.workspace_id,
        target_type="eval_suite",
        target_id=suite.id,
    )
    await db.commit()


async def case_count(db: AsyncSession, suite_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count()).select_from(EvalCase).where(EvalCase.suite_id == suite_id)
            )
        ).scalar_one()
    )


async def add_cases(
    db: AsyncSession,
    ctx: WorkspaceContext,
    suite: EvalSuite,
    cases: list[CaseIn],
    *,
    replace: bool = False,
) -> list[EvalCase]:
    if replace:
        await db.execute(delete(EvalCase).where(EvalCase.suite_id == suite.id))
    existing = 0 if replace else await case_count(db, suite.id)
    if existing + len(cases) > MAX_CASES:
        raise _invalid("cases", f"A suite holds at most {MAX_CASES} cases.", "too_many")
    created: list[EvalCase] = []
    for offset, case in enumerate(cases):
        await _check_judges(db, ctx.workspace_id, case.graders, f"cases.{offset}.graders")
        row = EvalCase(
            suite_id=suite.id,
            workspace_id=ctx.workspace_id,
            name=case.name,
            input=normalise_input(case.input),
            expected=_expected(case.expected),
            graders=_dump_graders(case.graders),
            tags=list(dict.fromkeys(case.tags)),
            position=existing + offset,
        )
        db.add(row)
        created.append(row)
    suite.updated_at = utcnow()
    await db.commit()
    return created


async def update_case(
    db: AsyncSession, ctx: WorkspaceContext, case: EvalCase, payload: CaseUpdateIn
) -> EvalCase:
    fields = payload.model_fields_set
    if "name" in fields and payload.name:
        case.name = payload.name
    if "input" in fields and payload.input is not None:
        case.input = normalise_input(payload.input)
    if "expected" in fields:
        case.expected = _expected(payload.expected)
    if "graders" in fields:
        await _check_judges(db, ctx.workspace_id, payload.graders, "graders")
        case.graders = _dump_graders(payload.graders)
    if "tags" in fields and payload.tags is not None:
        case.tags = list(dict.fromkeys(payload.tags))
    if "position" in fields and payload.position is not None:
        case.position = payload.position
    await db.commit()
    return case


# ---------------------------------------------------------------- runs


async def _variant(
    db: AsyncSession, ctx: WorkspaceContext, agent: Agent, payload: RunCreateIn
) -> tuple[AgentVersion | None, dict[str, Any]]:
    """The agent version under test and the run-only overrides (model, provider, prompt)."""
    if payload.agent_version is not None:
        version = (
            await db.execute(
                select(AgentVersion).where(
                    AgentVersion.agent_id == agent.id, AgentVersion.number == payload.agent_version
                )
            )
        ).scalar_one_or_none()
        if version is None:
            raise _invalid("agent_version", "This version does not exist.", "not_found")
    else:
        version = (
            await db.get(AgentVersion, agent.current_version_id)
            if agent.current_version_id
            else None
        )
    overrides: dict[str, Any] = {}
    if payload.provider_id is not None:
        provider = (
            await db.execute(
                select(ProviderConfig).where(
                    ProviderConfig.id == payload.provider_id,
                    ProviderConfig.workspace_id == ctx.workspace_id,
                )
            )
        ).scalar_one_or_none()
        if provider is None:
            raise _invalid(
                "provider_id", "This provider does not exist in the workspace.", "not_found"
            )
        overrides["provider_id"] = str(provider.id)
    if payload.model:
        overrides["model"] = payload.model
    if payload.instructions is not None:
        overrides["instructions"] = payload.instructions
    return version, overrides


async def start_run(
    db: AsyncSession, ctx: WorkspaceContext, suite: EvalSuite, payload: RunCreateIn
) -> EvalRun:
    ctx.require(Permission.EVALUATIONS_WRITE)
    ctx.require(Permission.EXECUTIONS_LAUNCH)
    if suite.archived_at is not None:
        raise Conflict("Restore the suite before running it.", code="suite_archived")
    agent = await _check_agent(db, ctx.workspace_id, payload.agent_id)
    assert agent is not None  # noqa: S101 - agent_id is required by the schema
    version, overrides = await _variant(db, ctx, agent, payload)
    check = await readiness(db, version)
    if not check.ready and not ("provider_id" in overrides and "model" in overrides):
        raise Conflict(
            "The agent cannot run yet.", code="agent_not_ready", details={"issues": check.issues}
        )
    assert version is not None  # noqa: S101 - readiness guarantees a version
    cases = list(
        (
            await db.execute(
                select(EvalCase)
                .where(EvalCase.suite_id == suite.id)
                .order_by(EvalCase.position, EvalCase.created_at)
            )
        ).scalars()
    )
    if not cases:
        raise Conflict("Add at least one case before running the suite.", code="suite_empty")
    from gouvra.modules.usage.guard import check_launch_allowed

    await check_launch_allowed(db, ctx.workspace_id)
    model = overrides.get("model") or version.model
    effective_provider = (
        await db.get(ProviderConfig, uuid.UUID(overrides["provider_id"]))
        if "provider_id" in overrides
        else (
            await db.get(ProviderConfig, version.provider_config_id)
            if version.provider_config_id
            else None
        )
    )
    now = utcnow()
    variant = (
        f"v{version.number}"
        + (f" · {model}" if "model" in overrides else "")
        + (" · custom prompt" if "instructions" in overrides else "")
    )
    run = EvalRun(
        id=uuid7(),
        suite_id=suite.id,
        workspace_id=ctx.workspace_id,
        label=payload.label or f"{agent.name} {variant}",
        status="running",
        agent_id=agent.id,
        agent_version_id=version.id,
        agent_version_number=version.number,
        overrides=overrides,
        model=model,
        pass_threshold=suite.pass_threshold,
        summary=RunSummary(cases=len(cases), pending=len(cases)).model_dump(mode="json"),
        created_by_id=ctx.actor.user_id,
        started_at=now,
    )
    db.add(run)
    settings = get_settings()
    timeout = min(
        int((version.limits or {}).get("timeout_s", settings.default_execution_timeout_s)),
        settings.max_execution_timeout_s,
    )
    execution_ids: list[uuid.UUID] = []
    results: list[EvalResult] = []
    for position, case in enumerate(cases):
        execution = Execution(
            id=uuid7(),
            workspace_id=ctx.workspace_id,
            agent_id=agent.id,
            agent_version_id=version.id,
            trigger=Trigger.EVALUATION,
            triggered_by_user_id=ctx.actor.user_id,
            api_key_id=ctx.actor.api_key_id,
            source_id=str(run.id),
            status=ExecutionStatus.QUEUED,
            input=case.input,
            metadata_={"eval_run": str(run.id), "eval_case": str(case.id)},
            config_overrides=overrides,
            priority=-1,  # interactive runs go first
            timeout_s=timeout,
            provider_kind=effective_provider.kind if effective_provider else None,
            model=model,
            cost_source="unavailable",
        )
        db.add(execution)
        results.append(
            EvalResult(
                run_id=run.id,
                case_id=case.id,
                workspace_id=ctx.workspace_id,
                execution_id=execution.id,
                case_name=case.name,
                position=position,
                status="pending",
            )
        )
        execution_ids.append(execution.id)
    await db.flush()  # executions first: results reference them
    db.add_all(results)
    await db.flush()
    await notify_queue(db)
    await record_for(
        db,
        ctx.actor,
        "evaluation.run_started",
        workspace_id=ctx.workspace_id,
        target_type="eval_run",
        target_id=run.id,
        data={"cases": len(cases), "overrides": sorted(overrides)},
    )
    await db.commit()
    for execution_id in execution_ids:
        await EventEmitter(execution_id, ctx.workspace_id, 0).emit(
            "execution.queued", {"trigger": "evaluation", "evaluation_run": str(run.id)}
        )
    return run


async def cancel_run(db: AsyncSession, ctx: WorkspaceContext, run: EvalRun) -> EvalRun:
    if run.status != "running":
        raise Conflict("This run has already finished.", code="run_finished")
    from gouvra.modules.executions.service import cancel

    rows = list(
        (
            await db.execute(
                select(Execution).where(
                    Execution.source_id == str(run.id),
                    Execution.status.in_([ExecutionStatus.QUEUED, ExecutionStatus.RUNNING]),
                )
            )
        ).scalars()
    )
    for execution in rows:
        try:
            await cancel(db, ctx, execution)
        except Conflict:
            continue
    # Cases cancelled before they started settle now; running ones settle when their worker stops.
    never_started = select(Execution.id).where(
        Execution.source_id == str(run.id),
        Execution.status == ExecutionStatus.CANCELLED,
        Execution.started_at.is_(None),
    )
    await db.execute(
        update(EvalResult)
        .where(
            EvalResult.run_id == run.id,
            EvalResult.status == "pending",
            EvalResult.execution_id.is_(None) | EvalResult.execution_id.in_(never_started),
        )
        .values(
            status="cancelled",
            error={"code": "cancelled", "message": "Cancelled before it started."},
        )
    )
    run.status = "cancelling"
    await db.commit()
    await finalize_if_done(run.id, force_status="cancelled")
    await db.refresh(run)
    return run


# ---------------------------------------------------------------- grading (worker)


async def _judge(
    db: AsyncSession,
    spec: g.LlmJudgeGrader,
    case: EvalCase,
    output: str,
    workspace_id: uuid.UUID,
    execution_id: uuid.UUID | None,
) -> g.GraderResult:
    provider = (
        await db.execute(
            select(ProviderConfig).where(
                ProviderConfig.id == uuid.UUID(spec.provider_id),
                ProviderConfig.workspace_id == workspace_id,
            )
        )
    ).scalar_one_or_none()
    if provider is None:
        return g.GraderResult(
            "llm_judge",
            False,
            0.0,
            "The judge provider was removed.",
            error="judge_unavailable",
            weight=spec.weight,
        )
    case_input = (
        case.input.get("text")
        if isinstance(case.input.get("text"), str)
        else json.dumps(case.input.get("json"))
    )
    request = ChatRequest(
        model=spec.model,
        messages=[
            ChatMessage(role="system", content=g.JUDGE_SYSTEM),
            ChatMessage(
                role="user",
                content=g.judge_prompt(spec.rubric, case_input or "", output, case.expected),
            ),
        ],
        response_format="json",
        reasoning="off",
        max_output_tokens=600,
        timeout_s=90,
    )
    adapter = await adapter_for(provider, timeout_s=90)
    try:
        response = await adapter.chat(request)
    except GatewayError as exc:
        return g.GraderResult(
            "llm_judge",
            False,
            0.0,
            f"Judge call failed: {exc.message}",
            error=exc.code.value,
            weight=spec.weight,
        )
    finally:
        await adapter.aclose()
    cost = estimate(find_model(provider.kind, spec.model), response.usage, utcnow())
    db.add(
        UsageRecord(
            workspace_id=workspace_id,
            execution_id=execution_id,
            agent_id=None,
            provider_config_id=provider.id,
            provider_kind=provider.kind,
            model=spec.model,
            kind="judge",
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cached_tokens=response.usage.cached_input_tokens,
            reasoning_tokens=response.usage.reasoning_tokens,
            cost_amount=cost.amount,
            cost_currency=cost.currency,
            cost_source=cost.source.value,
            price_period=cost.price_period,
        )
    )
    try:
        score, reasoning = g.parse_judge(response.content)
    except (ValueError, KeyError, TypeError):
        return g.GraderResult(
            "llm_judge",
            False,
            0.0,
            "The judge did not return a usable score.",
            error="judge_unparseable",
            weight=spec.weight,
            cost=cost.amount,
        )
    passed = score >= spec.pass_threshold
    return g.GraderResult(
        "llm_judge",
        passed,
        score,
        reasoning or ("Pass" if passed else "Fail"),
        weight=spec.weight,
        cost=cost.amount,
        extra={"model": spec.model},
    )


async def grade_output(
    db: AsyncSession,
    specs: list[dict[str, Any]],
    case: EvalCase,
    output: str,
    output_json: Any,
    workspace_id: uuid.UUID,
    execution_id: uuid.UUID | None,
) -> list[g.GraderResult]:
    parsed = g.GRADERS_ADAPTER.validate_python(specs)
    results: list[g.GraderResult] = []
    for spec in parsed:
        if isinstance(spec, g.ExactGrader):
            results.append(g.grade_exact(spec, output, case.expected))
        elif isinstance(spec, g.ContainsGrader):
            results.append(g.grade_contains(spec, output))
        elif isinstance(spec, g.RegexGrader):
            results.append(g.grade_regex(spec, output))
        elif isinstance(spec, g.JsonSchemaGrader):
            results.append(g.grade_json_schema(spec, output, output_json))
        else:
            results.append(await _judge(db, spec, case, output, workspace_id, execution_id))
    return results


def _graders_for(case: EvalCase, suite: EvalSuite) -> list[dict[str, Any]]:
    if case.graders:
        return case.graders
    if suite.default_graders:
        return suite.default_graders
    if case.expected and "text" in case.expected:
        return [{"type": "exact", "case_sensitive": False, "trim": True, "weight": 1.0}]
    if case.expected and "json" in case.expected:
        return [
            {
                "type": "contains",
                "values": [json.dumps(case.expected["json"])],
                "mode": "all",
                "case_sensitive": True,
                "weight": 1.0,
            }
        ]
    return []


async def grade_pending(limit: int = 50) -> int:
    """Grade results whose execution finished. Returns how many results were graded."""
    graded = 0
    async with get_sessionmaker()() as db:
        rows = (
            await db.execute(
                select(EvalResult, Execution)
                .join(Execution, Execution.id == EvalResult.execution_id)
                .where(
                    EvalResult.status == "pending",
                    Execution.status.in_([s.value for s in TERMINAL]),
                )
                .limit(limit)
                .with_for_update(of=EvalResult, skip_locked=True)
            )
        ).all()
        runs_touched: set[uuid.UUID] = set()
        for result, execution in rows:
            case = await db.get(EvalCase, result.case_id) if result.case_id else None
            run = await db.get(EvalRun, result.run_id)
            suite = await db.get(EvalSuite, run.suite_id) if run else None
            result.duration_ms = execution.duration_ms
            result.cost_amount = execution.cost_amount
            result.cost_source = execution.cost_source
            output = (execution.output or {}).get("text") or ""
            result.output_text = output[:4000]
            if execution.status == ExecutionStatus.CANCELLED:
                result.status = "cancelled"
            elif (
                execution.status != ExecutionStatus.SUCCEEDED
                or case is None
                or suite is None
                or run is None
            ):
                result.status = "errored"
                result.error = execution.error or {
                    "code": "case_missing",
                    "message": "The case was deleted.",
                }
            else:
                specs = _graders_for(case, suite)
                if not specs:
                    result.status = "errored"
                    result.error = {
                        "code": "no_graders",
                        "message": "Add an expected answer or graders to this case.",
                    }
                else:
                    outcomes = await grade_output(
                        db,
                        specs,
                        case,
                        output,
                        (execution.output or {}).get("json"),
                        execution.workspace_id,
                        execution.id,
                    )
                    result.grader_results = [o.as_dict() for o in outcomes]
                    result.status, result.score = g.combine(outcomes, run.pass_threshold)
                    judge_costs = [o.cost for o in outcomes if o.cost is not None]
                    result.judge_cost_amount = sum(judge_costs, Decimal(0)) if judge_costs else None
                    if result.status == "errored":
                        result.error = {
                            "code": "grader_error",
                            "message": next(
                                (o.details for o in outcomes if o.error), "A grader failed."
                            ),
                        }
            runs_touched.add(result.run_id)
            graded += 1
        await db.commit()
    for run_id in runs_touched:
        await finalize_if_done(run_id)
    return graded


def summarise(results: list[EvalResult], executions: dict[uuid.UUID, Execution]) -> RunSummary:
    summary = RunSummary(cases=len(results))
    for result in results:
        if result.status in ("pending", "grading"):
            summary.pending += 1
        elif result.status in ("passed", "failed", "errored", "cancelled"):
            setattr(summary, result.status, getattr(summary, result.status) + 1)
    graded = summary.passed + summary.failed + summary.errored
    summary.pass_rate = round(summary.passed / graded, 4) if graded else None
    scores = [r.score for r in results if r.score is not None]
    summary.avg_score = round(statistics.fmean(scores), 4) if scores else None
    durations = sorted(r.duration_ms for r in results if r.duration_ms is not None)
    if durations:
        summary.avg_duration_ms = int(statistics.fmean(durations))
        summary.p95_duration_ms = durations[
            min(len(durations) - 1, round(0.95 * (len(durations) - 1)))
        ]
    priced = [r for r in results if r.cost_amount is not None]
    unpriced = [
        r
        for r in results
        if r.cost_amount is None and r.execution_id is not None and r.status != "pending"
    ]
    if priced:
        summary.cost_amount = sum(
            (r.cost_amount for r in priced if r.cost_amount is not None), Decimal(0)
        )
        summary.cost_source = (
            "provider_reported"
            if all(r.cost_source == "provider_reported" for r in priced)
            else "estimated"
        )
        summary.cost_partial = bool(unpriced)
        summary.cost_currency = "USD"
    judge = [r.judge_cost_amount for r in results if r.judge_cost_amount is not None]
    summary.judge_cost_amount = sum(judge, Decimal(0)) if judge else None
    for result in results:
        execution = executions.get(result.execution_id) if result.execution_id else None
        if execution is not None:
            summary.input_tokens += execution.input_tokens
            summary.output_tokens += execution.output_tokens
    return summary


async def finalize_if_done(run_id: uuid.UUID, force_status: str | None = None) -> None:
    async with get_sessionmaker()() as db:
        run = (
            await db.execute(select(EvalRun).where(EvalRun.id == run_id).with_for_update())
        ).scalar_one_or_none()
        if run is None:
            return
        results = list(
            (await db.execute(select(EvalResult).where(EvalResult.run_id == run_id))).scalars()
        )
        execution_ids = [r.execution_id for r in results if r.execution_id]
        executions = (
            {
                e.id: e
                for e in (
                    await db.execute(select(Execution).where(Execution.id.in_(execution_ids)))
                ).scalars()
            }
            if execution_ids
            else {}
        )
        summary = summarise(results, executions)
        run.summary = summary.model_dump(mode="json")
        if summary.pending == 0 and run.status in ("running", "cancelling"):
            run.status = force_status or (
                "cancelled" if run.status == "cancelling" else "completed"
            )
            run.finished_at = utcnow()
        await db.commit()


async def notify_evaluations() -> None:
    async with get_sessionmaker()() as db:
        await db.execute(text("SELECT pg_notify(:c, '')"), {"c": EVAL_CHANNEL})
        await db.commit()
