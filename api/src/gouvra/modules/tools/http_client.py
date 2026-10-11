"""SSRF-hardened outbound HTTP for tools.

Defences: host allow-list, scheme and port restrictions, DNS resolution checked against
private/loopback/link-local/metadata ranges, connection *pinned* to the vetted IP (no DNS
rebinding between check and use), redirects re-validated hop by hop, response size and time
limits, hop-by-hop and credential headers stripped from what the model may set.
"""

from __future__ import annotations

import fnmatch
import json
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from gouvra.core.config import get_settings
from gouvra.core.netguard import BlockedDestination, resolve_public
from gouvra.modules.tools.builtins import ToolInputError

MAX_REDIRECTS = 3
ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})
_FORBIDDEN_HEADERS = frozenset(
    {
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "cookie",
        "te",
        "trailer",
        "keep-alive",
    }
)
TIMEOUT = httpx.Timeout(15.0, connect=5.0)


def host_allowed(host: str, allowed: list[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(fnmatch.fnmatchcase(host, pattern.lower().rstrip(".")) for pattern in allowed)


async def _vet(url: str, allowed_hosts: list[str] | None) -> tuple[httpx.URL, str, str]:
    """Return (url pinned to the vetted IP, original host, scheme) or raise ToolInputError."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ToolInputError("Only http and https URLs are allowed.")
    host = parts.hostname or ""
    if not host:
        raise ToolInputError("The URL has no host.")
    if parts.username or parts.password:
        raise ToolInputError("Credentials in URLs are not allowed.")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise ToolInputError(f"Port {port} is not allowed.")
    if allowed_hosts is not None and not host_allowed(host, allowed_hosts):
        raise ToolInputError(f"Host {host} is not in this tool's allow-list.")
    try:
        addresses = await resolve_public(
            host, port, allow_private=get_settings().http_tool_allow_private_networks
        )
    except BlockedDestination as exc:
        raise ToolInputError(
            f"Host {host} resolves to a private or reserved address."
            if exc.reason == "private_address"
            else f"Host {host} does not resolve."
        ) from exc
    ip = addresses[0]
    netloc_ip = f"[{ip}]" if ":" in ip else ip
    if parts.port:
        netloc_ip = f"{netloc_ip}:{parts.port}"
    pinned = urlunsplit((parts.scheme, netloc_ip, parts.path or "/", parts.query, ""))
    return httpx.URL(pinned), host, parts.scheme


def _clean_headers(headers: dict[str, str]) -> dict[str, str]:
    return {
        k: v
        for k, v in headers.items()
        if k.lower() not in _FORBIDDEN_HEADERS and "\n" not in v and "\r" not in v
    }


async def fetch(  # noqa: PLR0915 - linear sequence of security checks
    *,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    content: bytes | None = None,
    allowed_hosts: list[str] | None,
    allowed_methods: list[str] | None = None,
    max_response_bytes: int = 65_536,
    secret_headers: dict[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    method = method.upper()
    if allowed_methods is not None and method not in allowed_methods:
        raise ToolInputError(f"Method {method} is not allowed for this tool.")
    request_headers = _clean_headers(headers or {})
    request_headers.update(secret_headers or {})  # injected server-side, never shown to the model
    owns = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, trust_env=False)
    current, hops = url, 0
    try:
        while True:
            pinned, host, scheme = await _vet(current, allowed_hosts)
            send_headers = {**request_headers, "Host": host, "User-Agent": "Gouvra-Tool/1.0"}
            extensions = {"sni_hostname": host} if scheme == "https" else {}
            body_kwargs: dict[str, Any] = {}
            if json_body is not None and method in ("POST", "PUT", "PATCH"):
                body_kwargs["content"] = json.dumps(json_body).encode()
                send_headers.setdefault("Content-Type", "application/json")
            elif content is not None and method in ("POST", "PUT", "PATCH"):
                body_kwargs["content"] = content
            request = http.build_request(
                method, pinned, headers=send_headers, extensions=extensions, **body_kwargs
            )
            try:
                response = await http.send(request, stream=True)
            except httpx.TimeoutException as exc:
                raise ToolInputError(f"{host} did not answer in time.") from exc
            except httpx.HTTPError as exc:
                raise ToolInputError(f"Could not reach {host} ({type(exc).__name__}).") from exc
            try:
                if response.is_redirect and hops < MAX_REDIRECTS:
                    location = response.headers.get("location", "")
                    hops += 1
                    current = urljoin(current, location)
                    if response.status_code in (301, 302, 303):
                        method, json_body, content = "GET", None, None
                    continue
                chunks: list[bytes] = []
                size = 0
                truncated = False
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_response_bytes:
                        chunks.append(chunk[: max(0, max_response_bytes - (size - len(chunk)))])
                        truncated = True
                        break
                    chunks.append(chunk)
                raw = b"".join(chunks)
                content_type = response.headers.get("content-type", "")
                body: Any
                if "json" in content_type and not truncated:
                    try:
                        body = json.loads(
                            raw.decode(response.encoding or "utf-8", errors="replace")
                        )
                    except ValueError:
                        body = raw.decode("utf-8", errors="replace")
                else:
                    body = raw.decode(response.encoding or "utf-8", errors="replace")
                return {
                    "status": response.status_code,
                    "ok": response.is_success,
                    "content_type": content_type,
                    "body": body,
                    "truncated": truncated,
                    "url": current,
                }
            finally:
                await response.aclose()
    finally:
        if owns:
            await http.aclose()
