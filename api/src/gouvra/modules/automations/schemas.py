"""Automation API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Cron = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Template = Annotated[str, StringConstraints(max_length=20_000)]
Kind = Literal["schedule", "webhook"]
TargetType = Literal["agent", "workflow"]
Overlap = Literal["skip", "allow"]
SignatureFormat = Literal["gouvra", "github"]
FireSource = Literal["schedule", "webhook", "manual", "test"]
FireState = Literal["pending", "launched", "skipped", "rejected", "failed"]


class AutomationCreateIn(BaseModel):
    name: Name
    description: Description = ""
    kind: Kind
    target_type: TargetType
    agent_id: uuid.UUID | None = None
    workflow_id: uuid.UUID | None = None
    input: str | dict[str, Any] | None = Field(
        default=None, description="Schedules: the input of every run"
    )
    input_template: Template | None = Field(
        default=None,
        description="Webhooks: build the run input from the payload, e.g. {{input.ticket.title}}",
    )
    cron: Cron | None = Field(
        default=None, description="Five-field cron expression, e.g. 0 9 * * 1-5"
    )
    timezone: str = Field(default="UTC", max_length=64, description="IANA time zone")
    overlap: Overlap | None = Field(
        default=None,
        description="skip: no new run while one is running (default for schedules); "
        "allow: every delivery runs (default for webhooks)",
    )
    signature_format: SignatureFormat = "gouvra"
    enabled: bool = True


class AutomationUpdateIn(BaseModel):
    name: Name | None = None
    description: Description | None = None
    target_type: TargetType | None = None
    agent_id: uuid.UUID | None = None
    workflow_id: uuid.UUID | None = None
    input: str | dict[str, Any] | None = None
    input_template: Template | None = None
    cron: Cron | None = None
    timezone: str | None = Field(default=None, max_length=64)
    overlap: Overlap | None = None
    signature_format: SignatureFormat | None = None
    enabled: bool | None = None


class FireOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    source: FireSource
    status: FireState
    reason: dict[str, Any] | None
    scheduled_for: datetime | None
    delivery_id: str | None
    execution_id: uuid.UUID | None
    workflow_run_id: uuid.UUID | None
    run_status: str | None = Field(default=None, description="State of the run it started")
    payload_preview: str | None
    request_meta: dict[str, Any] | None
    created_at: datetime


class AutomationOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str
    kind: Kind
    target_type: TargetType
    agent_id: uuid.UUID | None
    workflow_id: uuid.UUID | None
    target_name: str | None
    target_problem: str | None = Field(description="Why the target cannot run, if it cannot")
    input: dict[str, Any] | None
    input_template: str | None
    enabled: bool
    paused_reason: str | None
    cron: str | None
    timezone: str | None
    next_run_at: datetime | None
    upcoming: list[datetime] = Field(default_factory=list, description="Next scheduled runs")
    overlap: Overlap
    hook_url: str | None
    signature_format: SignatureFormat
    secret_hint: str | None
    last_fired_at: datetime | None
    last_status: FireState | None
    fire_count: int
    consecutive_failures: int
    created_by: str | None
    created_at: datetime
    updated_at: datetime


class AutomationCreatedOut(AutomationOut):
    secret: str | None = Field(description="Webhooks only: shown once, store it now")


class SecretOut(BaseModel):
    secret: str = Field(description="Shown once: the previous secret stops working now")
    secret_hint: str


class TestFireIn(BaseModel):
    input: str | dict[str, Any] | None = Field(
        default=None, description="Schedules: override the input; webhooks: the sample payload"
    )


class HookAcceptedOut(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    delivery_id: str
    fire_id: uuid.UUID
    status: FireState
    duplicate: bool = False
    execution_id: uuid.UUID | None
    workflow_run_id: uuid.UUID | None


class CronPreviewIn(BaseModel):
    cron: Cron
    timezone: str = Field(default="UTC", max_length=64)


class CronPreviewOut(BaseModel):
    valid: bool
    message: str | None
    upcoming: list[datetime]
