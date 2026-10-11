"""Shared Valkey/Redis client (rate limiting, pub/sub for live events, cancel signals)."""

from __future__ import annotations

from redis.asyncio import Redis

from gouvra.core.config import get_settings

_client: Redis | None = None


def get_redis() -> Redis:
    global _client  # noqa: PLW0603 - process-wide singleton
    if _client is None:
        _client = Redis.from_url(
            get_settings().redis_url.get_secret_value(),
            decode_responses=True,
            health_check_interval=30,
            socket_connect_timeout=5,
        )
    return _client


async def close_redis() -> None:
    global _client  # noqa: PLW0603
    if _client is not None:
        await _client.aclose()
    _client = None
