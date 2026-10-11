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
    if args.revision.startswith("-"):
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gouvra", description="Gouvra operator commands")
    sub = parser.add_subparsers(dest="command", required=True)

    migrate = sub.add_parser("migrate", help="Apply (or roll back) database migrations")
    migrate.add_argument("revision", nargs="?", default="head", help="'head', a revision, or '-1'")
    migrate.set_defaults(func=cmd_migrate)

    export = sub.add_parser("export-openapi", help="Write the OpenAPI schema to a file")
    export.add_argument("--output", default="openapi.json")
    export.set_defaults(func=cmd_export_openapi)

    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
