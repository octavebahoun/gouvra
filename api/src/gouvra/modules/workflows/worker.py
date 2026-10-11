"""Worker service: advance workflow runs and run their tool steps."""

from __future__ import annotations

import asyncio
import contextlib

from gouvra.core.config import get_settings
from gouvra.core.logging import get_logger
from gouvra.core.pglisten import PgListener
from gouvra.modules.workflows.orchestrator import ToolJob, advance_run, due_runs, run_tool_step
from gouvra.modules.workflows.service import WF_CHANNEL

log = get_logger(__name__)

IDLE_WAIT_S = 2  # deadlines and periodic re-checks are found by polling at this pace


async def workflow_service(stop: asyncio.Event) -> None:
    listener = PgListener([WF_CHANNEL])
    await listener.start()
    slots = asyncio.Semaphore(get_settings().worker_concurrency)
    running: set[asyncio.Task[None]] = set()

    async def tool_step(job: ToolJob) -> None:
        async with slots:
            try:
                await run_tool_step(job)
            except Exception:
                log.exception("workflow_tool_step_error", run_id=str(job.run_id))

    try:
        while not stop.is_set():
            try:
                for run_id in await due_runs():
                    for job in await advance_run(run_id):
                        task = asyncio.create_task(tool_step(job))
                        running.add(task)
                        task.add_done_callback(running.discard)
            except Exception:
                log.exception("workflow_advance_error")
            await listener.wait(WF_CHANNEL, max_wait=IDLE_WAIT_S, stop=stop)
    finally:
        # Tool calls in flight finish (they are bounded by their own timeouts).
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        with contextlib.suppress(Exception):
            await listener.close()
