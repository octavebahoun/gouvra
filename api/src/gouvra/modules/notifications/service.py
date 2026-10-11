"""Queue transactional e-mails (outbox) and deliver them from the worker."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.logging import get_logger, redact_text
from gouvra.core.pglisten import PgListener
from gouvra.modules.notifications.models import EmailOutbox, OutboxStatus
from gouvra.modules.notifications.senders import EmailDeliveryError, OutgoingEmail, get_sender
from gouvra.modules.notifications.templates import render

log = get_logger(__name__)

CHANNEL = "gouvra_outbox"
MAX_ATTEMPTS = 8
LEASE = timedelta(minutes=5)


async def queue_email(
    db: AsyncSession,
    *,
    to: str,
    template: str,
    locale: str,
    context: dict[str, Any],
    action_url: str | None = None,
    meta: dict[str, Any] | None = None,
) -> EmailOutbox:
    """Render now, deliver later: the row commits (or rolls back) with the triggering change."""
    rendered = render(template, locale, context, action_url)
    row = EmailOutbox(
        to_email=to,
        template=template,
        locale=locale,
        subject=rendered.subject,
        html_body=rendered.html,
        text_body=rendered.text,
        status=OutboxStatus.PENDING,
        attempts=0,
        next_attempt_at=utcnow(),
        meta=meta or {},
    )
    db.add(row)
    await db.execute(text("SELECT pg_notify(:channel, '')"), {"channel": CHANNEL})
    return row


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(30 * 2 ** max(attempts - 1, 0), 3600))


async def _claim_one() -> EmailOutbox | None:
    """Lease one due message (SKIP LOCKED): several workers never send the same row at once."""
    async with get_sessionmaker()() as db:
        due = (
            select(EmailOutbox.id)
            .where(
                EmailOutbox.status == OutboxStatus.PENDING, EmailOutbox.next_attempt_at <= utcnow()
            )
            .order_by(EmailOutbox.next_attempt_at)
            .limit(1)
            .with_for_update(skip_locked=True)
            .scalar_subquery()
        )
        claimed = (
            await db.execute(
                update(EmailOutbox)
                .where(EmailOutbox.id == due)
                .values(attempts=EmailOutbox.attempts + 1, next_attempt_at=utcnow() + LEASE)
                .returning(EmailOutbox)
            )
        ).scalar_one_or_none()
        await db.commit()
        return claimed


async def _record(row_id: object, **values: Any) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(EmailOutbox).where(EmailOutbox.id == row_id).values(**values))
        await db.commit()


async def dispatch_due(max_messages: int = 50) -> int:
    """Send every due message (up to `max_messages`). Returns how many were delivered."""
    sender = get_sender()
    delivered = 0
    for _ in range(max_messages):
        row = await _claim_one()
        if row is None:
            break
        email = OutgoingEmail(
            to=row.to_email,
            subject=row.subject,
            html=row.html_body or "",
            text=row.text_body or "",
            idempotency_key=f"gouvra-outbox-{row.id}",
            tags={"template": row.template},
        )
        try:
            provider_id = await sender.send(email)
        except EmailDeliveryError as exc:
            final = not exc.retryable or row.attempts >= MAX_ATTEMPTS
            await _record(
                row.id,
                status=OutboxStatus.FAILED if final else OutboxStatus.PENDING,
                next_attempt_at=utcnow() + _backoff(row.attempts),
                last_error=redact_text(str(exc))[:500],
                **({"html_body": None, "text_body": None} if final else {}),
            )
            log.warning(
                "email_delivery_failed",
                template=row.template,
                attempt=row.attempts,
                final=final,
                error=str(exc),
            )
            continue
        # One-time links must not linger in the database once delivered.
        await _record(
            row.id,
            status=OutboxStatus.SENT,
            sent_at=utcnow(),
            provider_message_id=provider_id,
            html_body=None,
            text_body=None,
            last_error=None,
        )
        delivered += 1
        log.info(
            "email_delivered", template=row.template, to=redact_text(row.to_email), via=sender.name
        )
    return delivered


async def outbox_service(stop: asyncio.Event) -> None:
    """Worker service: wake on NOTIFY (instant) or every 15 s (retries, missed notifications)."""
    listener = PgListener([CHANNEL])
    await listener.start()
    try:
        while not stop.is_set():
            try:
                await dispatch_due()
            except Exception:  # keep the service alive, retry next tick
                log.exception("outbox_dispatch_error")
            await listener.wait(CHANNEL, max_wait=15, stop=stop)
    finally:
        with contextlib.suppress(Exception):
            await listener.close()
