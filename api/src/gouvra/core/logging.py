"""Structured JSON logging with correlation IDs and secret / PII redaction."""

from __future__ import annotations

import logging
import re
import sys
from collections.abc import Mapping, MutableMapping
from typing import Any

import orjson
import structlog
from structlog.typing import EventDict, Processor, WrappedLogger

REDACTED = "[REDACTED]"

_SENSITIVE_KEY = re.compile(
    r"(pass(word)?|secret|token|api[_-]?key|authorization|cookie|session|signature|"
    r"credential|private[_-]?key|ciphertext|set-cookie|x-csrf)",
    re.IGNORECASE,
)
# Values that look like credentials, wherever they appear.
_SECRET_VALUE_PATTERNS = [
    re.compile(r"\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}"),  # Stripe
    re.compile(r"\bwhsec_[A-Za-z0-9]{8,}"),  # Stripe webhook
    re.compile(r"\bsk-(ant-)?[A-Za-z0-9_\-]{16,}"),  # OpenAI / DeepSeek / Anthropic style
    re.compile(r"\bre_[A-Za-z0-9_]{16,}"),  # Resend
    re.compile(r"\bgvr_[a-z]+_[A-Za-z0-9_\-]{16,}"),  # Gouvra service keys
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-~+/]+=*"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),  # JWT
]
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b")


def redact_text(value: str) -> str:
    for pattern in _SECRET_VALUE_PATTERNS:
        value = pattern.sub(REDACTED, value)
    return _EMAIL.sub(r"\1***@\2", value)


def redact(value: Any, *, depth: int = 0) -> Any:
    """Recursively redact secrets and personal data from an arbitrary structure."""
    if depth > 8:
        return "[TRUNCATED]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_str = str(key)
            out[key_str] = (
                REDACTED if _SENSITIVE_KEY.search(key_str) else redact(item, depth=depth + 1)
            )
        return out
    if isinstance(value, list | tuple | set):
        return [redact(item, depth=depth + 1) for item in value]
    return value


def _redaction_processor(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict.keys()):
        if key in {"event", "level", "timestamp", "logger"}:
            if key == "event" and isinstance(event_dict[key], str):
                event_dict[key] = redact_text(event_dict[key])
            continue
        if _SENSITIVE_KEY.search(key):
            event_dict[key] = REDACTED
        else:
            event_dict[key] = redact(event_dict[key])
    return event_dict


def _drop_color_message(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    event_dict.pop("color_message", None)
    return event_dict


def _orjson_dumps(obj: MutableMapping[str, Any], default: Any = None) -> str:
    return orjson.dumps(obj, default=default).decode()


def configure_logging(level: str = "INFO", fmt: str = "json") -> None:
    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _drop_color_message,
        structlog.processors.format_exc_info,
        _redaction_processor,
    ]
    renderer: Processor = (
        structlog.processors.JSONRenderer(serializer=_orjson_dumps)
        if fmt == "json"
        else structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())
    )
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # We emit our own access log with correlation IDs; silence the default one.
    for name in ("uvicorn.access",):
        logging.getLogger(name).disabled = True
    for name in ("uvicorn", "uvicorn.error", "sqlalchemy.engine", "httpx", "httpcore"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    logging.getLogger("httpx").setLevel("WARNING")
    logging.getLogger("httpcore").setLevel("WARNING")


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.stdlib.get_logger(name)
    return logger
