"""Operator CLI: `gouvra <command>` (also `python -m gouvra.cli`)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config

from gouvra.core.health import MIGRATIONS_DIR


def alembic_config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    return cfg


def cmd_migrate(args: argparse.Namespace) -> int:
    cfg = alembic_config()
    # Rolling back is always explicit: `--down <revision>` or a relative step such as `-1`.
    if args.down or args.revision.startswith("-"):
        command.downgrade(cfg, args.revision)
    else:
        command.upgrade(cfg, args.revision)
    return 0


def cmd_export_openapi(args: argparse.Namespace) -> int:
    from gouvra.main import create_app

    schema = create_app().openapi()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sys.stdout.write(f"OpenAPI schema written to {out}\n")
    return 0


def cmd_rotate_secrets(_: argparse.Namespace) -> int:
    import asyncio

    from gouvra.core.rotation import rotate_secrets

    report = asyncio.run(rotate_secrets())
    sys.stdout.write(
        f"Secrets checked: {report.checked}, re-encrypted: {report.rotated},"
        f" failed: {report.failed}\n"
    )
    if report.failed:
        sys.stdout.write(
            "Some secrets could not be decrypted: keep their old key in ENCRYPTION_KEYS.\n"
        )
    return 1 if report.failed else 0


def cmd_create_superadmin(args: argparse.Namespace) -> int:
    import asyncio

    from gouvra.modules.admin.bootstrap import promote_superadmin

    return asyncio.run(promote_superadmin(args.email))


def cmd_seed_demo(args: argparse.Namespace) -> int:
    import asyncio

    from gouvra.seed import seed_demo

    return asyncio.run(seed_demo(with_real_runs=not args.offline))


def cmd_sandbox(args: argparse.Namespace) -> int:
    """Serve the code sandbox (its own process and container: see gouvra.sandbox)."""
    import uvicorn

    from gouvra.core.logging import configure_logging
    from gouvra.sandbox.app import create_sandbox_app
    from gouvra.sandbox.settings import get_sandbox_settings

    settings = get_sandbox_settings()
    configure_logging(settings.log_level, settings.log_format)
    uvicorn.run(
        create_sandbox_app(settings),
        host=args.host,
        port=args.port,
        log_config=None,
        server_header=False,
        timeout_graceful_shutdown=130,  # a run may take up to 120 s
    )
    return 0


def cmd_check_config(args: argparse.Namespace) -> int:
    from gouvra.core.config_check import main as check_main

    return check_main(live=args.live)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gouvra", description="Gouvra operator commands")
    sub = parser.add_subparsers(dest="command", required=True)

    migrate = sub.add_parser("migrate", help="Apply (or roll back) database migrations")
    migrate.add_argument("revision", nargs="?", default="head", help="'head', a revision, or '-1'")
    migrate.add_argument(
        "--down", action="store_true", help="roll back to REVISION (e.g. before an upgrade)"
    )
    migrate.set_defaults(func=cmd_migrate)

    export = sub.add_parser("export-openapi", help="Write the OpenAPI schema to a file")
    export.add_argument("--output", default="openapi.json")
    export.set_defaults(func=cmd_export_openapi)

    rotate = sub.add_parser("rotate-secrets", help="Re-encrypt stored secrets with the active key")
    rotate.set_defaults(func=cmd_rotate_secrets)

    superadmin = sub.add_parser("create-superadmin", help="Grant instance administration to a user")
    superadmin.add_argument("email")
    superadmin.set_defaults(func=cmd_create_superadmin)

    seed = sub.add_parser("seed-demo", help="Create the demo account and sample workspace")
    seed.add_argument(
        "--offline", action="store_true", help="only scripted runs (no provider calls)"
    )
    seed.set_defaults(func=cmd_seed_demo)

    check = sub.add_parser("check-config", help="Verify configuration (never prints secret values)")
    check.add_argument("--live", action="store_true", help="also call providers (read-only)")
    check.set_defaults(func=cmd_check_config)

    sandbox = sub.add_parser("sandbox", help="Serve the code sandbox (needs Docker access)")
    sandbox.add_argument("--host", default="0.0.0.0")  # noqa: S104 - inside its container
    sandbox.add_argument("--port", type=int, default=8090)
    sandbox.set_defaults(func=cmd_sandbox)

    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
