"""Worker service: raise budget and quota alerts, end simulated subscriptions that expired."""

from __future__ import annotations

import asyncio
import contextlib

from gouvra.core.db import get_sessionmaker
from gouvra.core.logging import get_logger
from gouvra.modules.billing.service import billing_enabled, expire_simulated
from gouvra.modules.budgets.service import evaluate_recent

log = get_logger(__name__)

EVERY_S = 60


async def budget_service(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await evaluate_recent()
            if billing_enabled():
                async with get_sessionmaker()() as db:
                    await expire_simulated(db)
        except Exception:
            log.exception("budget_service_error")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=EVERY_S)
