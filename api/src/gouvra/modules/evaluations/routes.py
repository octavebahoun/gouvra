"""Evaluation routes: suites, cases, runs, comparisons, grader preview."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.errors import BadRequest
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.modules.agents.models import Agent
from gouvra.modules.evaluations import graders as g
from gouvra.modules.evaluations import service
from gouvra.modules.evaluations.models import EvalCase, EvalResult, EvalRun, EvalSuite
from gouvra.modules.evaluations.schemas import (
    CaseComparison,
    CaseImportIn,
    CaseIn,
    CaseOut,
    CaseUpdateIn,
    Change,
    ComparisonOut,
    GraderPreviewIn,
    ResultOut,
    RunCreateIn,
    RunDetailOut,
    RunOut,
    RunSummary,
    RunSummaryRef,
    SuiteCreateIn,
    SuiteOut,
    SuiteUpdateIn,
)
from gouvra.modules.identity.models import User

router = APIRouter(tags=["evaluations"])


async def suite_out(db: DbSession, suite: EvalSuite) -> SuiteOut:
    agent = await db.get(Agent, suite.agent_id) if suite.agent_id else None
    last = (
        await db.execute(
            select(EvalRun)
            .where(EvalRun.suite_id == suite.id)
            .order_by(EvalRun.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return SuiteOut(
        id=suite.id,
        workspace_id=suite.workspace_id,
        name=suite.name,
        description=suite.description,
        agent_id=suite.agent_id,
        agent_name=agent.name if agent else None,
        default_graders=suite.default_graders or [],
        pass_threshold=suite.pass_threshold,
        case_count=await service.case_count(db, suite.id),
        last_run=RunSummaryRef(
            id=last.id,
            label=last.label,
            status=last.status,
            pass_rate=(last.summary or {}).get("pass_rate"),
            created_at=last.created_at,
        )
        if last
        else None,
        archived=suite.archived_at is not None,
        created_at=suite.created_at,
        updated_at=suite.updated_at,
    )


def case_out(case: EvalCase) -> CaseOut:
    return CaseOut.model_validate(case, from_attributes=True)


def result_out(result: EvalResult) -> ResultOut:
    return ResultOut.model_validate(result, from_attributes=True)


async def run_out(db: DbSession, run: EvalRun) -> RunOut:
    suite = await db.get(EvalSuite, run.suite_id)
    agent = await db.get(Agent, run.agent_id) if run.agent_id else None
    author = await db.get(User, run.created_by_id) if run.created_by_id else None
    return RunOut(
        id=run.id,
        workspace_id=run.workspace_id,
        suite_id=run.suite_id,
        suite_name=suite.name if suite else "Deleted suite",
        label=run.label,
        status="running" if run.status == "cancelling" else run.status,  # type: ignore[arg-type]
        agent_id=run.agent_id,
        agent_name=agent.name if agent else None,
        agent_version=run.agent_version_number,
        model=run.model,
        overrides=run.overrides or {},
        pass_threshold=run.pass_threshold,
        summary=RunSummary.model_validate(run.summary or {}),
        created_by=author.display_name if author else None,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
    )


async def run_detail(db: DbSession, run: EvalRun) -> RunDetailOut:
    results = list(
        (
            await db.execute(
                select(EvalResult)
                .where(EvalResult.run_id == run.id)
                .order_by(EvalResult.position, EvalResult.id)
            )
        ).scalars()
    )
    base = await run_out(db, run)
    return RunDetailOut(**base.model_dump(), results=[result_out(r) for r in results])


# ---------------------------------------------------------------- suites


@router.get("/workspaces/{workspace_id}/evaluations/suites", summary="List evaluation suites")
async def list_suites(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EVALUATIONS_READ)],
    include_archived: Annotated[bool, Query()] = False,
) -> list[SuiteOut]:
    query = (
        select(EvalSuite)
        .where(EvalSuite.workspace_id == ctx.workspace_id)
        .order_by(EvalSuite.updated_at.desc())
    )
    if not include_archived:
        query = query.where(EvalSuite.archived_at.is_(None))
    return [await suite_out(db, s) for s in (await db.execute(query)).scalars()]


@router.post(
    "/workspaces/{workspace_id}/evaluations/suites",
    status_code=status.HTTP_201_CREATED,
    summary="Create a suite",
)
async def create_suite(
    payload: SuiteCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EVALUATIONS_WRITE)],
) -> SuiteOut:
    return await suite_out(db, await service.create_suite(db, ctx, payload))


@router.get("/evaluations/suites/{suite_id}", summary="Get a suite")
async def get_suite(suite_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> SuiteOut:
    suite, _ = await load_in_workspace(db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_READ)
    return await suite_out(db, suite)


@router.patch("/evaluations/suites/{suite_id}", summary="Update a suite")
async def update_suite(
    suite_id: uuid.UUID, payload: SuiteUpdateIn, actor: CurrentActor, db: DbSession
) -> SuiteOut:
    suite, ctx = await load_in_workspace(
        db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_WRITE
    )
    return await suite_out(db, await service.update_suite(db, ctx, suite, payload))


@router.delete(
    "/evaluations/suites/{suite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Archive a suite",
)
async def archive_suite(suite_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    suite, ctx = await load_in_workspace(
        db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_WRITE
    )
    await service.archive_suite(db, ctx, suite)


# ---------------------------------------------------------------- cases


@router.get("/evaluations/suites/{suite_id}/cases", summary="List the cases of a suite")
async def list_cases(suite_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> list[CaseOut]:
    suite, _ = await load_in_workspace(db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_READ)
    rows = (
        await db.execute(
            select(EvalCase)
            .where(EvalCase.suite_id == suite.id)
            .order_by(EvalCase.position, EvalCase.created_at)
        )
    ).scalars()
    return [case_out(c) for c in rows]


@router.post(
    "/evaluations/suites/{suite_id}/cases",
    status_code=status.HTTP_201_CREATED,
    summary="Add a case",
)
async def add_case(
    suite_id: uuid.UUID, payload: CaseIn, actor: CurrentActor, db: DbSession
) -> CaseOut:
    suite, ctx = await load_in_workspace(
        db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_WRITE
    )
    (case,) = await service.add_cases(db, ctx, suite, [payload])
    return case_out(case)


@router.post(
    "/evaluations/suites/{suite_id}/cases/import",
    summary="Import cases in bulk (optionally replacing all)",
)
async def import_cases(
    suite_id: uuid.UUID, payload: CaseImportIn, actor: CurrentActor, db: DbSession
) -> list[CaseOut]:
    suite, ctx = await load_in_workspace(
        db, EvalSuite, suite_id, actor, Permission.EVALUATIONS_WRITE
    )
    return [
        case_out(c)
        for c in await service.add_cases(db, ctx, suite, payload.cases, replace=payload.replace)
    ]


@router.patch("/evaluations/cases/{case_id}", summary="Edit a case")
async def update_case(
    case_id: uuid.UUID, payload: CaseUpdateIn, actor: CurrentActor, db: DbSession
) -> CaseOut:
    case, ctx = await load_in_workspace(db, EvalCase, case_id, actor, Permission.EVALUATIONS_WRITE)
    return case_out(await service.update_case(db, ctx, case, payload))


@router.delete(
    "/evaluations/cases/{case_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a case"
)
async def delete_case(case_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    case, _ = await load_in_workspace(db, EvalCase, case_id, actor, Permission.EVALUATIONS_WRITE)
    await db.delete(case)
    await db.commit()


# ---------------------------------------------------------------- runs


@router.post(
    "/evaluations/runs",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Run a suite against an agent version (or a model variant)",
)
async def start_run(payload: RunCreateIn, actor: CurrentActor, db: DbSession) -> RunOut:
    suite, ctx = await load_in_workspace(
        db, EvalSuite, payload.suite_id, actor, Permission.EVALUATIONS_WRITE
    )
    return await run_out(db, await service.start_run(db, ctx, suite, payload))


@router.get("/workspaces/{workspace_id}/evaluations/runs", summary="List evaluation runs")
async def list_runs(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.EVALUATIONS_READ)],
    params: Annotated[PageParams, Depends(page_params)],
    suite_id: uuid.UUID | None = None,
) -> Page[RunOut]:
    query = select(EvalRun).where(EvalRun.workspace_id == ctx.workspace_id)
    if suite_id:
        query = query.where(EvalRun.suite_id == suite_id)
    rows = list(
        (await db.execute(paginate_desc(query, params, EvalRun.created_at, EvalRun.id))).scalars()
    )
    outs = {r.id: await run_out(db, r) for r in rows[: params.limit]}
    return build_page(rows, params, lambda r: outs[r.id], lambda r: (r.created_at, r.id))


@router.get("/evaluations/runs/{run_id}", summary="A run with its per-case results")
async def get_run(run_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> RunDetailOut:
    run, _ = await load_in_workspace(db, EvalRun, run_id, actor, Permission.EVALUATIONS_READ)
    return await run_detail(db, run)


@router.post("/evaluations/runs/{run_id}/cancel", summary="Cancel a running evaluation")
async def cancel_run(run_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> RunOut:
    run, ctx = await load_in_workspace(db, EvalRun, run_id, actor, Permission.EVALUATIONS_WRITE)
    return await run_out(db, await service.cancel_run(db, ctx, run))


def _change(base: ResultOut | None, candidate: ResultOut | None) -> tuple[Change, float | None]:
    if base is None:
        return "new", None
    if candidate is None:
        return "removed", None
    if "pending" in (base.status, candidate.status):
        return "pending", None
    delta = (
        (candidate.score or 0.0) - (base.score or 0.0)
        if base.score is not None or candidate.score is not None
        else None
    )
    if base.status != "passed" and candidate.status == "passed":
        return "improved", delta
    if base.status == "passed" and candidate.status != "passed":
        return "regressed", delta
    if delta is not None and abs(delta) >= 0.05:
        return ("improved" if delta > 0 else "regressed"), delta
    return "unchanged", delta


@router.get("/evaluations/compare", summary="Compare two runs case by case")
async def compare(
    actor: CurrentActor,
    db: DbSession,
    base: Annotated[uuid.UUID, Query(description="Reference run")],
    candidate: Annotated[uuid.UUID, Query(description="Run compared to the reference")],
) -> ComparisonOut:
    base_run, ctx = await load_in_workspace(db, EvalRun, base, actor, Permission.EVALUATIONS_READ)
    candidate_run, ctx2 = await load_in_workspace(
        db, EvalRun, candidate, actor, Permission.EVALUATIONS_READ
    )
    if ctx.workspace_id != ctx2.workspace_id:
        raise BadRequest("Both runs must belong to the same workspace.", code="cross_workspace")
    a, b = await run_detail(db, base_run), await run_detail(db, candidate_run)
    key = (
        (lambda r: str(r.case_id))
        if base_run.suite_id == candidate_run.suite_id
        else (lambda r: r.case_name)
    )
    left = {key(r): r for r in a.results}
    right = {key(r): r for r in b.results}
    cases: list[CaseComparison] = []
    for case_key in list(dict.fromkeys([*left, *right])):
        ra, rb = left.get(case_key), right.get(case_key)
        change, delta = _change(ra, rb)
        ref = ra or rb
        assert ref is not None  # noqa: S101 - key comes from one side
        cases.append(
            CaseComparison(
                case_id=ref.case_id,
                case_name=ref.case_name,
                base=ra,
                candidate=rb,
                change=change,
                score_delta=round(delta, 4) if delta is not None else None,
            )
        )

    def diff(x: float | int | Decimal | None, y: float | int | Decimal | None) -> float | None:
        return round(float(y) - float(x), 4) if x is not None and y is not None else None

    cost_delta = (
        (b.summary.cost_amount - a.summary.cost_amount)
        if a.summary.cost_amount is not None and b.summary.cost_amount is not None
        else None
    )
    duration_delta = diff(a.summary.avg_duration_ms, b.summary.avg_duration_ms)
    return ComparisonOut(
        base=RunOut(**a.model_dump(exclude={"results"})),
        candidate=RunOut(**b.model_dump(exclude={"results"})),
        pass_rate_delta=diff(a.summary.pass_rate, b.summary.pass_rate),
        avg_score_delta=diff(a.summary.avg_score, b.summary.avg_score),
        cost_delta=cost_delta,
        avg_duration_delta_ms=int(duration_delta) if duration_delta is not None else None,
        improved=sum(1 for c in cases if c.change == "improved"),
        regressed=sum(1 for c in cases if c.change == "regressed"),
        unchanged=sum(1 for c in cases if c.change == "unchanged"),
        cases=cases,
    )


@router.post(
    "/evaluations/graders/preview", summary="Try a deterministic grader on a sample output"
)
async def preview_grader(payload: GraderPreviewIn, actor: CurrentActor) -> dict[str, object]:
    spec = payload.grader
    expected = (
        {"text": payload.expected}
        if isinstance(payload.expected, str)
        else ({"json": payload.expected} if payload.expected else None)
    )
    if isinstance(spec, g.ExactGrader):
        result = g.grade_exact(spec, payload.output, expected)
    elif isinstance(spec, g.ContainsGrader):
        result = g.grade_contains(spec, payload.output)
    elif isinstance(spec, g.RegexGrader):
        result = g.grade_regex(spec, payload.output)
    elif isinstance(spec, g.JsonSchemaGrader):
        result = g.grade_json_schema(spec, payload.output, None)
    else:
        raise BadRequest(
            "LLM judges run only inside evaluations (they call a model).",
            code="judge_preview_unsupported",
        )
    return result.as_dict()
