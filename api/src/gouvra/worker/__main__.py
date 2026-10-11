"""Entrypoint: `python -m gouvra.worker`."""

from __future__ import annotations

import asyncio

from gouvra.worker.runner import run_worker


def main() -> None:
    try:
        import uvloop

        uvloop.install()
    except ImportError:  # pragma: no cover - uvloop is optional
        pass
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
