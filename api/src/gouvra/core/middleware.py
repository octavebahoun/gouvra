"""Pure ASGI middlewares: correlation IDs + access log, security headers, body size limit.

Pure ASGI (rather than BaseHTTPMiddleware) keeps streaming responses (SSE) intact.
"""

from __future__ import annotations

import re
import time
from typing import Any

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from gouvra.core.context import set_client_ip, set_request_id
from gouvra.core.errors import PROBLEM_JSON, problem
from gouvra.core.ids import uuid7
from gouvra.core.logging import get_logger

log = get_logger("gouvra.access")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._\-]{8,128}$")
_QUIET_PATHS = {"/healthz", "/readyz"}


def client_ip_from_scope(scope: Scope, trusted_hops: int) -> str | None:
    """Return the client IP, trusting X-Forwarded-For only for the configured proxy hops."""
    client = scope.get("client")
    direct = client[0] if client else None
    if trusted_hops <= 0:
        return direct
    forwarded = Headers(scope=scope).get("x-forwarded-for")
    if not forwarded:
        return direct
    hops = [part.strip() for part in forwarded.split(",") if part.strip()]
    if len(hops) >= trusted_hops:
        return hops[-trusted_hops]
    return hops[0] if hops else direct


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, trusted_proxy_hops: int = 1) -> None:
        self.app = app
        self.trusted_proxy_hops = trusted_proxy_hops

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        incoming = headers.get("x-request-id", "")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid7().hex
        client_ip = client_ip_from_scope(scope, self.trusted_proxy_hops)
        set_request_id(request_id)
        set_client_ip(client_ip)
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.perf_counter()
        status_holder: dict[str, int] = {"status": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                MutableHeaders(scope=message)["x-request-id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in _QUIET_PATHS:
                route = scope.get("route")
                log.info(
                    "http_request",
                    method=scope.get("method"),
                    path=getattr(route, "path", path),
                    status=status_holder["status"],
                    duration_ms=round((time.perf_counter() - started) * 1000, 2),
                    client_ip=client_ip,
                )


API_CSP = "default-src 'none'; frame-ancestors 'none'"
# Vendored API reference: same-origin scripts only; Swagger UI needs inline styles, data: icons.
DOCS_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)


class SecurityHeadersMiddleware:
    """Defensive headers for every API response (the SPA's CSP is set by Caddy)."""

    def __init__(self, app: ASGIApp, *, hsts: bool) -> None:
        self.app = app
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        is_docs = path.startswith("/api/docs")
        is_docs_asset = path.startswith("/api/docs/assets/")

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                h.setdefault("x-content-type-options", "nosniff")
                h.setdefault("referrer-policy", "no-referrer")
                h.setdefault("x-frame-options", "DENY")
                h.setdefault("cross-origin-opener-policy", "same-origin")
                h.setdefault("cross-origin-resource-policy", "same-origin")
                h.setdefault("permissions-policy", "camera=(), microphone=(), geolocation=()")
                h.setdefault("content-security-policy", DOCS_CSP if is_docs else API_CSP)
                h.setdefault(
                    "cache-control", "public, max-age=86400" if is_docs_asset else "no-store"
                )
                if self.hsts:
                    h.setdefault("strict-transport-security", "max-age=63072000; includeSubDomains")
            await send(message)

        await self.app(scope, receive, send_wrapper)


class BodySizeLimitMiddleware:
    """Reject request bodies larger than `max_bytes`, whether or not Content-Length is honest."""

    def __init__(self, app: ASGIApp, max_bytes: int, overrides: dict[str, int] | None = None):
        self.app = app
        self.max_bytes = max_bytes
        self.overrides = overrides or {}

    def _limit_for(self, path: str) -> int:
        for prefix, limit in self.overrides.items():
            if path.startswith(prefix):
                return limit
        return self.max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self._limit_for(scope.get("path", ""))
        declared = Headers(scope=scope).get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            await _send_too_large(send, limit)
            return
        received = 0
        too_large = False

        async def limited_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    too_large = True
                    # An HTTPException survives FastAPI's body parsing (other errors become 400s).
                    raise HTTPException(status_code=413, detail=f"Body exceeds {limit} bytes")
            return message

        response_started = False

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except Exception:
            if too_large and not response_started:
                await _send_too_large(send, limit)
                return
            raise


async def _send_too_large(send: Send, limit: int) -> None:
    import orjson

    body: dict[str, Any] = problem(
        413,
        "payload_too_large",
        "Payload too large",
        f"The request body exceeds the {limit} byte limit.",
        details={"limit_bytes": limit},
    )
    payload = orjson.dumps(body)
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", PROBLEM_JSON.encode()),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
