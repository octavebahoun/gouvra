"""Liveness and readiness probes."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from gouvra.core.db import get_engine
from gouvra.core.logging import get_logger
from gouvra.core.redis import get_redis

log = get_logger(__name__)
router = APIRouter(tags=["health"])

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def alembic_head() -> str | None:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    return ScriptDirectory.from_config(cfg).get_current_head()


async def _check_database() -> dict[str, Any]:
    started = time.perf_counter()
    async with get_engine().connect() as conn:
        await conn.execute(text("SELECT 1"))
        current = (
            await conn.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one_or_none()
    head = alembic_head()
    return {
        "ok": current == head,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "migrations": "up_to_date" if current == head else "pending",
    }


async def _check_redis() -> dict[str, Any]:
    started = time.perf_counter()
    pong = await get_redis().ping()
    return {"ok": bool(pong), "latency_ms": round((time.perf_counter() - started) * 1000, 1)}


@router.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    """Liveness: the process is up. Never touches dependencies."""
    return {"status": "ok"}


@router.get("/readyz", include_in_schema=False)
async def readyz() -> JSONResponse:
    """Readiness: database reachable with migrations applied, Valkey reachable."""
    checks: dict[str, Any] = {}
    for name, check in (("database", _check_database), ("redis", _check_redis)):
        try:
            checks[name] = await asyncio.wait_for(check(), timeout=3)
        except Exception as exc:  # noqa: BLE001 - any failure means "not ready"
            log.warning("readiness_check_failed", check=name, error=type(exc).__name__)
            checks[name] = {"ok": False, "error": type(exc).__name__}
    ready = all(c.get("ok") for c in checks.values())
    return JSONResponse(
        {"status": "ready" if ready else "not_ready", "checks": checks},
        status_code=200 if ready else 503,
    )
