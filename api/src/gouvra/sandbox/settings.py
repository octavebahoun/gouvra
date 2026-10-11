"""Sandbox settings — deliberately separate from the application's: this process holds no
database, session or encryption secret, only what it needs to run code."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class SandboxSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SANDBOX_", extra="ignore")

    token: SecretStr = SecretStr("")
    # unix:///var/run/docker.sock, or the socket proxy (http://docker-proxy:2375) in Compose.
    docker_url: str = "unix:///var/run/docker.sock"
    python_image: str = "python:3.13.15-alpine3.24"
    node_image: str = "node:24.21.0-alpine3.24"
    allow_network: bool = False
    runtime: str | None = Field(default=None, description="e.g. runsc (gVisor) when installed")
    max_concurrency: int = Field(default=4, ge=1, le=64)
    cpus: float = Field(default=1.0, gt=0, le=8)
    pids_limit: int = Field(default=64, ge=16, le=1024)
    tmp_size_mb: int = Field(default=16, ge=1, le=256)
    log_level: str = "INFO"
    log_format: Literal["json", "console"] = "json"


@lru_cache
def get_sandbox_settings() -> SandboxSettings:
    return SandboxSettings()
