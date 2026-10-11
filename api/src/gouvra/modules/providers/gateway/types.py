"""Provider-neutral contract of the ModelGateway.

The execution engine only speaks these types; each adapter translates them to and from its
provider's wire format, normalising messages, tool calls, usage, finish reasons and errors.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal, Protocol

Role = Literal["system", "user", "assistant", "tool"]
Reasoning = Literal["auto", "off", "low", "medium", "high", "max"]
FinishReason = Literal["stop", "length", "tool_calls", "content_filter", "refusal", "other"]


@dataclass
class ToolCall:
    id: str
    name: str
    # Raw JSON produced by the model. It may be invalid: the engine validates it.
    arguments: str


@dataclass
class ChatMessage:
    role: Role
    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    tool_name: str | None = None
    is_error: bool = False
    # Opaque provider-native payload replayed verbatim by the adapter that produced it
    # (e.g. Anthropic content blocks with thinking, DeepSeek reasoning_content).
    provider_state: Any = None
    provider_kind: str | None = None


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ChatRequest:
    model: str
    messages: list[ChatMessage]
    tools: list[ToolSpec] = field(default_factory=list)
    temperature: float | None = None
    top_p: float | None = None
    max_output_tokens: int | None = None
    response_format: Literal["text", "json"] = "text"
    reasoning: Reasoning = "auto"
    stop: list[str] | None = None
    timeout_s: float = 120.0
    end_user_id: str | None = None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    provider_cost: Decimal | None = None
    provider_cost_currency: str | None = None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class ChatResponse:
    content: str
    reasoning: str | None
    tool_calls: list[ToolCall]
    finish_reason: FinishReason
    raw_finish_reason: str | None
    usage: Usage
    model: str
    provider_request_id: str | None
    latency_ms: int
    attempts: int = 1
    provider_state: Any = None
    refusal_category: str | None = None


@dataclass(frozen=True)
class StreamDelta:
    kind: Literal["text", "reasoning", "tool_call"]
    text: str


OnDelta = Callable[[StreamDelta], Awaitable[None]]


class GatewayErrorCode(StrEnum):
    AUTH = "provider_auth_error"
    PERMISSION = "provider_permission_denied"
    RATE_LIMITED = "provider_rate_limited"
    QUOTA = "provider_quota_exhausted"
    UNAVAILABLE = "provider_unavailable"
    TIMEOUT = "provider_timeout"
    NETWORK = "provider_network_error"
    BAD_REQUEST = "provider_bad_request"
    MODEL_NOT_FOUND = "model_not_found"
    CONTEXT_LENGTH = "context_length_exceeded"
    CONTENT_FILTERED = "content_filtered"
    INVALID_RESPONSE = "provider_invalid_response"
    MISCONFIGURED = "provider_misconfigured"


RETRYABLE = frozenset(
    {
        GatewayErrorCode.RATE_LIMITED,
        GatewayErrorCode.UNAVAILABLE,
        GatewayErrorCode.TIMEOUT,
        GatewayErrorCode.NETWORK,
    }
)


class GatewayError(Exception):
    """Normalised provider failure. `message` is safe to show (never contains the API key)."""

    def __init__(
        self,
        code: GatewayErrorCode,
        message: str,
        *,
        status_code: int | None = None,
        provider_request_id: str | None = None,
        retry_after_s: float | None = None,
        attempts: int = 1,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.provider_request_id = provider_request_id
        self.retry_after_s = retry_after_s
        self.attempts = attempts

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "retryable": self.retryable,
            "status_code": self.status_code,
            "provider_request_id": self.provider_request_id,
            "attempts": self.attempts,
        }


@dataclass(frozen=True)
class ConnectionTest:
    ok: bool
    latency_ms: int
    models: list[str]
    error: GatewayError | None = None


class ModelAdapter(Protocol):
    kind: str

    async def chat(self, request: ChatRequest, on_delta: OnDelta | None = None) -> ChatResponse:
        """One model turn. Streams deltas through `on_delta` when given."""
        ...

    async def list_models(self) -> list[str]: ...

    async def aclose(self) -> None: ...
