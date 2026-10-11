"""First-configuration checklist. Feature modules register their own steps."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.modules.workspaces.models import Invitation, Membership

StepCheck = Callable[[AsyncSession, uuid.UUID], Awaitable[bool]]


@dataclass(frozen=True)
class StepDef:
    key: str
    order: int
    check: StepCheck
    optional: bool = False


_STEPS: dict[str, StepDef] = {}


def register_step(key: str, order: int, check: StepCheck, *, optional: bool = False) -> None:
    _STEPS[key] = StepDef(key, order, check, optional)


async def _always(_: AsyncSession, __: uuid.UUID) -> bool:
    return True


async def _invited_someone(db: AsyncSession, workspace_id: uuid.UUID) -> bool:
    members = (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.workspace_id == workspace_id)
        )
    ).scalar_one()
    invites = (
        await db.execute(
            select(func.count())
            .select_from(Invitation)
            .where(Invitation.workspace_id == workspace_id)
        )
    ).scalar_one()
    return members > 1 or invites > 0


register_step("create_workspace", 0, _always)
register_step("invite_teammate", 90, _invited_someone, optional=True)


async def evaluate(db: AsyncSession, workspace_id: uuid.UUID) -> list[tuple[StepDef, bool]]:
    return [
        (step, await step.check(db, workspace_id))
        for step in sorted(_STEPS.values(), key=lambda s: s.order)
    ]


async def _has_provider(db: AsyncSession, workspace_id: uuid.UUID) -> bool:
    from gouvra.modules.providers.models import ProviderConfig

    return bool(
        (
            await db.execute(
                select(func.count())
                .select_from(ProviderConfig)
                .where(
                    ProviderConfig.workspace_id == workspace_id,
                    ProviderConfig.archived_at.is_(None),
                )
            )
        ).scalar_one()
    )


async def _has_agent(db: AsyncSession, workspace_id: uuid.UUID) -> bool:
    from gouvra.modules.agents.models import Agent

    return bool(
        (
            await db.execute(
                select(func.count()).select_from(Agent).where(Agent.workspace_id == workspace_id)
            )
        ).scalar_one()
    )


async def _has_execution(db: AsyncSession, workspace_id: uuid.UUID) -> bool:
    from gouvra.modules.executions.models import Execution

    return bool(
        (
            await db.execute(
                select(func.count())
                .select_from(Execution)
                .where(Execution.workspace_id == workspace_id, Execution.status == "succeeded")
            )
        ).scalar_one()
    )


register_step("configure_provider", 10, _has_provider)
register_step("create_agent", 20, _has_agent)
register_step("run_execution", 30, _has_execution)
