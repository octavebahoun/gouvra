"""The demo seed builds a coherent, clearly-labelled demo workspace (offline mode)."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from gouvra.core.db import get_sessionmaker
from gouvra.modules.agents.models import Agent
from gouvra.modules.executions.models import Execution
from gouvra.modules.identity.models import User
from gouvra.modules.workspaces.models import Workspace
from gouvra.seed import DEMO_EMAIL, seed_demo
from gouvra.seed_extras import CASES
from tests.helpers import Outbox

pytestmark = pytest.mark.usefixtures("outbox")


async def test_demo_seed_is_idempotent_and_labelled(
    monkeypatch: pytest.MonkeyPatch, make_client, outbox: Outbox
) -> None:  # type: ignore[no-untyped-def]
    from gouvra.core.config import get_settings

    monkeypatch.setattr(
        get_settings(), "deepseek_api_key", type(get_settings().deepseek_api_key)("")
    )
    monkeypatch.setenv("DEMO_PASSWORD", "demo-password-for-tests")
    assert await seed_demo(with_real_runs=False) == 0
    async with get_sessionmaker()() as db:
        user = (await db.execute(select(User).where(User.email == DEMO_EMAIL))).scalar_one()
        assert user.is_demo
        workspace = (
            await db.execute(select(Workspace).where(Workspace.slug == "demo"))
        ).scalar_one()
        assert workspace.is_demo
        assert (
            await db.execute(
                select(func.count()).select_from(Agent).where(Agent.workspace_id == workspace.id)
            )
        ).scalar_one() == 4
        statuses = dict(
            (
                await db.execute(
                    select(Execution.status, func.count())
                    .where(Execution.workspace_id == workspace.id)
                    .group_by(Execution.status)
                )
            ).all()
        )
    assert statuses["succeeded"] > 0
    assert statuses["failed"] > 0
    # The live run, and the cases of two evaluation runs, wait for the worker.
    assert statuses["queued"] == 1 + 2 * len(CASES)
    assert await seed_demo(with_real_runs=False) == 0  # second run: nothing to do
    client = make_client()
    login = await client.post(
        "/api/v1/auth/login", json={"email": DEMO_EMAIL, "password": "demo-password-for-tests"}
    )
    assert login.status_code == 200
    assert login.json()["workspaces"][0]["is_demo"] is True
    # Every part of the product has something to show.
    base = f"/api/v1/workspaces/{workspace.id}"
    suites = (await client.get(f"{base}/evaluations/suites")).json()
    assert [s["name"] for s in suites] == ["Ticket replies"]
    flows = (await client.get(f"{base}/workflows")).json()
    assert [(w["name"], w["current_version"]) for w in flows] == [("Ticket routing", 1)]
    automations = (await client.get(f"{base}/automations")).json()
    assert sorted(a["kind"] for a in automations) == ["schedule", "webhook"]
    budget = (await client.get(f"{base}/budget")).json()
    assert budget["budget"]["monthly_limit"] == "25.00"


async def test_seed_requires_a_password(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEMO_PASSWORD", raising=False)
    assert await seed_demo(with_real_runs=False) == 1
