"""Worker service: grade finished evaluation executions and close runs."""

from __future__ import annotations

import asyncio
import contextlib

from gouvra.core.logging import get_logger
from gouvra.core.pglisten import PgListener
from gouvra.modules.evaluations.service import EVAL_CHANNEL, grade_pending

log = get_logger(__name__)


async def evaluation_service(stop: asyncio.Event) -> None:
    listener = PgListener([EVAL_CHANNEL])
    await listener.start()
    try:
        while not stop.is_set():
            try:
                while await grade_pending() > 0:
                    pass
            except Exception:
                log.exception("evaluation_grading_error")
            await listener.wait(EVAL_CHANNEL, max_wait=5, stop=stop)
    finally:
        with contextlib.suppress(Exception):
            await listener.close()
