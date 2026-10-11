"""Instance bootstrap helpers (CLI only — never exposed over HTTP)."""

from __future__ import annotations

import sys

from sqlalchemy import select

from gouvra.core.db import get_sessionmaker
from gouvra.modules.audit.service import record
from gouvra.modules.identity.models import User


async def promote_superadmin(email: str) -> int:
    async with get_sessionmaker()() as db:
        user = (
            await db.execute(select(User).where(User.email == email.strip()))
        ).scalar_one_or_none()
        if user is None:
            sys.stderr.write(
                "No account uses this address. Sign up first, then rerun the command.\n"
            )
            return 1
        if not user.email_verified:
            sys.stderr.write("Confirm the e-mail address of this account first.\n")
            return 1
        user.is_superadmin = True
        await record(
            db,
            "instance.superadmin_granted",
            actor_label="cli",
            target_type="user",
            target_id=user.id,
        )
        await db.commit()
    sys.stdout.write(f"{email} is now an instance administrator.\n")
    return 0
