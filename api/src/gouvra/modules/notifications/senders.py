"""E-mail delivery adapters: Resend (production), SMTP (Mailpit in dev), console (tests)."""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from typing import Protocol

import httpx

from gouvra.core.config import EmailProvider, Settings, get_settings
from gouvra.core.logging import get_logger, redact_text

log = get_logger(__name__)


@dataclass(frozen=True)
class OutgoingEmail:
    to: str
    subject: str
    html: str
    text: str
    idempotency_key: str
    tags: dict[str, str] = field(default_factory=dict)


class EmailDeliveryError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class EmailSender(Protocol):
    name: str

    async def send(self, email: OutgoingEmail) -> str | None:
        """Deliver the message; return the provider message id when there is one."""
        ...


class ConsoleEmailSender:
    """Keeps messages in memory (tests) and logs a redacted summary — never the body."""

    name = "console"

    def __init__(self) -> None:
        self.outbox: list[OutgoingEmail] = []

    async def send(self, email: OutgoingEmail) -> str | None:
        self.outbox.append(email)
        log.info("email_sent_console", to=redact_text(email.to), subject=email.subject)
        return None


class SmtpEmailSender:
    name = "smtp"

    def __init__(self, host: str, port: int, sender: str) -> None:
        self.host = host
        self.port = port
        self.sender = sender

    def _send_sync(self, email: OutgoingEmail) -> str:
        message = EmailMessage()
        name, address = parseaddr(self.sender)
        message["From"] = formataddr((name, address))
        message["To"] = email.to
        message["Subject"] = email.subject
        message_id = make_msgid(domain=address.split("@")[-1] or "localhost")
        message["Message-ID"] = message_id
        message.set_content(email.text)
        message.add_alternative(email.html, subtype="html")
        with smtplib.SMTP(self.host, self.port, timeout=10) as smtp:
            smtp.send_message(message)
        return message_id

    async def send(self, email: OutgoingEmail) -> str | None:
        try:
            return await asyncio.to_thread(self._send_sync, email)
        except (OSError, smtplib.SMTPException) as exc:
            raise EmailDeliveryError(
                f"SMTP delivery failed: {type(exc).__name__}", retryable=True
            ) from exc


class ResendEmailSender:
    """https://resend.com/docs/api-reference/emails/send-email"""

    name = "resend"
    endpoint = "https://api.resend.com/emails"

    def __init__(self, api_key: str, sender: str, client: httpx.AsyncClient | None = None) -> None:
        self.api_key = api_key
        self.sender = sender
        self.client = client

    async def send(self, email: OutgoingEmail) -> str | None:
        payload = {
            "from": self.sender,
            "to": [email.to],
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
            "tags": [{"name": k, "value": v} for k, v in email.tags.items()],
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            # Retries of the same outbox row never send twice.
            "Idempotency-Key": email.idempotency_key,
        }
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15.0))
        try:
            response = await client.post(self.endpoint, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise EmailDeliveryError(
                f"Resend unreachable: {type(exc).__name__}", retryable=True
            ) from exc
        finally:
            if self.client is None:
                await client.aclose()
        if response.status_code == 429 or response.status_code >= 500:
            raise EmailDeliveryError(f"Resend HTTP {response.status_code}", retryable=True)
        if response.status_code >= 400:
            detail = response.json().get("message", "") if response.content else ""
            raise EmailDeliveryError(
                f"Resend rejected the message: {detail}"[:300], retryable=False
            )
        message_id = response.json().get("id")
        return str(message_id) if message_id else None


_sender: EmailSender | None = None


def build_sender(settings: Settings) -> EmailSender:
    if settings.email_provider is EmailProvider.RESEND:
        return ResendEmailSender(settings.resend_api_key.get_secret_value(), settings.email_from)
    if settings.email_provider is EmailProvider.SMTP:
        return SmtpEmailSender(settings.smtp_host, settings.smtp_port, settings.email_from)
    return ConsoleEmailSender()


def get_sender() -> EmailSender:
    global _sender  # noqa: PLW0603 - process-wide adapter
    if _sender is None:
        _sender = build_sender(get_settings())
    return _sender


def set_sender(sender: EmailSender | None) -> None:
    """Swap the adapter (tests)."""
    global _sender  # noqa: PLW0603
    _sender = sender
