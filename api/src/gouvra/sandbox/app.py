"""The sandbox's HTTP service: one authenticated endpoint that runs code, plus health checks."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, field_validator

from gouvra.core.logging import get_logger
from gouvra.sandbox import runner
from gouvra.sandbox.docker import DockerClient, DockerError
from gouvra.sandbox.settings import SandboxSettings, get_sandbox_settings

log = get_logger(__name__)

REAP_EVERY_S = 60
SLOT_WAIT_S = 10


class RunIn(BaseModel):
    language: Literal["python", "javascript"] = "python"
    source: Annotated[str, StringConstraints(min_length=1, max_length=runner.MAX_SOURCE_CHARS)]
    arguments: dict[str, Any] = Field(default_factory=dict)
    timeout_ms: int = Field(default=15_000, ge=100, le=120_000)
    network: bool = False
    memory_mb: int = Field(default=256, ge=64, le=1024)

    @field_validator("arguments")
    @classmethod
    def _small_arguments(cls, value: dict[str, Any]) -> dict[str, Any]:
        import json

        if len(json.dumps(value)) > runner.MAX_ARGUMENTS_BYTES:
            raise ValueError("arguments are larger than 64 KB")
        return value


class Sandbox:
    """Shared state of the service: the Docker client, run slots and image preparation."""

    def __init__(self, settings: SandboxSettings, docker: DockerClient) -> None:
        self.settings = settings
        self.docker = docker
        self.slots = asyncio.Semaphore(settings.max_concurrency)
        self.pulling: dict[str, asyncio.Task[None]] = {}

    def images(self) -> list[str]:
        return [self.settings.python_image, self.settings.node_image]

    def prepare(self, image: str) -> None:
        """Download an image in the background (once at a time)."""
        task = self.pulling.get(image)
        if task is None or task.done():
            self.pulling[image] = asyncio.create_task(self._pull(image))

    async def _pull(self, image: str) -> None:
        try:
            if not await self.docker.has_image(image):
                log.info("sandbox_image_pull", image=image)
                await self.docker.pull(image)
        except Exception:
            log.exception("sandbox_image_pull_failed", image=image)

    async def reaper(self) -> None:
        while True:
            with contextlib.suppress(Exception):
                if removed := await runner.reap(self.docker):
                    log.warning("sandbox_reaped", containers=removed)
            await asyncio.sleep(REAP_EVERY_S)


async def execute(sandbox: Sandbox, payload: RunIn) -> runner.RunResult:
    settings = sandbox.settings
    if payload.network and not settings.allow_network:
        return runner.RunResult(
            "error",
            error="Network access for code tools is disabled on this instance.",
            error_code="network_disabled",
        )
    image = runner.image_for(settings, payload.language)
    if not await sandbox.docker.has_image(image):
        sandbox.prepare(image)
        return runner.RunResult(
            "error",
            error="The sandbox is still downloading its runtime. Try again in a minute.",
            error_code="preparing",
        )
    try:
        await asyncio.wait_for(sandbox.slots.acquire(), timeout=SLOT_WAIT_S)
    except TimeoutError:
        return runner.RunResult(
            "error", error="The sandbox is busy. Try again shortly.", error_code="busy"
        )
    try:
        result = await runner.run(
            sandbox.docker, settings, runner.RunRequest(**payload.model_dump())
        )
    except DockerError:
        log.exception("sandbox_docker_error")
        result = runner.RunResult(
            "error", error="The sandbox could not start the code.", error_code="sandbox_error"
        )
    finally:
        sandbox.slots.release()
    log.info(
        "sandbox_run",
        language=payload.language,
        status=result.status,
        error_code=result.error_code,
        duration_ms=result.duration_ms,
    )
    return result


def create_sandbox_app(
    settings: SandboxSettings | None = None, docker: DockerClient | None = None
) -> FastAPI:
    settings = settings or get_sandbox_settings()
    token = settings.token.get_secret_value()
    if len(token) < 32:
        raise RuntimeError("SANDBOX_TOKEN must be set (at least 32 characters).")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = docker or DockerClient(settings.docker_url)
        sandbox = Sandbox(settings, client)
        app.state.sandbox = sandbox
        for image in sandbox.images():
            sandbox.prepare(image)
        reaper = asyncio.create_task(sandbox.reaper())
        try:
            yield
        finally:
            reaper.cancel()
            for task in [reaper, *sandbox.pulling.values()]:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            if docker is None:
                await client.aclose()

    app = FastAPI(
        title="Gouvra sandbox", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )

    def sandbox_of() -> Sandbox:
        current: Sandbox = app.state.sandbox
        return current

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        sandbox = sandbox_of()
        docker_ok = await sandbox.docker.ping()
        images = {
            image: docker_ok and await sandbox.docker.has_image(image) for image in sandbox.images()
        }
        ready = docker_ok and all(images.values())
        return JSONResponse(
            {"status": "ready" if ready else "starting", "docker": docker_ok, "images": images},
            status_code=200 if ready else 503,
        )

    @app.post("/v1/run")
    async def run(
        payload: RunIn, authorization: Annotated[str | None, Header()] = None
    ) -> dict[str, Any]:
        expected = f"Bearer {token}"
        if authorization is None or not hmac.compare_digest(
            authorization.encode(), expected.encode()
        ):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid sandbox token.")
        result = await execute(sandbox_of(), payload)
        return result.as_dict()

    return app
