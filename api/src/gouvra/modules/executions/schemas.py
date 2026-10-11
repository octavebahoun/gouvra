"""Execution API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Status = Literal["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]


class ExecutionLaunchIn(BaseModel):
    input: str | dict[str, Any] = Field(description="Text, or a JSON object, given to the agent.")
    timeout_s: int | None = Field(
        default=None, ge=5, le=3600, description="Defaults to the agent's limit."
    )
    metadata: dict[str, str] = Field(default_factory=dict, max_length=20)


class ErrorOut(BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class CostOut(BaseModel):
    amount: Decimal | None
    currency: str | None
    source: Literal["provider_reported", "estimated", "unavailable"]
    partial: bool


class UsageOut(BaseModel):
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    total_tokens: int


class AgentRef(BaseModel):
    id: uuid.UUID
    name: str
    version: int | None


class ExecutionSummary(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    agent: AgentRef | None
    status: Status
    trigger: str
    triggered_by: str | None
    model: str | None
    provider_kind: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    duration_ms: int | None
    usage: UsageOut
    cost: CostOut
    error_code: str | None
    input_preview: str


class ExecutionOut(ExecutionSummary):
    input: dict[str, Any]
    output: dict[str, Any] | None
    error: ErrorOut | None
    timeout_s: int
    steps: int
    model_calls: int
    tool_calls: int
    attempt: int
    parent_execution_id: uuid.UUID | None
    cancel_requested_at: datetime | None
    last_event_seq: int
    metadata: dict[str, Any]


class ExecutionEventOut(BaseModel):
    seq: int
    type: str
    level: str
    step: int | None
    duration_ms: int | None
    data: dict[str, Any]
    created_at: datetime


class EventPage(BaseModel):
    data: list[ExecutionEventOut]
    next_after: int | None
    has_more: bool
