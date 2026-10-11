"""Workflow API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

from gouvra.modules.workflows.graph import Graph

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
CostSource = Literal["provider_reported", "estimated", "unavailable"]


class WorkflowCreateIn(BaseModel):
    name: Name
    description: Description = ""
    graph: Graph | None = Field(default=None, description="Defaults to input → output")


class WorkflowUpdateIn(BaseModel):
    name: Name | None = None
    description: Description | None = None


class WorkflowDraftIn(BaseModel):
    graph: Graph
    revision: int = Field(ge=1, description="The draft revision this edit started from")


class WorkflowPublishIn(BaseModel):
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=280)] | None = None


class WorkflowIssueOut(BaseModel):
    code: str
    message: str
    severity: Literal["error", "warning"]
    node_id: str | None
    edge_id: str | None


class WorkflowRunRef(BaseModel):
    id: uuid.UUID
    status: str
    created_at: datetime


class WorkflowSummary(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str
    current_version: int | None
    has_unpublished_changes: bool
    node_count: int
    agent_count: int
    last_run: WorkflowRunRef | None
    archived: bool
    created_at: datetime
    updated_at: datetime


class WorkflowOut(WorkflowSummary):
    draft: dict[str, Any]
    draft_revision: int
    issues: list[WorkflowIssueOut]
    can_publish: bool


class WorkflowVersionOut(BaseModel):
    number: int
    note: str | None
    graph: dict[str, Any]
    created_by: str | None
    created_at: datetime
    is_current: bool


class WorkflowRunCreateIn(BaseModel):
    input: str | dict[str, Any]
    version: int | None = Field(default=None, ge=1, description="Defaults to the current version")
    draft: bool = Field(default=False, description="Test the unpublished draft instead")


class WorkflowStepOut(BaseModel):
    id: uuid.UUID
    node_id: str
    node_type: str
    label: str
    position: int
    status: str
    input: Any | None
    output: dict[str, Any] | None
    error: dict[str, Any] | None
    branch: str | None
    execution_id: uuid.UUID | None
    attempt: int
    started_at: datetime | None
    finished_at: datetime | None
    duration_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_amount: Decimal | None
    cost_source: CostSource


class WorkflowRunSummaryOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    workflow_id: uuid.UUID | None
    workflow_name: str
    version: int | None
    trigger: str
    status: str
    input_preview: str
    error: dict[str, Any] | None
    steps_total: int
    steps_done: int
    duration_ms: int | None
    cost_amount: Decimal | None
    cost_source: CostSource
    cost_partial: bool
    created_by: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class WorkflowRunOut(WorkflowRunSummaryOut):
    input: dict[str, Any]
    output: dict[str, Any] | None
    graph: dict[str, Any]
    timeout_s: int
    deadline_at: datetime
    input_tokens: int
    output_tokens: int
    cancel_requested_at: datetime | None
    steps: list[WorkflowStepOut]
