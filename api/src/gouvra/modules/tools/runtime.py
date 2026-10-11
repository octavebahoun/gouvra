"""Run a tool call: strict argument validation, time limit, normalised result."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

from gouvra.core.crypto import decrypt_secret
from gouvra.core.logging import get_logger
from gouvra.modules.tools.builtins import BUILTINS, ToolInputError
from gouvra.modules.tools.models import Tool
from gouvra.modules.tools.schema_rules import validate_arguments

log = get_logger(__name__)

MAX_RESULT_CHARS = 16_000
SECRET_PURPOSE = "tool_secret"  # noqa: S105 - key purpose label, not a secret


@dataclass
class ToolResult:
    ok: bool
    output: Any = None
    error_code: str | None = None
    error_message: str | None = None
    duration_ms: int = 0
    truncated: bool = False

    def for_model(self) -> str:
        """What the model reads back. Errors are explicit so it can recover or explain."""
        if not self.ok:
            payload: Any = {"error": self.error_code, "message": self.error_message}
        else:
            payload = self.output
        text = (
            payload
            if isinstance(payload, str)
            else json.dumps(payload, ensure_ascii=False, default=str)
        )
        if len(text) > MAX_RESULT_CHARS:
            self.truncated = True
            text = text[:MAX_RESULT_CHARS] + "… [truncated]"
        return text

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "output": self.output,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated,
        }


def tool_secret(tool: Tool) -> str | None:
    if tool.secret_ciphertext is None or tool.secret_key_id is None:
        return None
    return decrypt_secret(
        tool.secret_ciphertext,
        tool.secret_key_id,
        workspace_id=tool.workspace_id,
        resource_id=tool.id,
        purpose=SECRET_PURPOSE,
    )


async def _run_http_tool(tool: Tool, arguments: dict[str, Any]) -> Any:
    from gouvra.modules.tools.http_client import fetch

    config = tool.config
    template = str(config["url"])
    remaining = dict(arguments)

    def fill(match_name: str) -> str:
        value = remaining.pop(match_name, None)
        if value is None:
            raise ToolInputError(f"Missing path parameter {match_name!r}.")
        return quote(str(value), safe="")

    import re

    url = re.sub(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", lambda m: fill(m.group(1)), template)
    method = str(config.get("method", "GET")).upper()
    json_body = None
    if method in ("GET", "DELETE") and remaining:
        from urllib.parse import urlencode

        url += ("&" if "?" in url else "?") + urlencode(
            {k: v if isinstance(v, str) else json.dumps(v) for k, v in remaining.items()}
        )
    elif remaining:
        json_body = remaining
    secret_headers: dict[str, str] = {}
    auth = config.get("auth") or {"type": "none"}
    secret = tool_secret(tool)
    if secret and auth.get("type") == "bearer":
        secret_headers["Authorization"] = f"Bearer {secret}"
    elif secret and auth.get("type") == "header" and auth.get("header_name"):
        secret_headers[str(auth["header_name"])] = secret
    host = urlsplit(template.replace("{", "").replace("}", "")).hostname or ""
    return await fetch(
        method=method,
        url=url,
        headers={str(k): str(v) for k, v in (config.get("headers") or {}).items()},
        json_body=json_body,
        allowed_hosts=[host],
        allowed_methods=[method],
        max_response_bytes=int(config.get("max_response_bytes", 65_536)),
        secret_headers=secret_headers,
    )


async def run_tool(tool: Tool, arguments: Any) -> ToolResult:
    started = time.perf_counter()

    def done(result: ToolResult) -> ToolResult:
        result.duration_ms = int((time.perf_counter() - started) * 1000)
        return result

    if tool.status != "active" or tool.archived_at is not None:
        return done(
            ToolResult(False, error_code="tool_disabled", error_message="This tool is disabled.")
        )
    if not isinstance(arguments, dict):
        return done(
            ToolResult(
                False,
                error_code="invalid_arguments",
                error_message="Arguments must be a JSON object.",
            )
        )
    errors = validate_arguments(tool.input_schema, arguments)
    if errors:
        return done(
            ToolResult(False, error_code="invalid_arguments", error_message="; ".join(errors))
        )
    try:
        async with asyncio.timeout(tool.timeout_ms / 1000):
            if tool.kind == "builtin":
                builtin = BUILTINS.get(tool.builtin_key or "")
                if builtin is None:
                    return done(
                        ToolResult(
                            False,
                            error_code="tool_unavailable",
                            error_message="Unknown built-in tool.",
                        )
                    )
                output = await builtin.run(arguments, tool.config or {})
            elif tool.kind == "http":
                output = await _run_http_tool(tool, arguments)
            elif tool.kind == "code":
                from gouvra.modules.tools.sandbox_client import run_code_tool

                output = await run_code_tool(tool, arguments)
            elif tool.kind == "connector":
                from gouvra.modules.connectors.runtime import run_connector_tool

                output = await run_connector_tool(tool, arguments)
            else:
                return done(
                    ToolResult(
                        False,
                        error_code="tool_unavailable",
                        error_message=f"Unsupported tool kind {tool.kind!r}.",
                    )
                )
    except ToolInputError as exc:
        return done(ToolResult(False, error_code="tool_error", error_message=str(exc)))
    except TimeoutError:
        return done(
            ToolResult(
                False,
                error_code="tool_timeout",
                error_message=f"The tool took longer than {tool.timeout_ms} ms.",
            )
        )
    except Exception:
        log.exception("tool_internal_error", tool=tool.name, kind=tool.kind)
        return done(
            ToolResult(
                False, error_code="tool_error", error_message="The tool failed unexpectedly."
            )
        )
    return done(ToolResult(True, output=output))
