"""Account flows: sign-up, verification, sign-in, sessions, CSRF, recovery, profile."""

from __future__ import annotations

import logging
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.modules.identity.models import EmailToken, User, UserSession
from tests.helpers import PASSWORD, Outbox, signup

pytestmark = pytest.mark.usefixtures("outbox")


async def _users_with(email: str) -> int:
    async with get_sessionmaker()() as db:
        return int(
            (
                await db.execute(select(func.count()).select_from(User).where(User.email == email))
            ).scalar_one()
        )


async def test_full_signup_verify_login_logout(app_client: AsyncClient, outbox: Outbox) -> None:
    account = await signup(app_client, outbox, "ada@example.com", "Ada Lovelace")
    session = await app_client.get("/api/v1/auth/session")
    assert session.status_code == 200
    body = session.json()
    assert body["user"]["email"] == "ada@example.com"
    assert body["user"]["email_verified"] is True
    assert body["workspaces"] == []

    logout = await app_client.post("/api/v1/auth/logout")
    assert logout.status_code == 204
    assert (await app_client.get("/api/v1/auth/session")).status_code == 401

    login = await app_client.post(
        "/api/v1/auth/login", json={"email": account.email, "password": PASSWORD}
    )
    assert login.status_code == 200
    assert login.json()["user"]["id"] == account.user_id


async def test_session_cookies_are_hardened(app_client: AsyncClient, outbox: Outbox) -> None:
    await signup(app_client, outbox, "cookie@example.com")
    response = await app_client.post(
        "/api/v1/auth/login", json={"email": "cookie@example.com", "password": PASSWORD}
    )
    cookies = response.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith("__Host-gv_session="))
    csrf_cookie = next(c for c in cookies if c.startswith("__Host-gv_csrf="))
    for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/"):
        assert flag.lower() in session_cookie.lower()
    assert "httponly" not in csrf_cookie.lower()
    assert "secure" in csrf_cookie.lower()


async def test_register_never_reveals_existing_accounts(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    first = make_client()
    await signup(first, outbox, "taken@example.com")
    payload = {
        "email": "taken@example.com",
        "password": "Another-Strong-Pass-9",
        "display_name": "Mallory",
        "accept_terms": True,
    }
    fresh = {**payload, "email": "fresh@example.com"}
    other = make_client()
    existing_response = await other.post("/api/v1/auth/register", json=payload)
    fresh_response = await other.post("/api/v1/auth/register", json=fresh)
    assert existing_response.status_code == fresh_response.status_code == 202
    assert existing_response.json() == fresh_response.json()
    assert await _users_with("taken@example.com") == 1
    notice = await outbox.last_to("taken@example.com")
    assert "already" in notice.subject.lower() or "tried" in notice.subject.lower()
    # The attacker's password was not applied to the existing account.
    login = await other.post(
        "/api/v1/auth/login",
        json={"email": "taken@example.com", "password": "Another-Strong-Pass-9"},
    )
    assert login.status_code == 401


async def test_password_policy(app_client: AsyncClient) -> None:
    for password, code in (
        ("short", "too_short"),
        ("password123", "too_common"),
        ("bob.martin-2026!", "contains_email"),
    ):
        response = await app_client.post(
            "/api/v1/auth/register",
            json={
                "email": "bob.martin@example.com",
                "password": password,
                "display_name": "Bob",
                "accept_terms": True,
            },
        )
        assert response.status_code == 422, password
        assert code in [e["code"] for e in response.json()["errors"]], password


async def test_terms_must_be_accepted(app_client: AsyncClient) -> None:
    response = await app_client.post(
        "/api/v1/auth/register",
        json={
            "email": "t@example.com",
            "password": PASSWORD,
            "display_name": "T",
            "accept_terms": False,
        },
    )
    assert response.status_code == 422


async def test_login_errors_are_identical_for_unknown_and_wrong_password(
    make_client, outbox: Outbox
) -> None:  # type: ignore[no-untyped-def]
    await signup(make_client(), outbox, "known@example.com")
    client = make_client()
    unknown = await client.post(
        "/api/v1/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}
    )
    wrong = await client.post(
        "/api/v1/auth/login", json={"email": "known@example.com", "password": "Wrong-Password-11"}
    )
    assert unknown.status_code == wrong.status_code == 401
    strip = lambda body: {k: v for k, v in body.items() if k != "request_id"}  # noqa: E731
    assert strip(unknown.json()) == strip(wrong.json())


async def test_unverified_users_are_confined(app_client: AsyncClient, outbox: Outbox) -> None:
    await app_client.post(
        "/api/v1/auth/register",
        json={
            "email": "pending@example.com",
            "password": PASSWORD,
            "display_name": "P",
            "accept_terms": True,
        },
    )
    login = await app_client.post(
        "/api/v1/auth/login", json={"email": "pending@example.com", "password": PASSWORD}
    )
    assert login.status_code == 200
    assert login.json()["user"]["email_verified"] is False
    blocked = await app_client.post("/api/v1/workspaces", json={"name": "Nope"})
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "email_not_verified"
    assert (await app_client.get("/api/v1/me")).status_code == 200
    resend = await app_client.post("/api/v1/auth/verify-email/resend")
    assert resend.status_code == 202
    assert await outbox.count_to("pending@example.com") == 2


async def test_verification_links_are_single_use(app_client: AsyncClient, outbox: Outbox) -> None:
    await app_client.post(
        "/api/v1/auth/register",
        json={
            "email": "once@example.com",
            "password": PASSWORD,
            "display_name": "O",
            "accept_terms": True,
        },
    )
    token = await outbox.token_for("once@example.com")
    assert (
        await app_client.post("/api/v1/auth/verify-email", json={"token": token})
    ).status_code == 200
    again = await app_client.post("/api/v1/auth/verify-email", json={"token": token})
    assert again.status_code == 410
    assert again.json()["code"] == "token_invalid"


async def test_expired_tokens_are_refused(app_client: AsyncClient, outbox: Outbox) -> None:
    await app_client.post(
        "/api/v1/auth/register",
        json={
            "email": "late@example.com",
            "password": PASSWORD,
            "display_name": "L",
            "accept_terms": True,
        },
    )
    token = await outbox.token_for("late@example.com")
    async with get_sessionmaker()() as db:
        await db.execute(update(EmailToken).values(expires_at=utcnow() - timedelta(minutes=1)))
        await db.commit()
    assert (
        await app_client.post("/api/v1/auth/verify-email", json={"token": token})
    ).status_code == 410


async def test_forgot_and_reset_password(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    laptop = make_client()
    await signup(laptop, outbox, "reset@example.com")
    phone = make_client()
    assert (
        await phone.post(
            "/api/v1/auth/login", json={"email": "reset@example.com", "password": PASSWORD}
        )
    ).status_code == 200

    stranger = make_client()
    unknown = await stranger.post(
        "/api/v1/auth/password/forgot", json={"email": "ghost@example.com"}
    )
    known = await stranger.post("/api/v1/auth/password/forgot", json={"email": "reset@example.com"})
    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json()
    assert await outbox.count_to("ghost@example.com") == 0

    token = await outbox.token_for("reset@example.com")
    weak = await stranger.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "123"}
    )
    assert weak.status_code == 422
    new_password = "Brand-New-Secret-77"
    reset = await stranger.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": new_password}
    )
    assert reset.status_code == 200
    # Every pre-existing session is signed out; the owner is told.
    assert (await laptop.get("/api/v1/auth/session")).status_code == 401
    assert (await phone.get("/api/v1/auth/session")).status_code == 401
    assert "changed" in (await outbox.last_to("reset@example.com")).subject.lower()
    assert (
        await stranger.post(
            "/api/v1/auth/password/reset", json={"token": token, "password": new_password}
        )
    ).status_code == 410
    relogin = await make_client().post(
        "/api/v1/auth/login", json={"email": "reset@example.com", "password": new_password}
    )
    assert relogin.status_code == 200


async def test_csrf_and_origin_are_enforced(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    client = make_client()
    await signup(client, outbox, "csrf@example.com")
    bare = make_client(csrf=False)
    bare.cookies = client.cookies
    missing = await bare.post("/api/v1/workspaces", json={"name": "No token"})
    assert missing.status_code == 403
    assert missing.json()["code"] == "csrf_failed"
    forged = await bare.post(
        "/api/v1/workspaces", json={"name": "Forged"}, headers={"x-csrf-token": "0" * 64}
    )
    assert forged.status_code == 403
    cross_site = await client.post(
        "/api/v1/workspaces", json={"name": "Evil"}, headers={"Origin": "https://evil.example"}
    )
    assert cross_site.status_code == 403
    # Login CSRF: a third-party page cannot post the login form either.
    login_csrf = await make_client().post(
        "/api/v1/auth/login",
        json={"email": "csrf@example.com", "password": PASSWORD},
        headers={"Origin": "https://evil.example"},
    )
    assert login_csrf.status_code == 403
    assert (await client.post("/api/v1/workspaces", json={"name": "Legit"})).status_code == 201


async def test_session_rotation_with_grace_period(app_client: AsyncClient, outbox: Outbox) -> None:
    await signup(app_client, outbox, "rotate@example.com")
    old_token = app_client.cookies.get("__Host-gv_session")
    async with get_sessionmaker()() as db:
        await db.execute(update(UserSession).values(rotated_at=utcnow() - timedelta(hours=13)))
        await db.commit()
    response = await app_client.get("/api/v1/auth/session")
    assert response.status_code == 200
    new_token = app_client.cookies.get("__Host-gv_session")
    assert new_token
    assert new_token != old_token
    # The previous token still works during the grace window (requests in flight)...
    stale = AsyncClient(
        transport=app_client._transport,
        base_url="https://testserver",
        headers={"Cookie": f"__Host-gv_session={old_token}"},
    )
    assert (await stale.get("/api/v1/auth/session")).status_code == 200
    # ...and not after it.
    async with get_sessionmaker()() as db:
        await db.execute(
            update(UserSession).values(previous_valid_until=utcnow() - timedelta(seconds=1))
        )
        await db.commit()
    assert (await stale.get("/api/v1/auth/session")).status_code == 401
    await stale.aclose()


async def test_sessions_can_be_listed_and_revoked(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    laptop = make_client()
    await signup(laptop, outbox, "multi@example.com")
    phone = make_client()
    await phone.post(
        "/api/v1/auth/login", json={"email": "multi@example.com", "password": PASSWORD}
    )
    sessions = (await laptop.get("/api/v1/me/sessions")).json()
    assert len(sessions) == 2
    assert sum(1 for s in sessions if s["current"]) == 1
    other = next(s for s in sessions if not s["current"])
    assert (await laptop.delete(f"/api/v1/me/sessions/{other['id']}")).status_code == 204
    assert (await phone.get("/api/v1/auth/session")).status_code == 401
    assert (await laptop.delete(f"/api/v1/me/sessions/{other['id']}")).status_code == 404


async def test_change_password_signs_out_other_sessions(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    laptop = make_client()
    await signup(laptop, outbox, "change@example.com")
    phone = make_client()
    await phone.post(
        "/api/v1/auth/login", json={"email": "change@example.com", "password": PASSWORD}
    )
    wrong = await laptop.post(
        "/api/v1/me/password",
        json={"current_password": "nope-nope-nope", "new_password": "Totally-New-Pass-5"},
    )
    assert wrong.status_code == 422
    ok = await laptop.post(
        "/api/v1/me/password",
        json={"current_password": PASSWORD, "new_password": "Totally-New-Pass-5"},
    )
    assert ok.status_code == 204
    assert (await laptop.get("/api/v1/auth/session")).status_code == 200
    assert (await phone.get("/api/v1/auth/session")).status_code == 401


async def test_login_is_rate_limited(app_client: AsyncClient) -> None:
    payload = {"email": "brute@example.com", "password": "Wrong-Password-11"}
    statuses = [
        (await app_client.post("/api/v1/auth/login", json=payload)).status_code for _ in range(11)
    ]
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429
    limited = await app_client.post("/api/v1/auth/login", json=payload)
    assert int(limited.headers["retry-after"]) >= 1


async def test_reset_requests_are_rate_limited_per_address(make_client) -> None:  # type: ignore[no-untyped-def]
    codes = [
        (
            await make_client().post(
                "/api/v1/auth/password/forgot", json={"email": "target@example.com"}
            )
        ).status_code
        for _ in range(4)
    ]
    assert codes == [202, 202, 202, 429]


async def test_profile_and_preferences(app_client: AsyncClient, outbox: Outbox) -> None:
    await signup(app_client, outbox, "prefs@example.com")
    response = await app_client.patch(
        "/api/v1/me", json={"display_name": "Grace Hopper", "locale": "fr", "theme": "dark"}
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["display_name"], body["locale"], body["theme"]) == ("Grace Hopper", "fr", "dark")
    assert (await app_client.patch("/api/v1/me", json={"theme": "neon"})).status_code == 422


async def test_email_change_flow(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    client = make_client()
    await signup(client, outbox, "old@example.com")
    bad = await client.post(
        "/api/v1/me/email", json={"new_email": "new@example.com", "password": "wrong-password"}
    )
    assert bad.status_code == 422
    ok = await client.post(
        "/api/v1/me/email", json={"new_email": "new@example.com", "password": PASSWORD}
    )
    assert ok.status_code == 202
    token = await outbox.token_for("new@example.com")
    confirmed = await make_client().post("/api/v1/auth/email/confirm", json={"token": token})
    assert confirmed.status_code == 200
    assert confirmed.json()["user"]["email"] == "new@example.com"
    assert "changed" in (await outbox.last_to("old@example.com")).subject.lower()
    assert (
        await client.get("/api/v1/auth/session")
    ).status_code == 401  # other sessions signed out


async def test_secrets_never_reach_the_logs(
    app_client: AsyncClient, outbox: Outbox, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    await signup(app_client, outbox, "quiet@example.com")
    session_token = app_client.cookies.get("__Host-gv_session") or ""
    await app_client.post(
        "/api/v1/auth/login", json={"email": "quiet@example.com", "password": PASSWORD}
    )
    logs = caplog.text
    assert PASSWORD not in logs
    assert session_token not in logs
    assert "quiet@example.com" not in logs


async def test_signup_can_be_disabled(
    app_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gouvra.core.config import get_settings

    monkeypatch.setattr(get_settings(), "signup_enabled", False)
    response = await app_client.post(
        "/api/v1/auth/register",
        json={
            "email": "closed@example.com",
            "password": PASSWORD,
            "display_name": "C",
            "accept_terms": True,
        },
    )
    assert response.status_code == 403
    assert response.json()["code"] == "signup_disabled"
