"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from gouvra.api import api_router
from gouvra.core.config import Settings, get_settings
from gouvra.core.db import dispose_engine, get_engine
from gouvra.core.errors import register_error_handlers
from gouvra.core.health import router as health_router
from gouvra.core.logging import configure_logging, get_logger
from gouvra.core.middleware import (
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)
from gouvra.core.redis import close_redis

log = get_logger(__name__)

API_DESCRIPTION = """
Gouvra is an open-source control room to build, run, evaluate and supervise AI agents.

**Authentication** — browser sessions use an `HttpOnly` cookie plus the `X-CSRF-Token` header
on unsafe methods. Programmatic clients use a workspace service key:
`Authorization: Bearer gvr_...`.

**Errors** follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (`application/problem+json`)
with a stable `code` and the `request_id` to quote when reporting a problem.

**Pagination** is cursor-based: pass `limit` and the `next_cursor` of the previous page.

**Idempotency** — creation endpoints accept an `Idempotency-Key` header; retrying with the same
key and payload within 24 h returns the original response instead of creating a duplicate.
"""


def _operation_id(route: APIRoute) -> str:
    """Stable, readable OpenAPI operation IDs (`agents_create`, ...) for generated clients."""
    return f"{route.tags[0]}_{route.name}" if route.tags else route.name


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    get_engine()
    log.info("api_started", version=get_settings().app_version)
    try:
        yield
    finally:
        await close_redis()
        await dispose_engine()
        log.info("api_stopped")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)
    app = FastAPI(
        title="Gouvra API",
        version=settings.app_version,
        description=API_DESCRIPTION,
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
        license_info={"name": "Apache-2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0"},
    )
    register_error_handlers(app)
    app.include_router(health_router)
    app.include_router(api_router, prefix="/api/v1")

    # Order matters: the last added middleware runs first.
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token"],
        )
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=settings.max_request_body_bytes,
        overrides={"/api/v1/hooks/": 262_144, "/api/v1/billing/webhook": 524_288},
    )
    app.add_middleware(SecurityHeadersMiddleware, hsts=settings.is_production)
    app.add_middleware(RequestContextMiddleware, trusted_proxy_hops=settings.trusted_proxy_hops)
    return app
