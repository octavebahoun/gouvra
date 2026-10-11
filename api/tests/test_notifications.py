"""Transactional e-mail: templates, outbox delivery, Resend and SMTP adapters."""

from __future__ import annotations

import os

import httpx
import pytest
import respx
from sqlalchemy import select

from gouvra.core.db import get_sessionmaker
from gouvra.modules.notifications.models import EmailOutbox, OutboxStatus
from gouvra.modules.notifications.senders import (
    EmailDeliveryError,
    OutgoingEmail,
    ResendEmailSender,
    SmtpEmailSender,
    set_sender,
)
from gouvra.modules.notifications.service import dispatch_due, queue_email
from gouvra.modules.notifications.templates import TEMPLATES, render

MAIL = OutgoingEmail(
    to="dev@example.com", subject="Hello", html="<p>Hi</p>", text="Hi", idempotency_key="k1"
)


@pytest.mark.parametrize("template", sorted(TEMPLATES))
@pytest.mark.parametrize("locale", ["en", "fr"])
def test_every_template_renders_in_both_languages(template: str, locale: str) -> None:
    context = {
        "name": "Ada",
        "email": "ada@example.com",
        "inviter": "Grace",
        "workspace": "Acme",
        "role": "admin",
        "expires": "2026-10-18",
        "when": "2026-10-11 10:00 UTC",
        "title": "Budget",
        "body": "80 %",
    }
    rendered = render(template, locale, context, "https://app.example/x#token=abc")
    assert rendered.subject
    assert rendered.text
    assert rendered.html.startswith("<!doctype html>")
    assert f'lang="{locale}"' in rendered.html


def test_user_content_is_escaped() -> None:
    rendered = render(
        "invitation",
        "en",
        {
            "inviter": "<script>alert(1)</script>",
            "workspace": "A&B",
            "role": "member",
            "email": "x@example.com",
            "expires": "soon",
        },
        'https://app.example/invite#token=a"onmouseover="x',
    )
    assert "<script>" not in rendered.html
    assert "&lt;script&gt;" in rendered.html
    assert 'a"onmouseover' not in rendered.html


def test_subjects_stay_on_one_line() -> None:
    """Names can come from OAuth profiles: a line break must never reach a mail header."""
    rendered = render(
        "alert",
        "en",
        {"title": "Acme\r\nBcc: victim@example.com\x00", "body": "b", "workspace": "Acme"},
        "https://app.example/w/acme/usage",
    )
    assert rendered.subject == "[Gouvra] Acme Bcc: victim@example.com"


def test_french_role_names() -> None:
    rendered = render(
        "invitation",
        "fr",
        {"inviter": "G", "workspace": "W", "role": "viewer", "email": "e@x.io", "expires": "x"},
        None,
    )
    assert "lecteur" in rendered.text


class FlakySender:
    name = "flaky"

    def __init__(self, failures: int, retryable: bool = True) -> None:
        self.failures = failures
        self.retryable = retryable
        self.sent: list[OutgoingEmail] = []

    async def send(self, email: OutgoingEmail) -> str | None:
        if self.failures > 0:
            self.failures -= 1
            raise EmailDeliveryError("boom", retryable=self.retryable)
        self.sent.append(email)
        return "msg_1"


async def _queue_one() -> None:
    async with get_sessionmaker()() as db:
        await queue_email(
            db,
            to="q@example.com",
            template="reset_password",
            locale="en",
            context={"name": "Q", "email": "q@example.com"},
            action_url="https://x/reset#token=secret",
        )
        await db.commit()


async def _row() -> EmailOutbox:
    async with get_sessionmaker()() as db:
        return (await db.execute(select(EmailOutbox))).scalar_one()


async def test_delivery_success_purges_one_time_links() -> None:
    sender = FlakySender(0)
    set_sender(sender)
    await _queue_one()
    assert await dispatch_due() == 1
    row = await _row()
    assert row.status == OutboxStatus.SENT
    assert row.provider_message_id == "msg_1"
    assert row.html_body is None
    assert row.text_body is None
    assert sender.sent[0].idempotency_key == f"gouvra-outbox-{row.id}"


async def test_retryable_failures_are_retried_later() -> None:
    sender = FlakySender(1)
    set_sender(sender)
    await _queue_one()
    assert await dispatch_due() == 0
    row = await _row()
    assert row.status == OutboxStatus.PENDING
    assert row.attempts == 1
    assert row.last_error
    assert await dispatch_due() == 0  # backoff: not due yet


async def test_permanent_failures_stop() -> None:
    set_sender(FlakySender(1, retryable=False))
    await _queue_one()
    await dispatch_due()
    row = await _row()
    assert row.status == OutboxStatus.FAILED
    assert row.html_body is None


@respx.mock
async def test_resend_adapter_contract() -> None:
    route = respx.post("https://api.resend.com/emails")
    route.mock(return_value=httpx.Response(200, json={"id": "re_msg_123"}))
    sender = ResendEmailSender("re_test_key", "Gouvra <noreply@example.com>")
    assert await sender.send(MAIL) == "re_msg_123"
    request = route.calls[0].request
    assert request.headers["authorization"] == "Bearer re_test_key"
    assert request.headers["idempotency-key"] == "k1"
    route.mock(return_value=httpx.Response(429, json={"message": "slow down"}))
    with pytest.raises(EmailDeliveryError) as retryable:
        await sender.send(MAIL)
    assert retryable.value.retryable
    route.mock(return_value=httpx.Response(422, json={"message": "invalid from"}))
    with pytest.raises(EmailDeliveryError) as permanent:
        await sender.send(MAIL)
    assert not permanent.value.retryable


async def test_smtp_adapter_delivers_to_mailpit() -> None:
    sender = SmtpEmailSender("127.0.0.1", 1025, "Gouvra <noreply@gouvra.local>")
    try:
        message_id = await sender.send(
            OutgoingEmail(
                to="smtp-test@example.com",
                subject="SMTP ✓",
                html="<b>ok</b>",
                text="ok",
                idempotency_key="s1",
            )
        )
    except EmailDeliveryError:
        pytest.skip("Mailpit SMTP not reachable on 127.0.0.1:1025")
    assert message_id
    async with httpx.AsyncClient() as client:
        found = await client.get(
            "http://127.0.0.1:8025/api/v1/search", params={"query": "to:smtp-test@example.com"}
        )
    assert found.status_code == 200
    assert any(m["Subject"] == "SMTP ✓" for m in found.json()["messages"])


@pytest.mark.real
async def test_resend_real_delivery() -> None:
    """Sends through the real Resend API to Resend's own test inbox (no real person is mailed)."""
    from gouvra.core.config import get_settings

    settings = get_settings()
    key = settings.resend_api_key.get_secret_value() or os.environ.get("RESEND_API_KEY", "")
    sender_address = (
        settings.email_from
        if "@" in settings.email_from and "localhost" not in settings.email_from
        else ""
    )
    if not key or not sender_address:
        pytest.skip("RESEND_API_KEY / EMAIL_FROM not configured")
    rendered = render(
        "verify_email",
        "en",
        {"name": "Gouvra CI", "email": "delivered@resend.dev"},
        "https://example.com/verify#token=test",
    )
    sender = ResendEmailSender(key, sender_address)
    message_id = await sender.send(
        OutgoingEmail(
            to="delivered@resend.dev",
            subject=rendered.subject,
            html=rendered.html,
            text=rendered.text,
            idempotency_key=f"gouvra-real-test-{os.getpid()}",
        )
    )
    assert message_id


def test_smtp_adapter_secures_and_authenticates(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: float, **_: object) -> None:
            calls.append(f"connect {host}:{port}")

        def __enter__(self) -> FakeSMTP:
            return self

        def __exit__(self, *exc: object) -> None:
            calls.append("quit")

        def starttls(self, context: object) -> None:
            calls.append("starttls")

        def login(self, user: str, password: str) -> None:
            calls.append(f"login {user}")

        def send_message(self, message: object) -> None:
            calls.append("send")

    monkeypatch.setattr("smtplib.SMTP", FakeSMTP)
    sender = SmtpEmailSender(
        "smtp.example.com",
        587,
        "Gouvra <noreply@example.com>",
        username="relay-user",
        password="relay-pass",
        security="starttls",
    )
    sender._send_sync(
        OutgoingEmail(
            to="a@example.com", subject="Hi", text="t", html="<p>t</p>", idempotency_key="k1"
        )
    )
    assert calls == ["connect smtp.example.com:587", "starttls", "login relay-user", "send", "quit"]


def test_production_refuses_insecure_email(monkeypatch: pytest.MonkeyPatch) -> None:
    from gouvra.core.config import Settings

    base = {
        "app_env": "production",
        "app_url": "https://gouvra.example.com",
        "cookie_secure": True,
        "session_secret": "x" * 48,
        "encryption_keys": "k1:" + "A" * 43,
    }
    with pytest.raises(ValueError, match="SMTP_SECURITY"):
        Settings(**base, email_provider="smtp", smtp_security="none")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="RESEND_API_KEY"):
        Settings(**base, email_provider="resend", resend_api_key="")  # type: ignore[arg-type]
