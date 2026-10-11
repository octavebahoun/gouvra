"""Connector API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
ConnectionStatus = Literal["unverified", "ok", "error"]


class CredentialFieldOut(BaseModel):
    key: str
    label: str
    help: str
    placeholder: str
    required: bool


class OperationOut(BaseModel):
    key: str
    name: str
    description: str
    input_schema: dict[str, Any]
    writes: bool


class ConnectorOut(BaseModel):
    key: str
    name: str
    description: str
    category: str
    docs_url: str
    fields: list[CredentialFieldOut]
    operations: list[OperationOut]
    verifiable: bool = Field(
        description="Whether the credentials can be checked without side effects"
    )


class ConnectionCreateIn(BaseModel):
    connector: str = Field(max_length=32)
    name: Name
    credentials: dict[str, Annotated[str, StringConstraints(max_length=2048)]]


class ConnectionUpdateIn(BaseModel):
    name: Name | None = None
    credentials: dict[str, Annotated[str, StringConstraints(max_length=2048)]] | None = Field(
        default=None, description="Replaces every credential (they are never shown again)"
    )


class ConnectionToolOut(BaseModel):
    id: uuid.UUID
    name: str
    display_name: str
    operation: str
    status: str


class ConnectionOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    connector: str
    connector_name: str
    name: str
    secret_hint: str | None
    status: ConnectionStatus
    status_message: str | None
    last_checked_at: datetime | None
    tools: list[ConnectionToolOut]
    agent_count: int = Field(description="Agents allowed to use one of its tools")
    created_by: str | None
    created_at: datetime
    updated_at: datetime


class CheckOut(BaseModel):
    ok: bool
    status: ConnectionStatus
    message: str
