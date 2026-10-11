"""Worker process: runs background services until SIGTERM/SIGINT, then drains gracefully."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import time
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

from gouvra.core.config import get_settings
from gouvra.core.db import dispose_engine, get_engine
from gouvra.core.logging import configure_logging, get_logger
from gouvra.core.redis import close_redis

log = get_logger(__name__)

HEARTBEAT_FILE = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/gouvra-worker.alive"))  # noqa: S108
HEARTBEAT_EVERY_S = 10

Service = Callable[[asyncio.Event], Coroutine[Any, Any, None]]


def worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def _heartbeat(stop: asyncio.Event) -> None:
    """Touch a file so the container healthcheck can tell a stuck worker from a live one."""
    while not stop.is_set():
        await asyncio.to_thread(HEARTBEAT_FILE.write_text, str(int(time.time())))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_EVERY_S)


def services() -> list[Service]:
    """Background services run by the worker. Each one returns when `stop` is set."""
    from gouvra.worker.services import registered_services

    return [_heartbeat, *registered_services()]


async def run_worker(stop: asyncio.Event | None = None) -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)
    get_engine()
    log.info("worker_started", worker_id=worker_id(), concurrency=settings.worker_concurrency)
    tasks: list[asyncio.Task[None]] = [
        asyncio.create_task(service(stop), name=service.__name__) for service in services()
    ]
    try:
        done, _ = await asyncio.wait(
            [*tasks, asyncio.create_task(stop.wait())], return_when=asyncio.FIRST_COMPLETED
        )
        for task in done:
            if task in tasks and task.exception() is not None:
                log.error(
                    "worker_service_crashed", service=task.get_name(), exc_info=task.exception()
                )
                stop.set()
    finally:
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await close_redis()
        await dispose_engine()
        await asyncio.to_thread(HEARTBEAT_FILE.unlink, missing_ok=True)
        log.info("worker_stopped")
