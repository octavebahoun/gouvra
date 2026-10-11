"""Test harness: a real PostgreSQL database (migrated once) and a real Valkey, cleaned per test."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import quote

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient


def _read_dotenv() -> dict[str, str]:
    path = Path(__file__).resolve().parents[2] / ".env"
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    return values


_DOTENV = _read_dotenv()
_PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD") or _DOTENV.get("POSTGRES_PASSWORD", "gouvra")
_VALKEY_PASSWORD = os.environ.get("VALKEY_PASSWORD") or _DOTENV.get("VALKEY_PASSWORD", "")
TEST_DB_NAME = "gouvra_test"
PG_BASE = os.environ.get(
    "TEST_POSTGRES_BASE", f"gouvra:{quote(_PG_PASSWORD, safe='')}@localhost:55432"
)
REDIS_URL = os.environ.get(
    "TEST_REDIS_URL",
    f"redis://:{quote(_VALKEY_PASSWORD, safe='')}@localhost:56379/15"
    if _VALKEY_PASSWORD
    else "redis://localhost:56379/15",
)

os.environ.update(
    {
        "APP_ENV": "test",
        "APP_URL": "http://testserver",
        "DATABASE_URL": f"postgresql+asyncpg://{PG_BASE}/{TEST_DB_NAME}",
        "REDIS_URL": REDIS_URL,
        "SESSION_SECRET": "test-session-secret-0123456789abcdef0123456789",
        "ENCRYPTION_KEYS": "ktest:" + "A" * 43,
        "EMAIL_PROVIDER": "console",
        "COOKIE_SECURE": "true",
        "LOG_FORMAT": "console",
        "LOG_LEVEL": "WARNING",
        "BILLING_PROVIDER": "none",
        "SIGNUP_ENABLED": "true",
    }
)

from gouvra.core.config import get_settings  # noqa: E402

get_settings.cache_clear()


async def _recreate_database() -> None:
    conn = await asyncpg.connect(f"postgresql://{PG_BASE}/postgres")
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB_NAME}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
    finally:
        await conn.close()


async def _migrate() -> None:
    from alembic import command
    from sqlalchemy.ext.asyncio import create_async_engine

    from gouvra.cli import alembic_config

    engine = create_async_engine(get_settings().database_url.get_secret_value())

    def _upgrade(sync_conn: object) -> None:
        cfg = alembic_config()
        cfg.attributes["connection"] = sync_conn
        command.upgrade(cfg, "head")

    async with engine.begin() as conn:
        await conn.run_sync(_upgrade)
    await engine.dispose()


@pytest.fixture(scope="session", autouse=True)
async def database() -> AsyncIterator[None]:
    await _recreate_database()
    await _migrate()
    yield
    from gouvra.core.db import dispose_engine
    from gouvra.core.redis import close_redis

    await dispose_engine()
    await close_redis()


@pytest.fixture(autouse=True)
async def clean_state(database: None) -> AsyncIterator[None]:
    yield
    from sqlalchemy import text

    from gouvra.core.db import get_engine
    from gouvra.core.redis import get_redis
    from gouvra.models import Base

    tables = [t.name for t in Base.metadata.sorted_tables]
    if tables:
        async with get_engine().begin() as conn:
            await conn.execute(
                text(
                    "TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE"
                )
            )
    await get_redis().flushdb()


@pytest.fixture
async def app_client() -> AsyncIterator[AsyncClient]:
    from gouvra.main import create_app

    app = create_app()
    transport = ASGITransport(app=app, client=("203.0.113.10", 51000))
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client
