"""Worker service: apply retention policies every hour."""

from __future__ import annotations

import asyncio
import contextlib

from gouvra.core.logging import get_logger
from gouvra.modules.retention.service import purge_all

log = get_logger(__name__)

EVERY_S = 3600


async def retention_service(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await purge_all()
        except Exception:
            log.exception("retention_error")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=EVERY_S)
