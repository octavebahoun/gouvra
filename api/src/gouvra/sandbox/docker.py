"""A minimal asynchronous client for the Docker Engine API — only the calls the sandbox needs.

Unversioned paths: the daemon answers with its own API version, which keeps working across
Docker releases that drop old API versions.
"""

from __future__ import annotations

import json
import struct
from typing import Any
from urllib.parse import quote

import httpx

MAX_LOG_BYTES = 2 * 1024 * 1024


class DockerError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"Docker API {status}: {message}")
        self.status = status


def demultiplex(raw: bytes) -> tuple[bytes, bytes]:
    """Split a non-TTY log stream into stdout and stderr (8-byte frame headers)."""
    stdout, stderr = bytearray(), bytearray()
    offset = 0
    while offset + 8 <= len(raw):
        kind = raw[offset]
        (size,) = struct.unpack(">I", raw[offset + 4 : offset + 8])
        chunk = raw[offset + 8 : offset + 8 + size]
        (stderr if kind == 2 else stdout).extend(chunk)
        offset += 8 + size
    return bytes(stdout), bytes(stderr)


class DockerClient:
    def __init__(self, url: str, *, timeout: float = 30.0) -> None:
        if url.startswith("unix://"):
            transport = httpx.AsyncHTTPTransport(uds=url.removeprefix("unix://"))
            base_url = "http://docker"
        else:
            transport = httpx.AsyncHTTPTransport()
            base_url = url.replace("tcp://", "http://", 1)
        self._http = httpx.AsyncClient(
            transport=transport, base_url=base_url, timeout=httpx.Timeout(timeout, connect=5.0)
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(
        self, method: str, path: str, *, ok: tuple[int, ...] = (200,), **kwargs: Any
    ) -> httpx.Response:
        response = await self._http.request(method, path, **kwargs)
        if response.status_code not in ok:
            try:
                message = response.json().get("message", response.text)
            except ValueError:
                message = response.text
            raise DockerError(response.status_code, str(message)[:500])
        return response

    async def ping(self) -> bool:
        try:
            return (await self._http.get("/_ping")).status_code == 200
        except httpx.HTTPError:
            return False

    async def has_image(self, image: str) -> bool:
        response = await self._http.get(f"/images/{quote(image, safe='')}/json")
        return response.status_code == 200

    async def pull(self, image: str, *, limit_s: float = 600.0) -> None:
        name, _, tag = image.rpartition(":")
        if not name or "/" in tag:  # no explicit tag (a registry port is not a tag)
            name, tag = image, "latest"
        async with self._http.stream(
            "POST",
            "/images/create",
            params={"fromImage": name, "tag": tag},
            timeout=httpx.Timeout(limit_s, connect=5.0),
        ) as response:
            if response.status_code != 200:
                raise DockerError(response.status_code, (await response.aread()).decode()[:500])
            async for line in response.aiter_lines():  # progress messages, then the outcome
                if line.strip() and "error" in (event := json.loads(line)):
                    raise DockerError(500, str(event["error"])[:500])

    async def create(self, spec: dict[str, Any]) -> str:
        response = await self._request("POST", "/containers/create", ok=(201,), json=spec)
        return str(response.json()["Id"])

    async def start(self, container_id: str) -> None:
        await self._request("POST", f"/containers/{container_id}/start", ok=(204, 304))

    async def wait(self, container_id: str, limit_s: float) -> int:
        """Exit code; raises TimeoutError when the container still runs after `limit_s`."""
        try:
            response = await self._request(
                "POST",
                f"/containers/{container_id}/wait",
                params={"condition": "not-running"},
                timeout=httpx.Timeout(limit_s, connect=5.0),
            )
        except httpx.ReadTimeout as exc:
            raise TimeoutError from exc
        return int(response.json().get("StatusCode", -1))

    async def kill(self, container_id: str) -> None:
        await self._request("POST", f"/containers/{container_id}/kill", ok=(204, 404, 409))

    async def inspect(self, container_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/containers/{container_id}/json")
        body: dict[str, Any] = response.json()
        return body

    async def logs(self, container_id: str) -> tuple[bytes, bytes]:
        raw = bytearray()
        async with self._http.stream(
            "GET",
            f"/containers/{container_id}/logs",
            params={"stdout": "true", "stderr": "true"},
        ) as response:
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > MAX_LOG_BYTES:
                    break
        return demultiplex(bytes(raw))

    async def remove(self, container_id: str) -> None:
        await self._request(
            "DELETE", f"/containers/{container_id}", ok=(204, 404, 409), params={"force": "true"}
        )

    async def containers(self, label: str) -> list[dict[str, Any]]:
        response = await self._request(
            "GET",
            "/containers/json",
            params={"all": "true", "filters": json.dumps({"label": [label]})},
        )
        body: list[dict[str, Any]] = response.json()
        return body
