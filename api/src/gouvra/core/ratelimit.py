"""Sliding-window rate limiting on Valkey (atomic Lua script)."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from gouvra.core.errors import RateLimited
from gouvra.core.ids import uuid7
from gouvra.core.logging import get_logger
from gouvra.core.redis import get_redis

log = get_logger(__name__)

# KEYS[1] = zset key; ARGV = now_ms, window_ms, limit, member
_SLIDING_WINDOW = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = (tonumber(oldest[2]) + window) - now end
  return {0, retry}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, 0}
"""


@dataclass(frozen=True)
class Limit:
    name: str
    limit: int
    window_s: int


# Named policies — one place to review every limit.
LOGIN_PER_ACCOUNT = Limit("login:account", 10, 300)
LOGIN_PER_IP = Limit("login:ip", 50, 300)
REGISTER_PER_IP = Limit("register:ip", 10, 3600)
EMAIL_PER_ADDRESS = Limit("email:address", 3, 900)  # verification resend, password reset
EMAIL_PER_IP = Limit("email:ip", 15, 3600)
RESET_PER_IP = Limit("reset:ip", 20, 900)
INVITES_PER_WORKSPACE = Limit("invites:workspace", 50, 86400)
EXECUTIONS_PER_WORKSPACE = Limit("executions:workspace", 120, 60)
WEBHOOK_PER_TRIGGER = Limit("webhook:trigger", 60, 60)


def _key(limit: Limit, subject: str) -> str:
    digest = hashlib.sha256(subject.lower().encode()).hexdigest()[:32]
    return f"rl:{limit.name}:{digest}"


async def hit(limit: Limit, subject: str | None) -> None:
    """Count one attempt; raise RateLimited (429 + Retry-After) when the window is full."""
    if not subject:
        return
    now_ms = int(time.time() * 1000)
    allowed, retry_ms = await get_redis().eval(
        _SLIDING_WINDOW,
        1,
        _key(limit, subject),
        now_ms,
        limit.window_s * 1000,
        limit.limit,
        uuid7().hex,
    )
    if not int(allowed):
        log.info("rate_limited", policy=limit.name)
        raise RateLimited(retry_after=max(1, int(retry_ms) // 1000 + 1))


async def reset(limit: Limit, subject: str) -> None:
    await get_redis().delete(_key(limit, subject))
