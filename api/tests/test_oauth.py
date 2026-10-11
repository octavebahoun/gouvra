"""OAuth sign-in (GitHub, Google) against mocked provider endpoints."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from httpx import AsyncClient
from sqlalchemy import select

from gouvra.core.db import get_sessionmaker
from gouvra.modules.identity.models import OAuthAccount, User
from tests.helpers import PASSWORD, Outbox, signup

pytestmark = pytest.mark.usefixtures("outbox")


def _mock_github(email: str, *, verified: bool = True, account_id: int = 4242) -> None:
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"access_token": "gho_test", "token_type": "bearer"})
    )
    respx.get("https://api.github.com/user").mock(
        return_value=httpx.Response(
            200, json={"id": account_id, "login": "octo", "name": "Octo Cat"}
        )
    )
    respx.get("https://api.github.com/user/emails").mock(
        return_value=httpx.Response(
            200, json=[{"email": email, "primary": True, "verified": verified}]
        )
    )


async def _start(
    client: AsyncClient, provider: str, next_path: str = "/app"
) -> dict[str, list[str]]:
    response = await client.get(f"/api/v1/auth/oauth/{provider}/start", params={"next": next_path})
    assert response.status_code == 302
    return parse_qs(urlsplit(response.headers["location"]).query)


async def test_start_uses_pkce_state_and_the_registered_callback(app_client: AsyncClient) -> None:
    params = await _start(app_client, "github")
    assert params["redirect_uri"] == ["https://testserver/api/v1/auth/oauth/github/callback"]
    assert params["code_challenge_method"] == ["S256"]
    assert len(params["state"][0]) >= 24
    google = await _start(app_client, "google")
    assert google["redirect_uri"] == ["https://testserver/api/v1/auth/oauth/google/callback"]
    assert "openid" in google["scope"][0]


async def test_unknown_or_disabled_provider_is_404(
    app_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert (await app_client.get("/api/v1/auth/oauth/gitlab/start")).status_code == 404
    from gouvra.core.config import get_settings

    monkeypatch.setattr(get_settings(), "google_client_id", "")
    assert (await app_client.get("/api/v1/auth/oauth/google/start")).status_code == 404
    meta = await app_client.get("/api/v1/meta")
    assert meta.json()["oauth_providers"] == ["github"]


@respx.mock
async def test_github_sign_up_then_sign_in(app_client: AsyncClient) -> None:
    _mock_github("octo@example.com")
    state = (await _start(app_client, "github", "/w/acme/agents"))["state"][0]
    callback = await app_client.get(
        "/api/v1/auth/oauth/github/callback", params={"code": "abc", "state": state}
    )
    assert callback.status_code == 302
    assert callback.headers["location"] == "https://testserver/w/acme/agents"
    session = await app_client.get("/api/v1/auth/session")
    assert session.status_code == 200
    user = session.json()["user"]
    assert user["email_verified"] is True
    assert user["has_password"] is False
    assert user["oauth_providers"] == ["github"]
    # The PKCE verifier was sent with the code.
    exchange = respx.calls[0].request
    assert b"code_verifier=" in exchange.content


@respx.mock
async def test_state_mismatch_is_rejected(app_client: AsyncClient) -> None:
    await _start(app_client, "github")
    callback = await app_client.get(
        "/api/v1/auth/oauth/github/callback", params={"code": "abc", "state": "forged"}
    )
    assert callback.headers["location"].endswith("/login?oauth_error=state")
    assert (await app_client.get("/api/v1/auth/session")).status_code == 401


@respx.mock
async def test_unverified_provider_email_is_refused(app_client: AsyncClient) -> None:
    _mock_github("unverified@example.com", verified=False)
    state = (await _start(app_client, "github"))["state"][0]
    callback = await app_client.get(
        "/api/v1/auth/oauth/github/callback", params={"code": "abc", "state": state}
    )
    assert callback.headers["location"].endswith("oauth_error=email_unverified")


async def test_next_parameter_cannot_redirect_off_site(app_client: AsyncClient) -> None:
    from gouvra.modules.identity.oauth import safe_next

    for hostile in (
        "//evil.example",
        "https://evil.example",
        "/\\evil.example",
        "javascript:alert(1)",
    ):
        assert safe_next(hostile) == "/app"
    assert safe_next("/w/acme/executions?status=failed") == "/w/acme/executions?status=failed"


@respx.mock
async def test_links_to_existing_verified_account(make_client, outbox: Outbox) -> None:  # type: ignore[no-untyped-def]
    owner = await signup(make_client(), outbox, "linked@example.com")
    _mock_github("linked@example.com", account_id=777)
    client = make_client()
    state = (await _start(client, "github"))["state"][0]
    await client.get("/api/v1/auth/oauth/github/callback", params={"code": "abc", "state": state})
    session = (await client.get("/api/v1/auth/session")).json()
    assert session["user"]["id"] == owner.user_id
    assert session["user"]["has_password"] is True


@respx.mock
async def test_preregistered_unverified_account_cannot_be_hijacked(make_client) -> None:  # type: ignore[no-untyped-def]
    attacker = make_client()
    await attacker.post(
        "/api/v1/auth/register",
        json={
            "email": "victim@example.com",
            "password": PASSWORD,
            "display_name": "Fake",
            "accept_terms": True,
        },
    )
    assert (
        await attacker.post(
            "/api/v1/auth/login", json={"email": "victim@example.com", "password": PASSWORD}
        )
    ).status_code == 200
    _mock_github("victim@example.com", account_id=999)
    victim = make_client()
    state = (await _start(victim, "github"))["state"][0]
    await victim.get("/api/v1/auth/oauth/github/callback", params={"code": "abc", "state": state})
    assert (await victim.get("/api/v1/auth/session")).status_code == 200
    # The attacker's password and session are gone.
    assert (await attacker.get("/api/v1/auth/session")).status_code == 401
    assert (
        await make_client().post(
            "/api/v1/auth/login", json={"email": "victim@example.com", "password": PASSWORD}
        )
    ).status_code == 401
    async with get_sessionmaker()() as db:
        user = (
            await db.execute(select(User).where(User.email == "victim@example.com"))
        ).scalar_one()
        assert user.password_hash is None
        links = (
            (await db.execute(select(OAuthAccount).where(OAuthAccount.user_id == user.id)))
            .scalars()
            .all()
        )
        assert [link.provider for link in links] == ["github"]


@respx.mock
async def test_google_sign_in(app_client: AsyncClient) -> None:
    respx.post("https://oauth2.googleapis.com/token").mock(
        return_value=httpx.Response(200, json={"access_token": "ya29.test"})
    )
    respx.get("https://openidconnect.googleapis.com/v1/userinfo").mock(
        return_value=httpx.Response(
            200,
            json={
                "sub": "1234",
                "email": "gina@example.com",
                "email_verified": True,
                "name": "Gina",
            },
        )
    )
    state = (await _start(app_client, "google"))["state"][0]
    callback = await app_client.get(
        "/api/v1/auth/oauth/google/callback", params={"code": "abc", "state": state}
    )
    assert callback.status_code == 302
    assert (await app_client.get("/api/v1/auth/session")).json()["user"]["display_name"] == "Gina"


@respx.mock
async def test_provider_denial_and_failed_exchange(app_client: AsyncClient) -> None:
    state = (await _start(app_client, "github"))["state"][0]
    denied = await app_client.get(
        "/api/v1/auth/oauth/github/callback", params={"error": "access_denied", "state": state}
    )
    assert denied.headers["location"].endswith("oauth_error=denied")
    respx.post("https://github.com/login/oauth/access_token").mock(
        return_value=httpx.Response(200, json={"error": "bad_verification_code"})
    )
    state = (await _start(app_client, "github"))["state"][0]
    failed = await app_client.get(
        "/api/v1/auth/oauth/github/callback", params={"code": "zzz", "state": state}
    )
    assert failed.headers["location"].endswith("oauth_error=exchange")
