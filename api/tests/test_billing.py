"""SaaS: plans and quotas, subscriptions (simulated and Stripe), budgets and alerts.

Phase 9 exit criterion (server side): the subscription journey, with Stripe in test mode.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import select, update

from gouvra.core.config import BillingProviderKind, get_settings
from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.billing import service as billing
from gouvra.modules.billing import stripe_gateway as gateway
from gouvra.modules.billing.models import Subscription
from gouvra.modules.billing.plans import BUSINESS, FREE, PLANS, SELF_HOSTED, TEAM, Plan
from gouvra.modules.budgets import service as budgets
from gouvra.modules.budgets.models import Alert
from gouvra.modules.executions.models import UsageRecord
from gouvra.modules.notifications.models import EmailOutbox
from tests.helpers import Account, Outbox, add_member, create_agent, launch, signup

pytestmark = pytest.mark.usefixtures("outbox")

WEBHOOK_SECRET = "whsec_test_" + "x" * 32


@pytest.fixture
def simulated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "billing_provider", BillingProviderKind.SIMULATED)


@pytest.fixture
def stripe_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "billing_provider", BillingProviderKind.STRIPE)
    monkeypatch.setattr(settings, "stripe_webhook_secret", SecretStr(WEBHOOK_SECRET))
    if not settings.stripe_secret_key.get_secret_value():
        monkeypatch.setattr(settings, "stripe_secret_key", SecretStr("sk_test_placeholder"))


def test_plans() -> None:
    assert [p.key for p in PLANS.values()] == ["free", "team", "business"]
    assert FREE.allows("agents", 4)
    assert not FREE.allows("agents", 5)
    assert BUSINESS.allows("members", 10_000)  # unlimited
    assert TEAM.price_monthly == Decimal(49)
    assert TEAM.lookup_key == "gouvra_team_monthly"


def test_effective_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "billing_provider", BillingProviderKind.NONE)
    assert billing.effective_plan(None) is SELF_HOSTED
    monkeypatch.setattr(settings, "billing_provider", BillingProviderKind.STRIPE)
    assert billing.effective_plan(None) is FREE
    team = Subscription(plan="team", status="active", provider="stripe")
    assert billing.effective_plan(team) is TEAM
    team.status = "past_due"  # grace period while Stripe retries the payment
    assert billing.effective_plan(team) is TEAM
    team.status = "canceled"
    assert billing.effective_plan(team) is FREE


async def _billing(owner: Account, ws_id: str) -> dict[str, Any]:
    response = await owner.client.get(f"/api/v1/workspaces/{ws_id}/billing")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_self_hosted_instances_have_no_limit(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    state = await _billing(owner, ws["id"])
    assert (state["enabled"], state["provider"], state["plan"]["key"]) == (
        False,
        "none",
        "self_hosted",
    )
    refused = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "team"}
    )
    assert (refused.status_code, refused.json()["code"]) == (409, "billing_disabled")
    for i in range(6):
        await create_agent(owner, ws["id"], lab["provider"]["id"], name=f"Agent {i}")
    public = (await owner.client.get("/api/v1/billing/plans")).json()
    assert public["enabled"] is False
    assert [p["key"] for p in public["plans"]] == ["free", "team", "business"]


@pytest.mark.usefixtures("simulated")
async def test_simulated_subscription_journey(lab: dict[str, Any]) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    state = await _billing(owner, ws["id"])
    assert (state["plan"]["key"], state["usage"]["agents"], state["test_mode"]) == ("free", 1, True)

    # Free allows 5 agents: the sixth is refused with a clear reason.
    for i in range(4):
        await create_agent(owner, ws["id"], lab["provider"]["id"], name=f"Agent {i}")
    refused = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/agents",
        json={
            "name": "One too many",
            "provider_id": lab["provider"]["id"],
            "model": "gouvra-test-1",
        },
    )
    assert (refused.status_code, refused.json()["code"]) == (402, "plan_limit")
    assert "Free plan includes up to 5 agents" in refused.json()["detail"]

    checkout = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "team"}
    )
    assert checkout.status_code == 200, checkout.text
    url = checkout.json()["url"]
    assert "/settings/billing/checkout?plan=team&token=" in url
    token = url.split("token=", 1)[1]
    forged = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/simulated/confirm",
        json={"plan": "business", "token": token},
    )
    assert forged.status_code == 422  # the token is bound to the offered plan
    confirmed = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/simulated/confirm",
        json={"plan": "team", "token": token},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert (confirmed.json()["plan"]["key"], confirmed.json()["subscription"]["status"]) == (
        "team",
        "active",
    )
    await create_agent(owner, ws["id"], lab["provider"]["id"], name="Now allowed")
    again = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "team"}
    )
    assert again.json()["code"] == "already_subscribed"

    cancelled = await owner.client.post(f"/api/v1/workspaces/{ws['id']}/billing/simulated/cancel")
    assert cancelled.json()["subscription"]["cancel_at_period_end"] is True
    assert cancelled.json()["plan"]["key"] == "team"  # until the end of the period
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Subscription)
            .where(Subscription.workspace_id == ws["id"])
            .values(current_period_end=utcnow() - timedelta(minutes=1))
        )
        await db.commit()
        assert await billing.expire_simulated(db) == 1
    assert (await _billing(owner, ws["id"]))["plan"]["key"] == "free"
    audit = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/audit-events")).json()
    assert {"billing.subscribed", "billing.cancel_requested"} <= {
        e["action"] for e in audit["data"]
    }


@pytest.mark.usefixtures("simulated")
async def test_monthly_run_quota_and_its_alerts(
    lab: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    tiny = Plan(**{**FREE.__dict__, "executions_per_month": 2})
    monkeypatch.setattr(billing, "effective_plan", lambda subscription: tiny)
    await launch(owner, agent["id"], "one")
    async with get_sessionmaker()() as db:
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 0  # 50% is not a threshold
    await launch(owner, agent["id"], "two")
    refused = await owner.client.post(
        f"/api/v1/agents/{agent['id']}/executions", json={"input": "three"}
    )
    assert (refused.status_code, refused.json()["code"]) == (402, "plan_limit")
    async with get_sessionmaker()() as db:
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 2  # 80% and 100%
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 0  # once each
        emails = (
            await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == owner.email))
        ).scalars()
        subjects = [e.subject for e in emails]
    assert any("100% of its monthly runs" in subject for subject in subjects)
    alerts = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/alerts")).json()
    assert [(a["kind"], a["data"]["percent"]) for a in alerts] == [("quota", 100), ("quota", 80)]
    dismissed = await owner.client.post(f"/api/v1/alerts/{alerts[0]['id']}/dismiss")
    assert dismissed.json()["dismissed_at"] is not None


async def _spend(workspace_id: str, amount: str) -> None:
    async with get_sessionmaker()() as db:
        db.add(
            UsageRecord(
                workspace_id=workspace_id,
                provider_kind="test",
                model="gouvra-test-1",
                cost_amount=Decimal(amount),
                cost_currency="USD",
                cost_source="estimated",
            )
        )
        await db.commit()


async def test_budgets_alert_once_and_can_stop_runs(
    lab: dict[str, Any], make_client: Any, outbox: Outbox
) -> None:
    owner: Account = lab["owner"]
    ws, agent = lab["ws"], lab["agent"]
    url = f"/api/v1/workspaces/{ws['id']}/budget"
    empty = (await owner.client.get(url)).json()
    assert (empty["budget"], Decimal(empty["spent"])) == (None, Decimal(0))
    bad = await owner.client.put(url, json={"monthly_limit": "0", "thresholds": [50]})
    assert bad.status_code == 422
    saved = await owner.client.put(
        url, json={"monthly_limit": "10.00", "thresholds": [100, 50, 50], "hard_stop": True}
    )
    assert saved.json()["budget"]["thresholds"] == [50, 100]

    await _spend(ws["id"], "6.00")
    async with get_sessionmaker()() as db:
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 1
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 0
    await _spend(ws["id"], "4.50")
    async with get_sessionmaker()() as db:
        assert await budgets.evaluate(db, uuid.UUID(ws["id"])) == 1
        alerts = list(
            (await db.execute(select(Alert).where(Alert.workspace_id == ws["id"]))).scalars()
        )
    assert sorted(a.data["percent"] for a in alerts) == [50, 100]
    assert {a.level for a in alerts} == {"warning", "danger"}
    stopped = await owner.client.post(
        f"/api/v1/agents/{agent['id']}/executions", json={"input": "x"}
    )
    assert (stopped.status_code, stopped.json()["code"]) == (402, "budget_reached")
    state = (await owner.client.get(url)).json()
    assert Decimal(state["spent"]) == Decimal("10.50")

    member = await signup(make_client(), outbox, "spender@example.com")
    await add_member(owner, ws["id"], member, outbox, "member")
    assert (await member.client.get(url)).status_code == 200
    assert (await member.client.put(url, json={"monthly_limit": "999"})).status_code == 403

    removed = await owner.client.put(url, json={"monthly_limit": None})
    assert removed.json()["budget"] is None
    assert (
        await owner.client.post(f"/api/v1/agents/{agent['id']}/executions", json={"input": "x"})
    ).status_code == 202


# ---------------------------------------------------------------- Stripe


def _signed(payload: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
    body = json.dumps(payload).encode()
    timestamp = int(time.time())
    digest = hmac.new(
        WEBHOOK_SECRET.encode(), f"{timestamp}.".encode() + body, hashlib.sha256
    ).hexdigest()
    return body, {
        "Stripe-Signature": f"t={timestamp},v1={digest}",
        "Content-Type": "application/json",
    }


def _subscription(
    workspace_id: str, *, status: str = "active", lookup_key: str = "gouvra_team_monthly"
) -> dict[str, Any]:
    return {
        "id": "sub_test_1",
        "object": "subscription",
        "customer": "cus_test_1",
        "status": status,
        "cancel_at_period_end": False,
        "metadata": {"workspace_id": workspace_id},
        "items": {
            "object": "list",
            "data": [
                {
                    "id": "si_1",
                    "object": "subscription_item",
                    "current_period_end": int(time.time()) + 30 * 86400,
                    "price": {"id": "price_1", "object": "price", "lookup_key": lookup_key},
                }
            ],
        },
    }


def _event(event_id: str, kind: str, obj: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": event_id,
        "object": "event",
        "type": kind,
        "livemode": False,
        "data": {"object": obj},
    }


@pytest.mark.usefixtures("stripe_mode")
async def test_stripe_events_drive_the_subscription(
    lab: dict[str, Any], make_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner: Account = lab["owner"]
    ws = lab["ws"]
    stripe_sender = make_client(csrf=False)
    hook = "/api/v1/billing/stripe/webhook"

    async def fake_customer(customer_id: str | None, **_: Any) -> str:
        return customer_id or "cus_test_1"

    async def fake_checkout(**kwargs: Any) -> str:
        assert kwargs["success_url"].endswith("/settings/billing?checkout=success")
        assert kwargs["plan"] is TEAM
        return "https://checkout.stripe.com/c/pay/cs_test_123"

    monkeypatch.setattr(gateway, "ensure_customer", fake_customer)
    monkeypatch.setattr(gateway, "checkout_url", fake_checkout)
    checkout = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "team"}
    )
    assert checkout.json()["url"].startswith("https://checkout.stripe.com/")

    # The browser coming back changes nothing: only verified events do.
    assert (await _billing(owner, ws["id"]))["plan"]["key"] == "free"
    unsigned = await stripe_sender.post(
        hook, content=b"{}", headers={"Content-Type": "application/json"}
    )
    assert unsigned.status_code == 400
    forged_body, forged_headers = _signed(
        _event("evt_forged", "customer.subscription.updated", _subscription(ws["id"]))
    )
    forged_headers["Stripe-Signature"] = forged_headers["Stripe-Signature"].replace("v1=", "v1=0")
    assert (
        await stripe_sender.post(hook, content=forged_body, headers=forged_headers)
    ).status_code == 400

    async def fake_subscription(subscription_id: str) -> Any:
        return _subscription(ws["id"])

    monkeypatch.setattr(gateway, "subscription", fake_subscription)
    completed = _event(
        "evt_1",
        "checkout.session.completed",
        {
            "id": "cs_test_123",
            "object": "checkout.session",
            "customer": "cus_test_1",
            "subscription": "sub_test_1",
            "client_reference_id": ws["id"],
            "metadata": {"workspace_id": ws["id"]},
        },
    )
    body, headers = _signed(completed)
    applied = await stripe_sender.post(hook, content=body, headers=headers)
    assert applied.json()["outcome"] == "subscribed", applied.text
    replay = await stripe_sender.post(hook, content=body, headers=headers)
    assert replay.json()["outcome"] == "duplicate"
    state = await _billing(owner, ws["id"])
    assert (
        state["plan"]["key"],
        state["subscription"]["status"],
        state["subscription"]["provider"],
    ) == ("team", "active", "stripe")
    assert state["subscription"]["current_period_end"] is not None
    portal_refused = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "business"}
    )
    assert portal_refused.json()["code"] == "use_portal"

    async def fake_portal(**kwargs: Any) -> str:
        assert kwargs["customer_id"] == "cus_test_1"
        return "https://billing.stripe.com/p/session/test_123"

    monkeypatch.setattr(gateway, "portal_url", fake_portal)
    portal = await owner.client.post(f"/api/v1/workspaces/{ws['id']}/billing/portal")
    assert portal.json()["url"].startswith("https://billing.stripe.com/")

    # Upgrade from the portal, a failed payment, then the end of the subscription.
    for event in (
        _event(
            "evt_2",
            "customer.subscription.updated",
            _subscription(ws["id"], lookup_key="gouvra_business_monthly"),
        ),
        _event(
            "evt_3",
            "invoice.payment_failed",
            {"id": "in_1", "object": "invoice", "customer": "cus_test_1"},
        ),
    ):
        body, headers = _signed(event)
        assert (await stripe_sender.post(hook, content=body, headers=headers)).status_code == 200
    state = await _billing(owner, ws["id"])
    assert (state["plan"]["key"], state["subscription"]["status"]) == ("business", "past_due")
    alerts = (await owner.client.get(f"/api/v1/workspaces/{ws['id']}/alerts")).json()
    assert alerts[0]["kind"] == "payment_failed"
    body, headers = _signed(
        _event("evt_4", "customer.subscription.deleted", _subscription(ws["id"], status="canceled"))
    )
    assert (await stripe_sender.post(hook, content=body, headers=headers)).json()[
        "outcome"
    ] == "synced"
    assert (await _billing(owner, ws["id"]))["plan"]["key"] == "free"


@pytest.mark.real
async def test_real_stripe_test_mode_checkout(
    lab: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Against Stripe's test API: prices exist (created on first use) and checkout opens."""
    key = get_settings().stripe_secret_key.get_secret_value()
    if not key.startswith("sk_test_"):
        pytest.skip("Stripe test keys not configured")
    monkeypatch.setattr(get_settings(), "billing_provider", BillingProviderKind.STRIPE)
    owner: Account = lab["owner"]
    ws = lab["ws"]
    gateway._prices.clear()
    price_id = await gateway.ensure_price(TEAM)
    assert price_id.startswith("price_")
    assert await gateway.ensure_price(TEAM) == price_id
    checkout = await owner.client.post(
        f"/api/v1/workspaces/{ws['id']}/billing/checkout", json={"plan": "team"}
    )
    assert checkout.status_code == 200, checkout.text
    assert checkout.json()["url"].startswith("https://checkout.stripe.com/")
    async with get_sessionmaker()() as db:
        row = (
            await db.execute(select(Subscription).where(Subscription.workspace_id == ws["id"]))
        ).scalar_one()
        assert row.customer_id
        assert row.customer_id.startswith("cus_")
