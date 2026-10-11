"""Registry of the worker's background services (execution runner, scheduler, reaper, ...)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

Service = Callable[[asyncio.Event], Coroutine[Any, Any, None]]


def registered_services() -> list[Service]:
    from gouvra.modules.evaluations.worker import evaluation_service
    from gouvra.modules.executions.worker import execution_service
    from gouvra.modules.notifications.service import outbox_service

    return [outbox_service, execution_service, evaluation_service]
