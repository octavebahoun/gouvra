"""Alembic environment (async engine). Migrations are versioned and reversible."""

from __future__ import annotations

import asyncio

from alembic import context
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from gouvra.core.config import get_settings
from gouvra.models import Base  # importing gouvra.models registers every table

target_metadata = Base.metadata


def _url() -> str:
    override = context.config.attributes.get("database_url")
    return str(override or get_settings().database_url.get_secret_value())


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
elif (provided := context.config.attributes.get("connection")) is not None:
    _run(provided)  # programmatic use (tests): the caller owns the connection and event loop
else:
    asyncio.run(run_migrations_online())
