"""Re-encrypt stored secrets with the active key after a key-ring rotation."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select

from gouvra.core.crypto import active_key_id, decrypt_secret, encrypt_secret
from gouvra.core.db import get_sessionmaker


@dataclass
class RotationReport:
    checked: int = 0
    rotated: int = 0
    failed: int = 0


class HasSecret(Protocol):
    id: uuid.UUID
    workspace_id: uuid.UUID
    secret_ciphertext: bytes | None
    secret_key_id: str | None


def _rotate(rows: Iterable[HasSecret], purpose: str, active: str, report: RotationReport) -> None:
    for row in rows:
        report.checked += 1
        if (
            row.secret_key_id == active
            or row.secret_ciphertext is None
            or row.secret_key_id is None
        ):
            continue
        try:
            plain = decrypt_secret(
                row.secret_ciphertext,
                row.secret_key_id,
                workspace_id=row.workspace_id,
                resource_id=row.id,
                purpose=purpose,
            )
        except Exception:  # noqa: BLE001 - counted and reported, never printed
            report.failed += 1
            continue
        sealed = encrypt_secret(
            plain, workspace_id=row.workspace_id, resource_id=row.id, purpose=purpose
        )
        row.secret_ciphertext, row.secret_key_id = sealed.ciphertext, sealed.key_id
        report.rotated += 1


async def rotate_secrets() -> RotationReport:
    """Every secret not sealed with the first key of ENCRYPTION_KEYS is re-sealed with it.

    Safe to run several times; secrets already on the active key are left untouched.
    """
    from gouvra.modules.providers.models import ProviderConfig
    from gouvra.modules.providers.service import SECRET_PURPOSE as PROVIDER_PURPOSE
    from gouvra.modules.tools.models import Tool
    from gouvra.modules.tools.runtime import SECRET_PURPOSE as TOOL_PURPOSE

    report = RotationReport()
    active = active_key_id()
    async with get_sessionmaker()() as db:
        providers = (
            await db.execute(
                select(ProviderConfig)
                .where(ProviderConfig.secret_ciphertext.is_not(None))
                .with_for_update()
            )
        ).scalars()
        _rotate(providers, PROVIDER_PURPOSE, active, report)
        tools = (
            await db.execute(
                select(Tool).where(Tool.secret_ciphertext.is_not(None)).with_for_update()
            )
        ).scalars()
        _rotate(tools, TOOL_PURPOSE, active, report)
        from gouvra.modules.automations.models import Automation
        from gouvra.modules.automations.service import SECRET_PURPOSE as AUTOMATION_PURPOSE

        automations = (
            await db.execute(
                select(Automation)
                .where(Automation.secret_ciphertext.is_not(None))
                .with_for_update()
            )
        ).scalars()
        _rotate(automations, AUTOMATION_PURPOSE, active, report)
        from gouvra.modules.connectors.models import Connection
        from gouvra.modules.connectors.service import SECRET_PURPOSE as CONNECTION_PURPOSE

        connections = (
            await db.execute(
                select(Connection).where(Connection.archived_at.is_(None)).with_for_update()
            )
        ).scalars()
        _rotate(connections, CONNECTION_PURPOSE, active, report)
        await db.commit()
    return report
