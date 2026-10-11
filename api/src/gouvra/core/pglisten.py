"""PostgreSQL LISTEN/NOTIFY helper for the worker (instant wake-ups, auto-reconnect)."""

from __future__ import annotations

import asyncio
import contextlib

import asyncpg

from gouvra.core.config import get_settings
from gouvra.core.logging import get_logger

log = get_logger(__name__)


def asyncpg_dsn() -> str:
    return (
        get_settings()
        .database_url.get_secret_value()
        .replace("postgresql+asyncpg://", "postgresql://", 1)
    )


class PgListener:
    def __init__(self, channels: list[str]) -> None:
        self.channels = channels
        self.events: dict[str, asyncio.Event] = {c: asyncio.Event() for c in channels}
        self.payloads: dict[str, list[str]] = {c: [] for c in channels}
        self._conn: asyncpg.Connection | None = None

    def _on_notify(self, _conn: object, _pid: int, channel: str, payload: object) -> None:
        if channel in self.events:
            if payload:
                self.payloads[channel].append(str(payload))
            self.events[channel].set()

    async def start(self) -> None:
        try:
            self._conn = await asyncpg.connect(asyncpg_dsn())
            for channel in self.channels:
                await self._conn.add_listener(channel, self._on_notify)
        except (OSError, asyncpg.PostgresError) as exc:
            log.warning("pg_listen_unavailable", error=type(exc).__name__)
            self._conn = None

    async def _ensure(self) -> None:
        if self._conn is None or self._conn.is_closed():
            await self.start()

    async def wait(
        self, channel: str, *, max_wait: float, stop: asyncio.Event | None = None
    ) -> list[str]:
        """Wait for a notification on `channel` (or the timeout / stop). Returns payloads."""
        await self._ensure()
        event = self.events[channel]
        waiters = [asyncio.create_task(event.wait())]
        if stop is not None:
            waiters.append(asyncio.create_task(stop.wait()))
        try:
            await asyncio.wait(waiters, timeout=max_wait, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in waiters:
                task.cancel()
        event.clear()
        payloads, self.payloads[channel] = self.payloads[channel], []
        return payloads

    async def close(self) -> None:
        if self._conn is not None and not self._conn.is_closed():
            with contextlib.suppress(Exception):
                await self._conn.close(timeout=2)
        self._conn = None
