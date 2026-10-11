"""Provider API contracts. Secrets are write-only: they are accepted, never returned."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

ProviderKindName = Literal["deepseek", "anthropic", "openai_compatible", "test"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
ApiKey = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)]
ModelId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class ProviderCreateIn(BaseModel):
    name: Name
    kind: ProviderKindName
    base_url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    api_key: ApiKey | None = Field(
        default=None, description="Write-only. Stored encrypted, never returned."
    )
    default_model: ModelId | None = None


class ProviderUpdateIn(BaseModel):
    name: Name | None = None
    base_url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    api_key: ApiKey | None = Field(default=None, description="Write-only. Replaces the stored key.")
    default_model: ModelId | None = None


class ProviderErrorOut(BaseModel):
    code: str
    message: str


class ProviderOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    kind: str
    kind_label: str
    base_url: str | None
    secret_set: bool
    secret_hint: str | None = Field(description="Last characters of the key, e.g. '••••a1b2'.")
    secret_updated_at: datetime | None
    default_model: str | None
    status: Literal["untested", "ok", "error"]
    last_tested_at: datetime | None
    last_test_latency_ms: int | None
    last_error: ProviderErrorOut | None
    models: list[str]
    models_fetched_at: datetime | None
    agent_count: int
    created_at: datetime
    updated_at: datetime


class PriceOut(BaseModel):
    input: Decimal
    output: Decimal
    cached_input: Decimal | None


class PricingOut(BaseModel):
    currency: str
    standard: PriceOut
    peak: PriceOut | None
    peak_hours_utc: str | None
    source_url: str
    as_of: date
    notes: str


class ModelInfoOut(BaseModel):
    id: str
    display_name: str
    context_window: int
    max_output_tokens: int
    supports_tools: bool
    supports_json: bool
    supports_vision: bool
    reasoning: Literal["none", "optional", "always"]
    recommended: bool
    tags: list[str]
    pricing: PricingOut | None


class PresetOut(BaseModel):
    label: str
    base_url: str


class ProviderKindOut(BaseModel):
    kind: str
    label: str
    requires_api_key: bool
    requires_base_url: bool
    default_base_url: str | None
    docs_url: str
    presets: list[PresetOut]
    models: list[ModelInfoOut]


class ConnectionTestOut(BaseModel):
    ok: bool
    latency_ms: int
    models: list[str]
    error: ProviderErrorOut | None
    tested_at: datetime


def error_out(raw: dict[str, Any] | None) -> ProviderErrorOut | None:
    if not raw:
        return None
    return ProviderErrorOut(
        code=str(raw.get("code", "unknown")), message=str(raw.get("message", ""))
    )
