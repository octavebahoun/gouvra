"""Client of the isolated sandbox service that runs code tools (never in the API or worker)."""

from __future__ import annotations

from typing import Any

import httpx

from gouvra.core.config import get_settings
from gouvra.modules.tools.builtins import ToolInputError
from gouvra.modules.tools.models import Tool


async def run_code_tool(tool: Tool, arguments: dict[str, Any]) -> Any:
    settings = get_settings()
    token = settings.sandbox_token.get_secret_value()
    if not token:
        raise ToolInputError("The code sandbox is not configured on this instance.")
    payload = {
        "language": tool.config.get("language", "python"),
        "source": tool.config.get("source", ""),
        "arguments": arguments,
        "timeout_ms": tool.timeout_ms,
        "network": bool(tool.config.get("network", False)),
        "memory_mb": int(tool.config.get("memory_mb", 256)),
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(tool.timeout_ms / 1000 + 10, connect=5)
        ) as client:
            response = await client.post(
                f"{settings.sandbox_url}/v1/run",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        raise ToolInputError("The code sandbox is unreachable.") from exc
    if response.status_code != 200:
        raise ToolInputError(f"The sandbox refused the run (HTTP {response.status_code}).")
    body = response.json()
    if body.get("status") != "ok":
        raise ToolInputError(str(body.get("error") or "The code failed.")[:2000])
    return body.get("result")
