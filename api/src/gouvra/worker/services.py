"""Registry of the worker's background services (execution runner, scheduler, reaper, ...)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

Service = Callable[[asyncio.Event], Coroutine[Any, Any, None]]


def registered_services() -> list[Service]:
    from gouvra.modules.notifications.service import outbox_service

    return [outbox_service]
