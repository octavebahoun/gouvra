"""Per-request context (correlation ID, client IP) carried through contextvars."""

from __future__ import annotations

from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_client_ip: ContextVar[str | None] = ContextVar("client_ip", default=None)


def current_request_id() -> str | None:
    return _request_id.get()


def set_request_id(value: str | None) -> None:
    _request_id.set(value)


def current_client_ip() -> str | None:
    return _client_ip.get()


def set_client_ip(value: str | None) -> None:
    _client_ip.set(value)
