"""Worker service: fire due schedules, and clean up launches interrupted by a crash."""

from __future__ import annotations

import asyncio
import contextlib

from gouvra.core.logging import get_logger
from gouvra.modules.automations.service import reap_pending, run_due

log = get_logger(__name__)

TICK_S = 5  # schedules have minute resolution: a few seconds of latency is invisible
REAP_EVERY = 12  # ticks (one minute)


async def automation_service(stop: asyncio.Event) -> None:
    ticks = 0
    while not stop.is_set():
        try:
            while await run_due() > 0:
                pass
            if ticks % REAP_EVERY == 0 and (reaped := await reap_pending()):
                log.warning("automation_fires_reaped", count=reaped)
        except Exception:
            log.exception("automation_scheduler_error")
        ticks += 1
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=TICK_S)
