"""Anthropic Messages API adapter (official `anthropic` SDK)."""

from __future__ import annotations

import json
import time
from typing import Any

import anthropic

from gouvra.modules.providers.catalog import ModelInfo, find_model
from gouvra.modules.providers.gateway.types import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    FinishReason,
    GatewayError,
    GatewayErrorCode,
    OnDelta,
    StreamDelta,
    ToolCall,
    Usage,
)

DEFAULT_MAX_TOKENS = 16000
JSON_INSTRUCTION = "Respond with a single valid JSON object and nothing else."

_STOP: dict[str, FinishReason] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "refusal",
}


def _blocks_for_replay(message: ChatMessage) -> list[dict[str, Any]]:
    """Assistant turn as content blocks. Our own previous output is replayed unchanged
    (thinking blocks included, as the API requires when continuing on the same model)."""
    if message.provider_kind == "anthropic" and isinstance(message.provider_state, list):
        return list(message.provider_state)
    blocks: list[dict[str, Any]] = []
    if message.content:
        blocks.append({"type": "text", "text": message.content})
    for call in message.tool_calls:
        try:
            arguments = json.loads(call.arguments or "{}")
        except json.JSONDecodeError:
            arguments = {}
        blocks.append(
            {
                "type": "tool_use",
                "id": call.id,
                "name": call.name,
                "input": arguments if isinstance(arguments, dict) else {},
            }
        )
    return blocks or [{"type": "text", "text": ""}]


def convert_messages(messages: list[ChatMessage]) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    converted: list[dict[str, Any]] = []
    pending_results: list[dict[str, Any]] = []

    def flush_results() -> None:
        if pending_results:
            # All results of one assistant turn go back in a single user message.
            converted.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for message in messages:
        if message.role == "system":
            system_parts.append(message.content or "")
        elif message.role == "tool":
            pending_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id or "",
                    "content": message.content or "",
                    "is_error": message.is_error,
                }
            )
        else:
            flush_results()
            if message.role == "assistant":
                converted.append({"role": "assistant", "content": _blocks_for_replay(message)})
            else:
                converted.append({"role": "user", "content": message.content or ""})
    flush_results()
    return ("\n\n".join(p for p in system_parts if p) or None), converted


def reasoning_params(info: ModelInfo | None, reasoning: str) -> dict[str, Any]:
    """Translate the provider-neutral reasoning level into this model's thinking/effort fields."""
    if info is None or info.reasoning == "none":
        return {}
    params: dict[str, Any] = {}
    if reasoning == "off":
        if info.thinking_off == "disabled":
            params["thinking"] = {"type": "disabled"}
        elif info.thinking_off == "between_tools":
            params["thinking"] = {"type": "between_tools"}
        elif info.supports_effort:
            params["output_config"] = {"effort": "low"}  # thinking cannot be turned off
        return params
    if reasoning in ("low", "medium", "high", "max"):
        if info.thinking_style == "budget":
            budget = {"low": 2048, "medium": 4096, "high": 8192, "max": 16384}[reasoning]
            params["thinking"] = {"type": "enabled", "budget_tokens": budget}
        else:
            params["thinking"] = {"type": "adaptive", "display": "summarized"}
            if info.supports_effort:
                params["output_config"] = {"effort": reasoning}
        return params
    # "auto": the model's own default, but ask for a readable summary when it thinks.
    if info.thinking_style in ("adaptive_default", "adaptive_opt_in"):
        params["thinking"] = {"type": "adaptive", "display": "summarized"}
    return params


class AnthropicAdapter:
    kind = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        timeout_s: float = 120.0,
        client: anthropic.AsyncAnthropic | None = None,
    ) -> None:
        self._client = client or anthropic.AsyncAnthropic(
            api_key=api_key, base_url=base_url or None, timeout=timeout_s, max_retries=2
        )

    async def aclose(self) -> None:
        await self._client.close()

    def build_params(self, request: ChatRequest) -> dict[str, Any]:
        info = find_model("anthropic", request.model)
        system, messages = convert_messages(request.messages)
        if request.response_format == "json":
            system = f"{system}\n\n{JSON_INSTRUCTION}" if system else JSON_INSTRUCTION
        params: dict[str, Any] = {
            "model": request.model,
            "max_tokens": request.max_output_tokens
            or (min(DEFAULT_MAX_TOKENS, info.max_output_tokens) if info else DEFAULT_MAX_TOKENS),
            "messages": messages,
        }
        if system:
            params["system"] = system
        if request.tools:
            params["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters}
                for t in request.tools
            ]
        if info is None or info.supports_sampling:
            if request.temperature is not None:
                params["temperature"] = request.temperature
            if request.top_p is not None:
                params["top_p"] = request.top_p
        if request.stop:
            params["stop_sequences"] = request.stop
        if request.end_user_id:
            params["metadata"] = {"user_id": request.end_user_id}
        params.update(reasoning_params(info, request.reasoning))
        return params

    @staticmethod
    def _error(exc: Exception) -> GatewayError:
        request_id: str | None = None
        status: int | None = None
        if isinstance(exc, anthropic.APIStatusError):
            status = exc.status_code
            request_id = exc.response.headers.get("request-id")
        message = getattr(exc, "message", None) or str(exc) or type(exc).__name__
        message = str(message)[:300]
        if isinstance(exc, anthropic.APITimeoutError):
            return GatewayError(GatewayErrorCode.TIMEOUT, "The provider did not answer in time.")
        if isinstance(exc, anthropic.APIConnectionError):
            return GatewayError(GatewayErrorCode.NETWORK, "Could not reach the provider.")
        if isinstance(exc, anthropic.AuthenticationError):
            code = GatewayErrorCode.AUTH
        elif isinstance(exc, anthropic.PermissionDeniedError):
            code = GatewayErrorCode.PERMISSION
        elif isinstance(exc, anthropic.NotFoundError):
            code = GatewayErrorCode.MODEL_NOT_FOUND
        elif isinstance(exc, anthropic.RateLimitError):
            code = GatewayErrorCode.RATE_LIMITED
        elif isinstance(exc, anthropic.BadRequestError):
            lowered = message.lower()
            code = (
                GatewayErrorCode.CONTEXT_LENGTH
                if "too long" in lowered or "context" in lowered
                else GatewayErrorCode.BAD_REQUEST
            )
        elif isinstance(exc, anthropic.APIStatusError) and (status or 0) >= 500:
            code = GatewayErrorCode.UNAVAILABLE
        else:
            code = GatewayErrorCode.BAD_REQUEST
        retry_after = None
        if isinstance(exc, anthropic.RateLimitError):
            header = exc.response.headers.get("retry-after")
            retry_after = float(header) if header and header.replace(".", "", 1).isdigit() else None
        return GatewayError(
            code,
            message,
            status_code=status,
            provider_request_id=request_id,
            retry_after_s=retry_after,
        )

    async def chat(self, request: ChatRequest, on_delta: OnDelta | None = None) -> ChatResponse:
        params = self.build_params(request)
        started = time.perf_counter()
        try:
            if on_delta is None:
                final = await self._client.messages.create(**params, timeout=request.timeout_s)
            else:
                async with self._client.messages.stream(
                    **params, timeout=request.timeout_s
                ) as stream:
                    async for event in stream:
                        if event.type == "content_block_delta":
                            if event.delta.type == "text_delta":
                                await on_delta(StreamDelta("text", event.delta.text))
                            elif event.delta.type == "thinking_delta":
                                await on_delta(StreamDelta("reasoning", event.delta.thinking))
                        elif (
                            event.type == "content_block_start"
                            and event.content_block.type == "tool_use"
                        ):
                            await on_delta(StreamDelta("tool_call", event.content_block.name))
                    final = await stream.get_final_message()
        except anthropic.AnthropicError as exc:
            raise self._error(exc) from exc
        return self._parse(final, started)

    def _parse(self, final: Any, started: float) -> ChatResponse:
        texts: list[str] = []
        thoughts: list[str] = []
        calls: list[ToolCall] = []
        for block in final.content:
            if block.type == "text":
                texts.append(block.text)
            elif block.type == "thinking":
                if getattr(block, "thinking", ""):
                    thoughts.append(block.thinking)
            elif block.type == "tool_use":
                calls.append(
                    ToolCall(id=block.id, name=block.name, arguments=json.dumps(block.input))
                )
        usage = final.usage
        cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
        stop_reason = final.stop_reason
        stop_details = getattr(final, "stop_details", None)
        return ChatResponse(
            content="".join(texts),
            reasoning="\n\n".join(thoughts) or None,
            tool_calls=calls,
            finish_reason=_STOP.get(str(stop_reason), "tool_calls" if calls else "other"),
            raw_finish_reason=stop_reason,
            usage=Usage(
                input_tokens=int(usage.input_tokens or 0) + cache_read + cache_write,
                output_tokens=int(usage.output_tokens or 0),
                cached_input_tokens=cache_read,
                cache_write_tokens=cache_write,
            ),
            model=final.model,
            provider_request_id=getattr(final, "_request_id", None) or final.id,
            latency_ms=int((time.perf_counter() - started) * 1000),
            provider_state=[block.to_dict() for block in final.content],
            refusal_category=getattr(stop_details, "category", None)
            if stop_reason == "refusal"
            else None,
        )

    async def list_models(self) -> list[str]:
        try:
            return sorted([model.id async for model in self._client.models.list(limit=100)])
        except anthropic.AnthropicError as exc:
            raise self._error(exc) from exc
