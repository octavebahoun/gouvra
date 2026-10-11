"""Worker services for executions: runner (claim + run), lease heartbeat, reaper."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Callable

from gouvra.core.config import get_settings
from gouvra.core.logging import get_logger
from gouvra.core.pglisten import PgListener
from gouvra.modules.executions.engine import run_execution
from gouvra.modules.executions.events import EventEmitter
from gouvra.modules.executions.queue import (
    CANCEL_CHANNEL,
    QUEUE_CHANNEL,
    claim_next,
    reap_expired,
    renew_leases,
)
from gouvra.worker.runner import worker_id

log = get_logger(__name__)

HEARTBEAT_EVERY_S = 10
REAP_EVERY_S = 15
SHUTDOWN_GRACE_S = 30


async def _reaper(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            for row in await reap_expired():
                emitter = EventEmitter(row["id"], row["workspace_id"], row["last_seq"])
                await emitter.emit(
                    "execution.failed",
                    {
                        "error": {
                            "code": "worker_lost",
                            "message": "The worker running this execution stopped responding.",
                            "retryable": True,
                        }
                    },
                    level="error",
                )
                log.warning("execution_reaped", execution_id=str(row["id"]))
        except Exception:
            log.exception("reaper_error")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=REAP_EVERY_S)


def _forget(
    running: dict[uuid.UUID, asyncio.Task[None]], key: uuid.UUID
) -> Callable[[asyncio.Task[None]], None]:
    def callback(_: asyncio.Task[None]) -> None:
        running.pop(key, None)

    return callback


async def execution_service(stop: asyncio.Event) -> None:  # noqa: PLR0915 - one supervised loop
    settings = get_settings()
    wid = worker_id()
    capacity = settings.worker_concurrency
    running: dict[uuid.UUID, asyncio.Task[None]] = {}
    shutting_down = asyncio.Event()
    listener = PgListener([QUEUE_CHANNEL, CANCEL_CHANNEL])
    await listener.start()
    reaper = asyncio.create_task(_reaper(stop), name="execution-reaper")
    loop = asyncio.get_running_loop()
    last_heartbeat = loop.time()

    def cancel(ids: list[str] | list[uuid.UUID]) -> None:
        for raw in ids:
            try:
                key = uuid.UUID(str(raw))
            except ValueError:
                continue
            task = running.get(key)
            if task is not None and not task.done():
                log.info("execution_cancel_signal", execution_id=str(key))
                task.cancel()

    try:
        while not stop.is_set():
            while len(running) < capacity:
                try:
                    claimed = await claim_next(wid)
                except Exception:
                    log.exception("claim_error")
                    break
                if claimed is None:
                    break
                task = asyncio.create_task(
                    run_execution(claimed, worker_id=wid, shutting_down=shutting_down),
                    name=f"execution-{claimed}",
                )
                running[claimed] = task
                task.add_done_callback(_forget(running, claimed))
            notified = await listener.wait_any(
                [QUEUE_CHANNEL, CANCEL_CHANNEL], max_wait=2.0, stop=stop
            )
            cancel(notified[CANCEL_CHANNEL])
            if loop.time() - last_heartbeat >= HEARTBEAT_EVERY_S:
                last_heartbeat = loop.time()
                try:
                    cancel(await renew_leases(list(running)))
                except Exception:
                    log.exception("heartbeat_error")
    finally:
        shutting_down.set()
        if running:
            log.info("draining_executions", count=len(running), grace_s=SHUTDOWN_GRACE_S)
            _, pending = await asyncio.wait(list(running.values()), timeout=SHUTDOWN_GRACE_S)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        reaper.cancel()
        await asyncio.gather(reaper, return_exceptions=True)
        await listener.close()
