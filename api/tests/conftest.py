"""Test harness: a real PostgreSQL database (migrated once) and a real Valkey, cleaned per test."""

from __future__ import annotations

import os
import socket
from collections.abc import AsyncIterator, Iterator
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
        "APP_URL": "https://testserver",
        "API_PUBLIC_URL": "https://testserver",
        "DATABASE_URL": f"postgresql+asyncpg://{PG_BASE}/{TEST_DB_NAME}",
        "REDIS_URL": REDIS_URL,
        "SESSION_SECRET": "test-session-secret-0123456789abcdef0123456789",
        "ENCRYPTION_KEYS": "ktest:" + "A" * 43,
        "EMAIL_PROVIDER": "console",
        "COOKIE_SECURE": "true",
        "LOG_FORMAT": "console",
        "LOG_LEVEL": "WARNING",
        "BILLING_PROVIDER": "none",
        "GITHUB_CLIENT_ID": "Iv1.testclientid0001",
        "GITHUB_CLIENT_SECRET": "0" * 40,
        "GOOGLE_CLIENT_ID": "test-client.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-test-secret-000000",
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


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver", "postgres", "valkey"}


@pytest.fixture(autouse=True)
def no_external_network(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    """Tests never reach the Internet unless marked `real` (third-party calls must be mocked)."""
    if request.node.get_closest_marker("real"):
        yield
        return
    real_getaddrinfo = socket.getaddrinfo

    def guarded(host, *args, **kwargs):  # type: ignore[no-untyped-def]
        name = host.decode() if isinstance(host, bytes) else host
        if name is not None and name not in _LOCAL_HOSTS and not str(name).startswith("127."):
            raise OSError(f"external network blocked in tests: {name}")
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)
    yield


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


@pytest.fixture(scope="session")
def app() -> object:
    from gouvra.main import create_app

    return create_app()


def _csrf_hook(client: AsyncClient):  # type: ignore[no-untyped-def]
    async def hook(request):  # type: ignore[no-untyped-def]
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            for name in ("__Host-gv_csrf", "gv_csrf"):
                value = client.cookies.get(name)
                if value and "x-csrf-token" not in request.headers:
                    request.headers["x-csrf-token"] = value
                    break

    return hook


@pytest.fixture
async def make_client(app: object) -> AsyncIterator[object]:
    """Factory of independent browser-like clients (own cookie jar, CSRF header, distinct IP)."""
    clients: list[AsyncClient] = []
    counter = iter(range(10, 250))

    def factory(*, ip: str | None = None, csrf: bool = True) -> AsyncClient:
        transport = ASGITransport(app=app, client=(ip or f"203.0.113.{next(counter)}", 51000))  # type: ignore[arg-type]
        client = AsyncClient(
            transport=transport,
            base_url="https://testserver",
            headers={"Origin": "https://testserver"},
        )
        if csrf:
            client.event_hooks["request"].append(_csrf_hook(client))
        clients.append(client)
        return client

    yield factory
    for client in clients:
        await client.aclose()


@pytest.fixture
async def app_client(make_client: object) -> AsyncClient:
    return make_client()  # type: ignore[operator, no-any-return]


@pytest.fixture
def outbox() -> object:
    from tests.helpers import Outbox

    return Outbox()


@pytest.fixture
async def lab(make_client: object, outbox: object) -> dict[str, object]:
    """Workspace with a scripted provider, two tools and an agent allowed the calculator."""
    from tests.helpers import (
        create_agent,
        create_builtin_tool,
        create_provider,
        create_workspace,
        signup,
    )

    owner = await signup(make_client(), outbox, "runner@example.com")  # type: ignore[operator, arg-type]
    ws = await create_workspace(owner, "Runs")
    provider = await create_provider(owner, ws["id"])
    calc = await create_builtin_tool(owner, ws["id"], "calculator")
    clock = await create_builtin_tool(owner, ws["id"], "current_time")
    agent = await create_agent(
        owner,
        ws["id"],
        provider["id"],
        tool_ids=[calc["id"]],
        limits={"max_steps": 4, "max_tool_calls": 3, "timeout_s": 30},
    )
    return {
        "owner": owner,
        "ws": ws,
        "provider": provider,
        "agent": agent,
        "calc": calc,
        "clock": clock,
    }
