"""Stripe, through the official SDK (asynchronous client, test or live keys).

Prices are found by lookup key and created on first use, so a fresh Stripe account works
without manual setup; the customer portal configuration is created the same way.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import stripe

from gouvra.core.config import get_settings
from gouvra.core.logging import get_logger
from gouvra.modules.billing.plans import PAID, Plan

log = get_logger(__name__)

_prices: dict[str, str] = {}


@asynccontextmanager
async def _api() -> AsyncIterator[stripe.StripeClient]:
    """A client for one operation; its connections are closed afterwards."""
    http = stripe.HTTPXClient(allow_sync_methods=False, timeout=30)
    try:
        yield stripe.StripeClient(
            get_settings().stripe_secret_key.get_secret_value(), http_client=http
        )
    finally:
        await http.close_async()  # type: ignore[no-untyped-call]


async def ensure_price(plan: Plan) -> str:
    """The monthly price of a paid plan (created with its product the first time)."""
    if plan.lookup_key is None:
        raise ValueError(f"plan {plan.key} has no price")
    if plan.lookup_key in _prices:
        return _prices[plan.lookup_key]
    async with _api() as api:
        found = await api.v1.prices.list_async(
            params={"lookup_keys": [plan.lookup_key], "active": True}
        )
        if found.data:
            price_id = str(found.data[0].id)
        else:
            product = await api.v1.products.create_async(
                params={"name": f"Gouvra {plan.name}", "metadata": {"gouvra_plan": plan.key}}
            )
            price = await api.v1.prices.create_async(
                params={
                    "product": product.id,
                    "currency": "usd",
                    "unit_amount": int(plan.price_monthly * 100),
                    "recurring": {"interval": "month"},
                    "lookup_key": plan.lookup_key,
                    "transfer_lookup_key": True,
                    "metadata": {"gouvra_plan": plan.key},
                }
            )
            price_id = str(price.id)
            log.info("stripe_price_created", plan=plan.key)
    _prices[plan.lookup_key] = price_id
    return price_id


async def ensure_customer(
    customer_id: str | None, *, email: str, name: str, workspace_id: str
) -> str:
    if customer_id:
        return customer_id
    async with _api() as api:
        customer = await api.v1.customers.create_async(
            params={"email": email, "name": name, "metadata": {"workspace_id": workspace_id}}
        )
    return str(customer.id)


async def checkout_url(
    *, customer_id: str, plan: Plan, workspace_id: str, success_url: str, cancel_url: str
) -> str:
    price = await ensure_price(plan)
    async with _api() as api:
        session = await api.v1.checkout.sessions.create_async(
            params={
                "mode": "subscription",
                "customer": customer_id,
                "client_reference_id": workspace_id,
                "line_items": [{"price": price, "quantity": 1}],
                "subscription_data": {"metadata": {"workspace_id": workspace_id}},
                "metadata": {"workspace_id": workspace_id, "plan": plan.key},
                "success_url": success_url,
                "cancel_url": cancel_url,
            }
        )
    if not session.url:
        raise RuntimeError("Stripe returned a checkout session without a URL")
    return str(session.url)


async def _portal_configuration() -> str | None:
    """Test accounts start without a portal configuration: create a sensible one if needed."""
    async with _api() as api:
        existing = await api.v1.billing_portal.configurations.list_async(
            params={"is_default": True}
        )
        if existing.data:
            return None
        return await _create_portal_configuration(api)


async def _create_portal_configuration(api: stripe.StripeClient) -> str:
    products = []
    for plan in PAID:
        price_id = await ensure_price(plan)
        price = await api.v1.prices.retrieve_async(price_id)
        product = price.product if isinstance(price.product, str) else price.product.id
        products.append({"product": product, "prices": [price_id]})
    params: Any = {
        "business_profile": {"headline": "Gouvra — manage your subscription"},
        "features": {
            "invoice_history": {"enabled": True},
            "payment_method_update": {"enabled": True},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
            "subscription_update": {
                "enabled": True,
                "default_allowed_updates": ["price"],
                "products": products,
                "proration_behavior": "create_prorations",
            },
        },
    }
    configuration = await api.v1.billing_portal.configurations.create_async(params=params)
    return str(configuration.id)


async def portal_url(*, customer_id: str, return_url: str) -> str:
    params: Any = {"customer": customer_id, "return_url": return_url}
    configuration = await _portal_configuration()
    if configuration:
        params["configuration"] = configuration
    async with _api() as api:
        session = await api.v1.billing_portal.sessions.create_async(params=params)
    return str(session.url)


async def subscription(subscription_id: str) -> dict[str, Any]:
    async with _api() as api:
        found = await api.v1.subscriptions.retrieve_async(subscription_id)
    data: dict[str, Any] = found.to_dict()
    return data


def construct_event(payload: bytes, signature: str | None) -> dict[str, Any]:
    """The verified event, as plain data (Stripe objects are not dicts in SDK 15+)."""
    secret = get_settings().stripe_webhook_secret.get_secret_value()
    if not secret:
        raise ValueError("STRIPE_WEBHOOK_SECRET is not configured")
    event = stripe.Webhook.construct_event(payload, signature or "", secret)
    data: dict[str, Any] = event.to_dict()
    return data


def _first_item(sub: Any) -> Any:
    # Stripe objects are dicts: `sub.items` would be dict.items, hence the subscripts.
    try:
        return sub["items"]["data"][0]
    except (KeyError, IndexError, TypeError):
        return None


def period_end(sub: Any) -> datetime | None:
    """Current period end: on the items since API 2025-03-31, on the subscription before."""
    item = _first_item(sub)
    value = (item.get("current_period_end") if item is not None else None) or sub.get(
        "current_period_end"
    )
    return datetime.fromtimestamp(int(value), tz=UTC) if value else None


def lookup_key_of(sub: Any) -> str | None:
    item = _first_item(sub)
    price = item.get("price") if item is not None else None
    return price.get("lookup_key") if price is not None else None
