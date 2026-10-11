"""Demo seed: a clearly-labelled demo account and workspace with realistic history.

Idempotent: does nothing if the demo account already exists. Real DeepSeek runs are added
only when DEEPSEEK_API_KEY is configured; everything else uses the offline scripted model.
"""

from __future__ import annotations

import os
import random
import sys
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select, update

from gouvra.core.authz import Actor, WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.security import hash_password
from gouvra.modules.agents.schemas import AgentCreateIn
from gouvra.modules.agents.service import create_agent
from gouvra.modules.executions.engine import run_execution
from gouvra.modules.executions.models import (
    Execution,
    ExecutionEvent,
    ExecutionStatus,
    Trigger,
    UsageRecord,
)
from gouvra.modules.executions.service import launch
from gouvra.modules.identity.models import User
from gouvra.modules.providers.schemas import ProviderCreateIn
from gouvra.modules.providers.service import create_provider, test_provider
from gouvra.modules.tools.schemas import ToolCreateIn
from gouvra.modules.tools.service import create_tool
from gouvra.modules.workspaces.models import Membership, Role, Workspace

DEMO_EMAIL = "demo@gouvra.dev"
DEMO_WORKSPACE = "Demo · Acme Support"
SCRIPTED_INPUTS = [
    'Ticket #4821: "The export to CSV times out on large workspaces." Classify it. [tool:text_stats {"text": "The export to CSV times out on large workspaces."}]',
    "Summarise this release in one sentence: faster traces, cost per agent, dark mode.",
    'How many days until the next billing date (2026-11-01) from 2026-10-11? [tool:date_calc {"operation": "diff", "date": "2026-10-11", "other_date": "2026-11-01"}]',
    'Monthly cost if one run costs 0.0042 USD and we run it 1830 times? [tool:calculator {"expression": "0.0042 * 1830"}]',
    "Draft a polite answer to a customer asking for an invoice copy. [json]",
    "Escalate: the provider keeps failing. [fail:provider_unavailable]",
    "Check the API quota. [fail:provider_rate_limited]",
    'What time is it in Tokyo? [tool:current_time {"timezone": "Asia/Tokyo"}]',
]
REAL_INPUTS = [
    "A customer writes: 'I was charged twice this month.' Classify the ticket (billing/bug/question) and propose a one-line reply.",
    "What is 1234 * 5678? Use the calculator.",
]


def _out(message: str) -> None:
    sys.stdout.write(message + "\n")


async def _run_now(execution_id: uuid.UUID) -> None:
    """Run in this process (the queue would also pick it up; the seed keeps control of timing)."""
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Execution)
            .where(Execution.id == execution_id, Execution.status == ExecutionStatus.QUEUED)
            .values(
                status=ExecutionStatus.RUNNING,
                started_at=utcnow(),
                worker_id="seed",
                lease_expires_at=utcnow() + timedelta(minutes=10),
                attempt=1,
            )
        )
        await db.commit()
    await run_execution(execution_id, worker_id="seed")


async def _backdate(execution_id: uuid.UUID, days_ago: float) -> None:
    delta = timedelta(days=days_ago)
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, execution_id)
        if execution is None:
            return
        for field in ("created_at", "available_at", "started_at", "finished_at"):
            value = getattr(execution, field)
            if value is not None:
                setattr(execution, field, value - delta)
        await db.execute(
            update(ExecutionEvent)
            .where(ExecutionEvent.execution_id == execution_id)
            .values(created_at=ExecutionEvent.created_at - delta)
        )
        await db.execute(
            update(UsageRecord)
            .where(UsageRecord.execution_id == execution_id)
            .values(recorded_at=UsageRecord.recorded_at - delta)
        )
        await db.commit()


async def seed_demo(*, with_real_runs: bool = True, if_missing: bool = True) -> int:
    import gouvra.models  # noqa: F401 - full schema registered

    settings = get_settings()
    password = os.environ.get("DEMO_PASSWORD") or ""
    if len(password) < 10:
        _out(
            "DEMO_PASSWORD is missing or shorter than 10 characters — run scripts/gen-secrets first."
        )
        return 1
    async with get_sessionmaker()() as db:
        existing = (
            await db.execute(select(User).where(User.email == DEMO_EMAIL))
        ).scalar_one_or_none()
        if existing is not None:
            _out(f"Demo account already present: {DEMO_EMAIL} (password: DEMO_PASSWORD from .env).")
            return 0 if if_missing else 1
        user = User(
            email=DEMO_EMAIL,
            display_name="Demo User",
            password_hash=hash_password(password),
            email_verified_at=utcnow(),
            password_changed_at=utcnow(),
            locale="en",
            is_demo=True,
        )
        db.add(user)
        await db.flush()
        workspace = Workspace(
            name=DEMO_WORKSPACE, slug="demo", owner_id=user.id, settings={}, is_demo=True
        )
        db.add(workspace)
        await db.flush()
        db.add(Membership(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
        await db.commit()
        ctx = WorkspaceContext(workspace=workspace, role=Role.OWNER, actor=Actor(user=user))

        scripted = await create_provider(
            db,
            ctx,
            ProviderCreateIn(
                name="Scripted (offline demo)", kind="test", default_model="gouvra-test-1"
            ),
        )
        await test_provider(db, ctx, scripted)
        deepseek = None
        if settings.deepseek_api_key.get_secret_value():
            deepseek = await create_provider(
                db,
                ctx,
                ProviderCreateIn(
                    name="DeepSeek",
                    kind="deepseek",
                    api_key=settings.deepseek_api_key.get_secret_value(),
                    default_model="deepseek-flash",
                ),
            )
            result = await test_provider(db, ctx, deepseek)
            if not result.ok:
                _out(
                    f"DeepSeek connection test failed ({result.error.code if result.error else 'unknown'}): real runs skipped."
                )
                deepseek = None

        tools = {}
        for key in ("calculator", "current_time", "date_calc", "json_extract", "text_stats"):
            tools[key] = await create_tool(db, ctx, ToolCreateIn(kind="builtin", builtin_key=key))
        tools["http_request"] = await create_tool(
            db,
            ctx,
            ToolCreateIn(
                kind="builtin",
                builtin_key="http_request",
                config={"allowed_hosts": ["api.github.com"], "allowed_methods": ["GET"]},
            ),
        )

        brain = deepseek or scripted
        model = "deepseek-flash" if deepseek else "gouvra-test-1"
        triage = await create_agent(
            db,
            ctx,
            AgentCreateIn(
                name="Support triage",
                description="Classifies incoming tickets and drafts a first reply.",
                instructions="You triage customer support tickets. Classify each ticket as billing, bug or question, then propose a one-line reply. Use tools for arithmetic and dates.",
                provider_id=brain.id,
                model=model,
                tool_ids=[tools["calculator"].id, tools["date_calc"].id, tools["text_stats"].id],
            ),
        )
        accountant = await create_agent(
            db,
            ctx,
            AgentCreateIn(
                name="Cost estimator",
                description="Answers questions about usage and spend with exact arithmetic.",
                instructions="Always use the calculator for arithmetic. Answer with the number and its unit.",
                provider_id=brain.id,
                model=model,
                tool_ids=[tools["calculator"].id],
                parameters={"reasoning": "off"},  # type: ignore[arg-type]
            ),
        )
        offline = await create_agent(
            db,
            ctx,
            AgentCreateIn(
                name="Offline demo agent",
                description="Runs on the deterministic scripted model — no network, no cost.",
                instructions="Demo agent driven by scripted directives.",
                provider_id=scripted.id,
                model="gouvra-test-1",
                tool_ids=[t.id for k, t in tools.items() if k != "http_request"],
                limits={"max_steps": 4, "max_tool_calls": 4, "timeout_s": 60},  # type: ignore[arg-type]
            ),
        )
        await create_agent(
            db,
            ctx,
            AgentCreateIn(
                name="Release notes writer",
                description="Draft — waiting for its instructions.",
                provider_id=None,
            ),
        )

        rng = random.Random(42)  # noqa: S311 - deterministic demo data, not security
        created: list[tuple[uuid.UUID, float]] = []
        for index in range(36):
            text = SCRIPTED_INPUTS[index % len(SCRIPTED_INPUTS)]
            execution, _ = await launch(
                db,
                ctx,
                offline,
                text,
                trigger=Trigger.MANUAL if index % 3 else Trigger.API,
                metadata={"demo": "true"},
            )
            created.append((execution.id, rng.uniform(0.05, 13.5)))
        for execution_id, days in created:
            await _run_now(execution_id)
            await _backdate(execution_id, days)

        if with_real_runs and deepseek is not None:
            for agent, text in ((triage, REAL_INPUTS[0]), (accountant, REAL_INPUTS[1])):
                execution, _ = await launch(
                    db, ctx, agent, text, trigger=Trigger.MANUAL, metadata={"demo": "true"}
                )
                await _run_now(execution.id)
            _out("Two real DeepSeek executions recorded.")

        # A queued run left for the UI's live views (the worker will pick it up).
        await launch(
            db,
            ctx,
            offline,
            "Welcome to Gouvra! [think] Follow me live.",
            trigger=Trigger.MANUAL,
            metadata={"demo": "true"},
        )
    _out(
        f"Demo ready → {settings.app_url}/login  ·  {DEMO_EMAIL}  ·  password: DEMO_PASSWORD from .env"
    )
    return 0


def describe() -> dict[str, Any]:
    return {"email": DEMO_EMAIL, "workspace": DEMO_WORKSPACE}
