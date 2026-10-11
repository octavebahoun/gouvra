"""Normalized errors (RFC 9457 Problem Details) and their FastAPI handlers."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from gouvra.core.context import current_request_id
from gouvra.core.logging import get_logger

log = get_logger(__name__)

PROBLEM_JSON = "application/problem+json"
ERROR_DOCS_BASE = "https://gouvra.dev/docs/errors#"


class AppError(Exception):
    """Base class for every error that is safe to show to API clients."""

    status_code: int = 400
    code: str = "bad_request"
    title: str = "Bad request"

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
        errors: list[dict[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.message = message or self.title
        if code:
            self.code = code
        self.details = details or {}
        self.errors = errors or []
        self.headers = headers or {}
        super().__init__(self.message)


class BadRequest(AppError):
    pass


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"
    title = "Authentication required"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"
    title = "You do not have permission to perform this action"


class NotFound(AppError):
    status_code = 404
    code = "not_found"
    title = "Resource not found"


class Conflict(AppError):
    status_code = 409
    code = "conflict"
    title = "Conflict"


class Gone(AppError):
    status_code = 410
    code = "gone"
    title = "This link has expired"


class PayloadTooLarge(AppError):
    status_code = 413
    code = "payload_too_large"
    title = "Payload too large"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"
    title = "Some fields are invalid"


class RateLimited(AppError):
    status_code = 429
    code = "rate_limited"
    title = "Too many requests — slow down and retry later"

    def __init__(self, retry_after: int, message: str | None = None) -> None:
        super().__init__(
            message,
            details={"retry_after": retry_after},
            headers={"Retry-After": str(max(1, retry_after))},
        )


class QuotaExceeded(AppError):
    status_code = 402
    code = "quota_exceeded"
    title = "Plan limit reached"


class ServiceUnavailable(AppError):
    status_code = 503
    code = "service_unavailable"
    title = "Service temporarily unavailable"


def problem(
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    *,
    details: dict[str, Any] | None = None,
    errors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": ERROR_DOCS_BASE + code,
        "title": title,
        "status": status,
        "code": code,
        "detail": detail or title,
        "request_id": current_request_id(),
    }
    if details:
        body["details"] = details
    if errors:
        body["errors"] = errors
    return body


def _response(body: dict[str, Any], headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        body, status_code=int(body["status"]), media_type=PROBLEM_JSON, headers=headers
    )


def _field_path(loc: tuple[int | str, ...] | list[int | str]) -> str:
    parts = [str(p) for p in loc if p not in ("body", "query", "path", "header", "cookie")]
    return ".".join(parts) if parts else str(loc[-1]) if loc else ""


async def _app_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)  # noqa: S101 - registered for AppError only
    return _response(
        problem(
            exc.status_code,
            exc.code,
            exc.title,
            exc.message,
            details=exc.details,
            errors=exc.errors,
        ),
        exc.headers,
    )


async def _validation_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)  # noqa: S101
    errors = [
        {
            "field": _field_path(tuple(err.get("loc", ()))),
            "code": str(err.get("type", "invalid")),
            "message": str(err.get("msg", "Invalid value")),
        }
        for err in exc.errors()
    ]
    return _response(
        problem(422, ValidationFailed.code, ValidationFailed.title, errors=errors),
    )


async def _http_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101
    status = exc.status_code
    phrase = HTTPStatus(status).phrase if status in HTTPStatus._value2member_map_ else "Error"
    code = {
        404: "not_found",
        405: "method_not_allowed",
        401: "unauthorized",
        403: "forbidden",
        413: "payload_too_large",
    }.get(status, phrase.lower().replace(" ", "_"))
    detail = exc.detail if isinstance(exc.detail, str) and status < 500 else phrase
    return _response(problem(status, code, phrase, detail), dict(exc.headers or {}))


async def _unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
    log.error("unhandled_error", error_type=type(exc).__name__, exc_info=exc)
    return _response(
        problem(
            500,
            "internal_error",
            "Unexpected server error",
            "Something went wrong on our side. Retry, and share the request ID if it persists.",
        )
    )


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_handler)
