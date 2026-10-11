"""Agent API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

AgentName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
MAX_INSTRUCTIONS = 32_000


class AgentParameters(BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    max_output_tokens: int | None = Field(default=None, ge=1, le=400_000)
    reasoning: Literal["auto", "off", "low", "medium", "high", "max"] = "auto"
    response_format: Literal["text", "json"] = "text"


class AgentLimits(BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    max_steps: int = Field(default=8, ge=1, le=50, description="Model turns per execution")
    max_tool_calls: int = Field(default=20, ge=0, le=200)
    timeout_s: int = Field(default=120, ge=5, le=3600)
    max_total_tokens: int | None = Field(default=None, ge=100, le=10_000_000)
    max_cost_usd: Decimal | None = Field(default=None, gt=0, le=1000)


class AgentConfigIn(BaseModel):
    instructions: Annotated[str, StringConstraints(max_length=MAX_INSTRUCTIONS)] = ""
    provider_id: uuid.UUID | None = None
    model: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
        | None
    ) = None
    parameters: AgentParameters = Field(default_factory=AgentParameters)
    tool_ids: list[uuid.UUID] = Field(default_factory=list, max_length=64)
    limits: AgentLimits = Field(default_factory=AgentLimits)


class AgentCreateIn(AgentConfigIn):
    name: AgentName
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""


class AgentUpdateIn(BaseModel):
    name: AgentName | None = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = (
        None
    )
    instructions: Annotated[str, StringConstraints(max_length=MAX_INSTRUCTIONS)] | None = None
    provider_id: uuid.UUID | None = None
    model: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
        | None
    ) = None
    parameters: AgentParameters | None = None
    tool_ids: list[uuid.UUID] | None = Field(default=None, max_length=64)
    limits: AgentLimits | None = None
    change_note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=280)] | None = (
        None
    )


class AgentDuplicateIn(BaseModel):
    name: AgentName | None = None


class ToolRef(BaseModel):
    id: uuid.UUID
    name: str
    display_name: str
    available: bool


class AgentVersionOut(BaseModel):
    id: uuid.UUID
    number: int
    instructions: str
    provider_id: uuid.UUID | None
    provider_name: str | None
    provider_kind: str | None
    model: str
    parameters: AgentParameters
    tools: list[ToolRef]
    limits: AgentLimits
    change_note: str | None
    created_by: str | None
    created_at: datetime
    is_current: bool


class LastExecution(BaseModel):
    id: uuid.UUID
    status: str
    created_at: datetime
    duration_ms: int | None


class AgentOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str
    status: Literal["active", "archived"]
    version: AgentVersionOut | None
    latest_version_number: int
    last_execution: LastExecution | None
    executions_30d: int
    ready: bool
    readiness_issues: list[str]
    created_at: datetime
    updated_at: datetime
