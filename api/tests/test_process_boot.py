"""Each process (API, worker) registers the whole schema before touching the database."""

from __future__ import annotations

import subprocess
import sys

SCRIPT = """
import asyncio, os
os.environ.setdefault("APP_ENV", "test")
from gouvra.core.db import Base
from gouvra.worker import runner

async def main():
    stop = asyncio.Event()
    stop.set()
    await runner.run_worker(stop)
    expected = {"api_keys", "executions", "agents", "tools", "provider_configs", "users"}
    missing = expected - set(Base.metadata.tables)
    print("MISSING:" + ",".join(sorted(missing)))

asyncio.run(main())
"""


def test_worker_process_registers_every_table() -> None:
    command = [sys.executable, "-c", SCRIPT]  # trusted, constant script
    result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)  # noqa: S603
    assert "MISSING:" in result.stdout, result.stderr[-2000:]
    assert result.stdout.strip().endswith("MISSING:"), result.stdout
