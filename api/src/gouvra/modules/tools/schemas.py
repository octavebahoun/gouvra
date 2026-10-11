"""Tool API contracts. Tool secrets are write-only."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

Identifier = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z][a-z0-9_]{1,63}$")
]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
]


class HttpAuth(BaseModel):
    type: Literal["none", "bearer", "header"] = "none"
    header_name: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9-]{1,64}$")] | None = None


class HttpToolConfig(BaseModel):
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "GET"
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=8, max_length=2048)]
    headers: dict[
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9-]{1,64}$")],
        Annotated[str, StringConstraints(max_length=1024)],
    ] = Field(default_factory=dict)
    auth: HttpAuth = Field(default_factory=HttpAuth)
    max_response_bytes: int = Field(default=65_536, ge=1024, le=1_048_576)


class CodeToolConfig(BaseModel):
    language: Literal["python", "javascript"] = "python"
    source: Annotated[str, StringConstraints(min_length=1, max_length=50_000)]
    network: bool = False
    memory_mb: int = Field(default=256, ge=64, le=1024)


class ToolCreateIn(BaseModel):
    kind: Literal["builtin", "http", "code"]
    builtin_key: str | None = None
    name: Identifier | None = None
    display_name: DisplayName | None = None
    description: Description | None = None
    input_schema: dict[str, Any] | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    secret: Annotated[str, StringConstraints(min_length=1, max_length=4096)] | None = Field(
        default=None, description="Write-only credential (HTTP tools)."
    )
    timeout_ms: int = Field(default=15_000, ge=1_000, le=120_000)


class ToolUpdateIn(BaseModel):
    name: Identifier | None = None
    display_name: DisplayName | None = None
    description: Description | None = None
    input_schema: dict[str, Any] | None = None
    config: dict[str, Any] | None = None
    secret: Annotated[str, StringConstraints(min_length=1, max_length=4096)] | None = None
    clear_secret: bool = False
    timeout_ms: int | None = Field(default=None, ge=1_000, le=120_000)
    status: Literal["active", "disabled"] | None = None


class ToolOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    display_name: str
    description: str
    kind: str
    builtin_key: str | None
    input_schema: dict[str, Any]
    config: dict[str, Any]
    secret_set: bool
    secret_hint: str | None
    status: str
    timeout_ms: int
    uses_network: bool
    agent_count: int
    created_at: datetime
    updated_at: datetime


class BuiltinToolOut(BaseModel):
    key: str
    name: str
    display_name: str
    description: str
    input_schema: dict[str, Any]
    config_schema: dict[str, Any]
    uses_network: bool


class ToolTestIn(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolTestOut(BaseModel):
    ok: bool
    output: Any = None
    error_code: str | None = None
    error_message: str | None = None
    duration_ms: int
    truncated: bool
