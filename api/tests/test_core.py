"""Core platform behaviour: health, errors, middleware, logging redaction, configuration."""

from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel, ValidationError

from gouvra.core.config import Settings
from gouvra.core.errors import NotFound, RateLimited, register_error_handlers
from gouvra.core.ids import hash_token, new_token, uuid7
from gouvra.core.logging import REDACTED, redact, redact_text
from gouvra.core.middleware import (
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
    client_ip_from_scope,
)


async def test_healthz(app_client: AsyncClient) -> None:
    response = await app_client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert len(response.headers["x-request-id"]) >= 8


async def test_readyz_reports_database_and_redis(app_client: AsyncClient) -> None:
    response = await app_client.get("/readyz")
    body = response.json()
    assert response.status_code == 200, body
    assert body["status"] == "ready"
    assert body["checks"]["database"]["migrations"] == "up_to_date"
    assert body["checks"]["redis"]["ok"] is True


async def test_request_id_is_propagated_when_well_formed(app_client: AsyncClient) -> None:
    response = await app_client.get("/healthz", headers={"X-Request-ID": "abc-12345678"})
    assert response.headers["x-request-id"] == "abc-12345678"
    hostile = await app_client.get("/healthz", headers={"X-Request-ID": "<script>"})
    assert hostile.headers["x-request-id"] != "<script>"


async def test_meta_exposes_instance_features(app_client: AsyncClient) -> None:
    response = await app_client.get("/api/v1/meta")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Gouvra"
    assert body["signup_enabled"] is True
    assert body["billing_enabled"] is False


async def test_unknown_route_is_problem_json(app_client: AsyncClient) -> None:
    response = await app_client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == "not_found"
    assert body["request_id"] == response.headers["x-request-id"]


class Payload(BaseModel):
    name: str
    size: int


def _error_app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)
    router = APIRouter()

    @router.get("/missing")
    async def missing() -> None:
        raise NotFound("Agent not found")

    @router.get("/limited")
    async def limited() -> None:
        raise RateLimited(retry_after=7)

    @router.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret internals sk-abcdefghijklmnopqrstuvwxyz")

    @router.post("/validate")
    async def validate(payload: Payload) -> Payload:
        return payload

    app.include_router(router)
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=64)
    app.add_middleware(RequestContextMiddleware)
    return app


@pytest.fixture
async def error_client() -> AsyncClient:
    transport = ASGITransport(app=_error_app(), raise_app_exceptions=False)
    return AsyncClient(transport=transport, base_url="http://t")


async def test_app_errors_are_normalized(error_client: AsyncClient) -> None:
    response = await error_client.get("/missing")
    assert response.status_code == 404
    assert response.json()["detail"] == "Agent not found"

    limited = await error_client.get("/limited")
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "7"
    assert limited.json()["details"] == {"retry_after": 7}


async def test_unhandled_errors_never_leak_internals(error_client: AsyncClient) -> None:
    response = await error_client.get("/boom")
    assert response.status_code == 500
    text = response.text
    assert "sk-" not in text
    assert "RuntimeError" not in text
    assert response.json()["code"] == "internal_error"


async def test_validation_errors_point_to_fields(error_client: AsyncClient) -> None:
    response = await error_client.post("/validate", json={"name": "x", "size": "big"})
    assert response.status_code == 422
    errors = response.json()["errors"]
    assert errors[0]["field"] == "size"


async def test_body_size_limit_with_and_without_content_length(error_client: AsyncClient) -> None:
    big = b'{"name": "' + b"x" * 200 + b'", "size": 1}'
    response = await error_client.post(
        "/validate", content=big, headers={"content-type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"

    async def chunks():  # type: ignore[no-untyped-def]
        for _ in range(10):
            yield b"x" * 20

    streamed = await error_client.post(
        "/validate", content=chunks(), headers={"content-type": "application/json"}
    )
    assert streamed.status_code == 413


def test_client_ip_trusts_only_configured_hops() -> None:
    scope = {
        "type": "http",
        "client": ("10.0.0.2", 1234),
        "headers": [(b"x-forwarded-for", b"6.6.6.6, 198.51.100.7")],
    }
    assert client_ip_from_scope(scope, 1) == "198.51.100.7"
    assert client_ip_from_scope(scope, 0) == "10.0.0.2"


def test_redaction_of_keys_values_and_emails() -> None:
    data = {
        "password": "hunter2",
        "nested": {"api_key": "x", "note": "token sk-abcdefghijklmnopqrstuvwxyz used"},
        "headers": [{"Authorization": "Bearer abc.def"}],
        "user": "jane.doe@example.com",
        "stripe": "sk_test_51ABCDEFGHijklmnop",
    }
    out = redact(data)
    assert out["password"] == REDACTED
    assert out["nested"]["api_key"] == REDACTED
    assert "sk-abc" not in out["nested"]["note"]
    assert out["headers"][0]["Authorization"] == REDACTED
    assert out["user"] == "j***@example.com"
    assert "sk_test_" not in out["stripe"]
    assert redact_text("Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl") == REDACTED


def test_ids_and_tokens() -> None:
    first, second = uuid7(), uuid7()
    assert first.version == 7
    assert first != second
    token = new_token()
    assert len(token) >= 43
    assert hash_token(token) == hash_token(token)
    assert hash_token(token) != token


def test_production_config_rejects_unsafe_settings() -> None:
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings(
            app_env="production",
            app_url="https://gouvra.example",
            cookie_secure=False,
            email_provider="resend",
            session_secret="s" * 40,
            encryption_keys="k1:" + "A" * 43,
        )
    with pytest.raises(ValidationError, match="SESSION_SECRET"):
        Settings(app_env="development", session_secret="short", encryption_keys="k1:" + "A" * 43)
    with pytest.raises(ValidationError, match="32 bytes"):
        Settings(app_env="development", session_secret="s" * 40, encryption_keys="k1:AAAA")


def test_key_ring_parsing() -> None:
    settings = Settings(
        app_env="development",
        session_secret="s" * 40,
        encryption_keys="new:" + "B" * 43 + ",old:" + "A" * 43,
        cors_origins="https://a.example, https://b.example",  # type: ignore[arg-type]
    )
    ring = settings.encryption_key_ring()
    assert [kid for kid, _ in ring] == ["new", "old"]
    assert all(len(key) == 32 for _, key in ring)
    assert settings.cors_origins == ["https://a.example", "https://b.example"]
