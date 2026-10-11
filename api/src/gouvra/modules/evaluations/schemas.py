"""Evaluation API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

from gouvra.modules.evaluations.graders import GraderSpec

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
CaseName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MAX_CASES = 500
Change = Literal["improved", "regressed", "unchanged", "new", "removed", "pending"]


class SuiteCreateIn(BaseModel):
    name: Name
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""
    agent_id: uuid.UUID | None = None
    default_graders: list[GraderSpec] = Field(default_factory=list, max_length=10)
    pass_threshold: float = Field(default=1.0, ge=0, le=1)


class SuiteUpdateIn(BaseModel):
    name: Name | None = None
    description: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None
    ) = None
    agent_id: uuid.UUID | None = None
    default_graders: list[GraderSpec] | None = Field(default=None, max_length=10)
    pass_threshold: float | None = Field(default=None, ge=0, le=1)


class CaseIn(BaseModel):
    name: CaseName
    input: str | dict[str, Any]
    expected: str | dict[str, Any] | None = None
    graders: list[GraderSpec] | None = Field(default=None, max_length=10)
    tags: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    ] = Field(default_factory=list, max_length=10)


class CaseUpdateIn(BaseModel):
    name: CaseName | None = None
    input: str | dict[str, Any] | None = None
    expected: str | dict[str, Any] | None = None
    graders: list[GraderSpec] | None = Field(default=None, max_length=10)
    tags: (
        list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]]
        | None
    ) = None
    position: int | None = Field(default=None, ge=0)


class CaseImportIn(BaseModel):
    cases: list[CaseIn] = Field(min_length=1, max_length=MAX_CASES)
    replace: bool = False


class CaseOut(BaseModel):
    id: uuid.UUID
    suite_id: uuid.UUID
    name: str
    input: dict[str, Any]
    expected: dict[str, Any] | None
    graders: list[dict[str, Any]] | None
    tags: list[str]
    position: int
    created_at: datetime
    updated_at: datetime


class RunSummary(BaseModel):
    cases: int = 0
    pending: int = 0
    passed: int = 0
    failed: int = 0
    errored: int = 0
    cancelled: int = 0
    pass_rate: float | None = None
    avg_score: float | None = None
    cost_amount: Decimal | None = None
    cost_currency: str | None = None
    cost_source: Literal["provider_reported", "estimated", "unavailable"] = "unavailable"
    cost_partial: bool = False
    judge_cost_amount: Decimal | None = None
    avg_duration_ms: int | None = None
    p95_duration_ms: int | None = None
    input_tokens: int = 0
    output_tokens: int = 0


class SuiteOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    description: str
    agent_id: uuid.UUID | None
    agent_name: str | None
    default_graders: list[dict[str, Any]]
    pass_threshold: float
    case_count: int
    last_run: RunSummaryRef | None
    archived: bool
    created_at: datetime
    updated_at: datetime


class RunSummaryRef(BaseModel):
    id: uuid.UUID
    label: str
    status: str
    pass_rate: float | None
    created_at: datetime


class RunCreateIn(BaseModel):
    suite_id: uuid.UUID
    agent_id: uuid.UUID
    agent_version: int | None = Field(
        default=None, ge=1, description="Defaults to the current version"
    )
    model: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
        | None
    ) = None
    provider_id: uuid.UUID | None = None
    instructions: Annotated[str, StringConstraints(max_length=32_000)] | None = None
    label: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
        | None
    ) = None


class ResultOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID | None
    case_name: str
    execution_id: uuid.UUID | None
    status: str
    score: float | None
    grader_results: list[dict[str, Any]]
    output_text: str | None
    error: dict[str, Any] | None
    duration_ms: int | None
    cost_amount: Decimal | None
    cost_source: str


class RunOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    suite_id: uuid.UUID
    suite_name: str
    label: str
    status: Literal["running", "completed", "cancelled", "failed"]
    agent_id: uuid.UUID | None
    agent_name: str | None
    agent_version: int | None
    model: str | None
    overrides: dict[str, Any]
    pass_threshold: float
    summary: RunSummary
    created_by: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class RunDetailOut(RunOut):
    results: list[ResultOut]


class CaseComparison(BaseModel):
    case_id: uuid.UUID | None
    case_name: str
    base: ResultOut | None
    candidate: ResultOut | None
    change: Change
    score_delta: float | None


class ComparisonOut(BaseModel):
    base: RunOut
    candidate: RunOut
    pass_rate_delta: float | None
    avg_score_delta: float | None
    cost_delta: Decimal | None
    avg_duration_delta_ms: int | None
    improved: int
    regressed: int
    unchanged: int
    cases: list[CaseComparison]


class GraderPreviewIn(BaseModel):
    grader: GraderSpec
    output: str = Field(max_length=100_000)
    expected: str | dict[str, Any] | None = None


SuiteOut.model_rebuild()
