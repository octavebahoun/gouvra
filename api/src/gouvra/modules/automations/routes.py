"""Automation routes: schedules and webhooks, their deliveries, and the public inbound endpoint."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select

from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.context import current_client_ip
from gouvra.core.db import utcnow
from gouvra.core.errors import AppError
from gouvra.core.pagination import Page, PageParams, build_page, page_params, paginate_desc
from gouvra.modules.automations import service
from gouvra.modules.automations.models import Automation, AutomationFire, AutomationKind
from gouvra.modules.automations.schemas import (
    AutomationCreatedOut,
    AutomationCreateIn,
    AutomationOut,
    AutomationUpdateIn,
    CronPreviewIn,
    CronPreviewOut,
    FireOut,
    HookAcceptedOut,
    SecretOut,
    TestFireIn,
)
from gouvra.modules.executions.models import Execution
from gouvra.modules.identity.models import User
from gouvra.modules.workflows.models import WorkflowRun

router = APIRouter(tags=["automations"])
hooks_router = APIRouter(tags=["webhooks"])


async def automation_out(db: DbSession, automation: Automation) -> AutomationOut:
    target, problem = await service.target_of(db, automation)
    author = await db.get(User, automation.created_by_id) if automation.created_by_id else None
    upcoming = (
        service.upcoming(automation.cron, automation.timezone, utcnow())
        if automation.kind == AutomationKind.SCHEDULE
        and automation.enabled
        and automation.cron
        and automation.timezone
        else []
    )
    return AutomationOut(
        id=automation.id,
        workspace_id=automation.workspace_id,
        name=automation.name,
        description=automation.description,
        kind=automation.kind,  # type: ignore[arg-type]
        target_type=automation.target_type,  # type: ignore[arg-type]
        agent_id=automation.agent_id,
        workflow_id=automation.workflow_id,
        target_name=target.name if target is not None else None,
        target_problem=problem,
        input=automation.input,
        input_template=automation.input_template,
        enabled=automation.enabled,
        paused_reason=automation.paused_reason,
        cron=automation.cron,
        timezone=automation.timezone,
        next_run_at=automation.next_run_at,
        upcoming=upcoming,
        overlap=automation.overlap,  # type: ignore[arg-type]
        hook_url=service.hook_url(automation),
        signature_format=automation.signature_format,  # type: ignore[arg-type]
        secret_hint=automation.secret_hint,
        last_fired_at=automation.last_fired_at,
        last_status=automation.last_status,  # type: ignore[arg-type]
        fire_count=automation.fire_count,
        consecutive_failures=automation.consecutive_failures,
        created_by=author.display_name if author else None,
        created_at=automation.created_at,
        updated_at=automation.updated_at,
    )


async def fire_out(db: DbSession, fire: AutomationFire) -> FireOut:
    run_status: str | None = None
    if fire.execution_id:
        execution = await db.get(Execution, fire.execution_id)
        run_status = execution.status if execution else None
    elif fire.workflow_run_id:
        run = await db.get(WorkflowRun, fire.workflow_run_id)
        run_status = run.status if run else None
    return FireOut(
        id=fire.id,
        source=fire.source,  # type: ignore[arg-type]
        status=fire.status,  # type: ignore[arg-type]
        reason=fire.reason,
        scheduled_for=fire.scheduled_for,
        delivery_id=fire.delivery_id,
        execution_id=fire.execution_id,
        workflow_run_id=fire.workflow_run_id,
        run_status=run_status,
        payload_preview=fire.payload_preview,
        request_meta=fire.request_meta,
        created_at=fire.created_at,
    )


@router.get("/workspaces/{workspace_id}/automations", summary="List automations")
async def list_automations(
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AUTOMATIONS_READ)],
) -> list[AutomationOut]:
    rows = (
        await db.execute(
            select(Automation)
            .where(Automation.workspace_id == ctx.workspace_id)
            .order_by(Automation.created_at.desc())
        )
    ).scalars()
    return [await automation_out(db, automation) for automation in rows]


@router.post(
    "/workspaces/{workspace_id}/automations",
    status_code=status.HTTP_201_CREATED,
    summary="Create a schedule or a webhook (a webhook's secret is shown once)",
)
async def create_automation(
    payload: AutomationCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.AUTOMATIONS_MANAGE)],
) -> AutomationCreatedOut:
    automation, secret = await service.create(db, ctx, payload)
    out = await automation_out(db, automation)
    return AutomationCreatedOut(**out.model_dump(), secret=secret)


@router.post("/automations/cron-preview", summary="Check a cron expression and list its next runs")
async def cron_preview(payload: CronPreviewIn, _: CurrentActor) -> CronPreviewOut:
    try:
        expression = service.check_cron(payload.cron)
        return CronPreviewOut(
            valid=True,
            message=None,
            upcoming=service.upcoming(expression, payload.timezone, utcnow()),
        )
    except AppError as exc:
        detail = exc.errors[0]["message"] if exc.errors else exc.message
        return CronPreviewOut(valid=False, message=detail, upcoming=[])


@router.get("/automations/{automation_id}", summary="Get an automation")
async def get_automation(
    automation_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> AutomationOut:
    automation, _ = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_READ
    )
    return await automation_out(db, automation)


@router.patch("/automations/{automation_id}", summary="Edit, pause or resume an automation")
async def update_automation(
    automation_id: uuid.UUID, payload: AutomationUpdateIn, actor: CurrentActor, db: DbSession
) -> AutomationOut:
    automation, ctx = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_MANAGE, for_update=True
    )
    return await automation_out(db, await service.update_automation(db, ctx, automation, payload))


@router.delete(
    "/automations/{automation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an automation (the runs it started stay in the history)",
)
async def delete_automation(automation_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    automation, ctx = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_MANAGE
    )
    await service.delete_automation(db, ctx, automation)


@router.post(
    "/automations/{automation_id}/rotate-secret",
    summary="Replace a webhook's signing secret (shown once; the old one stops working)",
)
async def rotate_secret(automation_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> SecretOut:
    automation, ctx = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_MANAGE, for_update=True
    )
    secret = await service.rotate_secret(db, ctx, automation)
    return SecretOut(secret=secret, secret_hint=automation.secret_hint or "")


@router.post(
    "/automations/{automation_id}/run",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Run now: a schedule with its input, a webhook with a sample payload",
)
async def run_automation(
    automation_id: uuid.UUID, payload: TestFireIn, actor: CurrentActor, db: DbSession
) -> FireOut:
    automation, ctx = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_MANAGE, for_update=True
    )
    return await fire_out(db, await service.run_now(db, ctx, automation, payload.input))


@router.get("/automations/{automation_id}/fires", summary="Deliveries and scheduled runs")
async def list_fires(
    automation_id: uuid.UUID,
    actor: CurrentActor,
    db: DbSession,
    params: Annotated[PageParams, Depends(page_params)],
) -> Page[FireOut]:
    automation, _ = await load_in_workspace(
        db, Automation, automation_id, actor, Permission.AUTOMATIONS_READ
    )
    query = select(AutomationFire).where(AutomationFire.automation_id == automation.id)
    rows = list(
        (
            await db.execute(
                paginate_desc(query, params, AutomationFire.created_at, AutomationFire.id)
            )
        ).scalars()
    )
    outs = {row.id: await fire_out(db, row) for row in rows[: params.limit]}
    return build_page(rows, params, lambda r: outs[r.id], lambda r: (r.created_at, r.id))


@hooks_router.post(
    "/hooks/{token}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Inbound webhook: signed deliveries start the automation's agent or workflow",
    responses={
        200: {"description": "Duplicate delivery: the outcome of the first one"},
        401: {"description": "Missing, stale or invalid signature"},
        404: {"description": "No webhook at this address"},
        409: {"description": "The automation is paused"},
        413: {"description": "Payload too large"},
        429: {"description": "Too many deliveries"},
    },
)
async def receive_hook(
    token: str, request: Request, response: Response, db: DbSession
) -> HookAcceptedOut:
    body = await request.body()
    headers = {key.lower(): value for key, value in request.headers.items()}
    fire, duplicate = await service.receive(db, token, body, headers, current_client_ip())
    if duplicate:
        response.status_code = status.HTTP_200_OK
    return HookAcceptedOut(
        delivery_id=fire.delivery_id or "",
        fire_id=fire.id,
        status=fire.status,  # type: ignore[arg-type]
        duplicate=duplicate,
        execution_id=fire.execution_id,
        workflow_run_id=fire.workflow_run_id,
    )
