"""Adapter for OpenAI-compatible Chat Completions APIs (DeepSeek, OpenAI, OpenRouter...)."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import httpx

from gouvra.core.logging import get_logger
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

log = get_logger(__name__)

MAX_ATTEMPTS = 3
MAX_RETRY_WAIT_S = 20.0

_FINISH: dict[str, FinishReason] = {
    "stop": "stop",
    "length": "length",
    "tool_calls": "tool_calls",
    "function_call": "tool_calls",
    "content_filter": "content_filter",
}


@dataclass(frozen=True)
class CompatOptions:
    """Per-provider dialect switches of the OpenAI-compatible family."""

    max_tokens_param: str = "max_tokens"
    end_user_param: str | None = "user"
    supports_thinking_param: bool = False  # DeepSeek: thinking={"type": ...} + reasoning_effort
    send_reasoning_back: bool = False  # replay reasoning_content in assistant turns
    stream_usage: bool = True
    extra_headers: dict[str, str] = field(default_factory=dict)


class OpenAICompatibleAdapter:
    kind = "openai_compatible"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        options: CompatOptions | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.options = options or CompatOptions()
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=10.0))
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ------------------------------------------------------------------ helpers

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            **self.options.extra_headers,
        }

    def _message(self, message: ChatMessage) -> dict[str, Any]:
        if message.role == "tool":
            return {
                "role": "tool",
                "tool_call_id": message.tool_call_id,
                "content": message.content or "",
            }
        if message.role == "assistant":
            out: dict[str, Any] = {"role": "assistant", "content": message.content or None}
            if message.tool_calls:
                out["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": c.arguments},
                    }
                    for c in message.tool_calls
                ]
            reasoning = (
                message.provider_state.get("reasoning_content")
                if isinstance(message.provider_state, dict)
                else None
            )
            if (
                self.options.send_reasoning_back
                and reasoning
                and message.provider_kind == self.kind
            ):
                out["reasoning_content"] = reasoning
            return out
        return {"role": message.role, "content": message.content or ""}

    def _apply_reasoning(self, body: dict[str, Any], request: ChatRequest) -> None:
        """Hook for dialects with a reasoning switch (see DeepSeekAdapter)."""

    def build_body(self, request: ChatRequest, *, stream: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "messages": [self._message(m) for m in request.messages],
        }
        if request.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in request.tools
            ]
            body["tool_choice"] = "auto"
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.top_p is not None:
            body["top_p"] = request.top_p
        if request.max_output_tokens:
            body[self.options.max_tokens_param] = request.max_output_tokens
        if request.response_format == "json":
            body["response_format"] = {"type": "json_object"}
        if request.stop:
            body["stop"] = request.stop
        if request.end_user_id and self.options.end_user_param:
            body[self.options.end_user_param] = request.end_user_id
        if stream:
            body["stream"] = True
            if self.options.stream_usage:
                body["stream_options"] = {"include_usage": True}
        self._apply_reasoning(body, request)
        return body

    @staticmethod
    def _error_from_response(response: httpx.Response) -> GatewayError:
        status = response.status_code
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        err = payload.get("error") if isinstance(payload, dict) else None
        detail = ""
        if isinstance(err, dict):
            detail = str(err.get("message") or err.get("type") or "")
        elif isinstance(err, str):
            detail = err
        detail = detail[:300]
        lowered = detail.lower()
        request_id = response.headers.get("x-request-id") or response.headers.get("request-id")
        retry_after = response.headers.get("retry-after")
        retry_s = (
            float(retry_after)
            if retry_after and retry_after.replace(".", "", 1).isdigit()
            else None
        )
        if status == 401:
            code = GatewayErrorCode.AUTH
        elif status == 402 or "insufficient balance" in lowered or "quota" in lowered:
            code = GatewayErrorCode.QUOTA
        elif status == 403:
            code = GatewayErrorCode.PERMISSION
        elif status == 404 or "model not exist" in lowered or "model_not_found" in lowered:
            code = GatewayErrorCode.MODEL_NOT_FOUND
        elif status == 429:
            code = GatewayErrorCode.RATE_LIMITED
        elif status >= 500:
            code = GatewayErrorCode.UNAVAILABLE
        elif "context" in lowered and (
            "length" in lowered or "window" in lowered or "maximum" in lowered
        ):
            code = GatewayErrorCode.CONTEXT_LENGTH
        else:
            code = GatewayErrorCode.BAD_REQUEST
        message = detail or f"HTTP {status}"
        return GatewayError(
            code, message, status_code=status, provider_request_id=request_id, retry_after_s=retry_s
        )

    # ------------------------------------------------------------------ calls

    async def _with_retries(self, request: ChatRequest, on_delta: OnDelta | None) -> ChatResponse:
        attempt = 0
        while True:
            attempt += 1
            streamed = [False]
            try:
                response = await self._call(request, on_delta, streamed)
            except GatewayError as exc:
                exc.attempts = attempt
                # Never retry once tokens reached the client: the trace would show them twice.
                if not exc.retryable or attempt >= MAX_ATTEMPTS or streamed[0]:
                    raise
                wait = min(exc.retry_after_s or 0.5 * 2**attempt, MAX_RETRY_WAIT_S)
                log.info("provider_retry", code=exc.code.value, attempt=attempt, wait_s=wait)
                await asyncio.sleep(wait)
            else:
                response.attempts = attempt
                return response

    async def chat(self, request: ChatRequest, on_delta: OnDelta | None = None) -> ChatResponse:
        return await self._with_retries(request, on_delta)

    async def _call(
        self, request: ChatRequest, on_delta: OnDelta | None, streamed_any: list[bool]
    ) -> ChatResponse:
        url = f"{self.base_url}/chat/completions"
        started = time.perf_counter()
        stream = on_delta is not None
        body = self.build_body(request, stream=stream)
        try:
            if not stream:
                response = await self._client.post(
                    url, json=body, headers=self._headers(), timeout=request.timeout_s
                )
                if response.status_code >= 400:
                    raise self._error_from_response(response)
                return self._parse_completion(response, started)
            async with self._client.stream(
                "POST", url, json=body, headers=self._headers(), timeout=request.timeout_s
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise self._error_from_response(response)
                return await self._parse_stream(response, started, on_delta, streamed_any)
        except httpx.TimeoutException as exc:
            raise GatewayError(
                GatewayErrorCode.TIMEOUT, "The provider did not answer in time."
            ) from exc
        except httpx.HTTPError as exc:
            raise GatewayError(
                GatewayErrorCode.NETWORK, f"Could not reach the provider ({type(exc).__name__})."
            ) from exc

    def _usage(self, raw: dict[str, Any] | None) -> Usage:
        if not raw:
            return Usage()
        prompt = int(raw.get("prompt_tokens") or 0)
        cached = raw.get("prompt_cache_hit_tokens")
        if cached is None:
            cached = (raw.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        reasoning = (raw.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        cost = raw.get("cost")  # OpenRouter-style provider-reported cost
        return Usage(
            input_tokens=prompt,
            output_tokens=int(raw.get("completion_tokens") or 0),
            cached_input_tokens=int(cached or 0),
            reasoning_tokens=int(reasoning or 0),
            provider_cost=Decimal(str(cost)) if isinstance(cost, int | float) else None,
            provider_cost_currency="USD" if isinstance(cost, int | float) else None,
        )

    def _parse_completion(self, response: httpx.Response, started: float) -> ChatResponse:
        try:
            payload = response.json()
            choice = payload["choices"][0]
            message = choice.get("message") or {}
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise GatewayError(
                GatewayErrorCode.INVALID_RESPONSE, "The provider returned an unexpected payload."
            ) from exc
        calls = [
            ToolCall(
                id=str(c.get("id") or f"call_{i}"),
                name=str(c["function"]["name"]),
                arguments=str(c["function"].get("arguments") or "{}"),
            )
            for i, c in enumerate(message.get("tool_calls") or [])
        ]
        reasoning = message.get("reasoning_content")
        raw_finish = choice.get("finish_reason")
        return ChatResponse(
            content=message.get("content") or "",
            reasoning=reasoning,
            tool_calls=calls,
            finish_reason=_FINISH.get(str(raw_finish), "tool_calls" if calls else "other"),
            raw_finish_reason=raw_finish,
            usage=self._usage(payload.get("usage")),
            model=str(payload.get("model") or ""),
            provider_request_id=payload.get("id") or response.headers.get("x-request-id"),
            latency_ms=int((time.perf_counter() - started) * 1000),
            provider_state={"reasoning_content": reasoning} if reasoning else None,
        )

    async def _parse_stream(
        self,
        response: httpx.Response,
        started: float,
        on_delta: OnDelta | None,
        streamed_any: list[bool],
    ) -> ChatResponse:
        content: list[str] = []
        reasoning: list[str] = []
        calls: dict[int, dict[str, str]] = {}
        usage_raw: dict[str, Any] | None = None
        raw_finish: str | None = None
        model = ""
        request_id: str | None = response.headers.get("x-request-id")
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk.get("error"), dict):
                raise GatewayError(
                    GatewayErrorCode.UNAVAILABLE,
                    str(chunk["error"].get("message", "stream error"))[:300],
                )
            model = chunk.get("model") or model
            request_id = chunk.get("id") or request_id
            if chunk.get("usage"):
                usage_raw = chunk["usage"]
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("reasoning_content"):
                    reasoning.append(delta["reasoning_content"])
                    if on_delta:
                        streamed_any[0] = True
                        await on_delta(StreamDelta("reasoning", delta["reasoning_content"]))
                if delta.get("content"):
                    content.append(delta["content"])
                    if on_delta:
                        streamed_any[0] = True
                        await on_delta(StreamDelta("text", delta["content"]))
                for call in delta.get("tool_calls") or []:
                    slot = calls.setdefault(
                        int(call.get("index", 0)), {"id": "", "name": "", "arguments": ""}
                    )
                    if call.get("id"):
                        slot["id"] = call["id"]
                    fn = call.get("function") or {}
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                        if on_delta:
                            await on_delta(StreamDelta("tool_call", fn["name"]))
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
                if choice.get("finish_reason"):
                    raw_finish = choice["finish_reason"]
        tool_calls = [
            ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=slot["arguments"] or "{}",
            )
            for index, slot in sorted(calls.items())
        ]
        reasoning_text = "".join(reasoning) or None
        return ChatResponse(
            content="".join(content),
            reasoning=reasoning_text,
            tool_calls=tool_calls,
            finish_reason=_FINISH.get(str(raw_finish), "tool_calls" if tool_calls else "other"),
            raw_finish_reason=raw_finish,
            usage=self._usage(usage_raw),
            model=model,
            provider_request_id=request_id,
            latency_ms=int((time.perf_counter() - started) * 1000),
            provider_state={"reasoning_content": reasoning_text} if reasoning_text else None,
        )

    async def list_models(self) -> list[str]:
        try:
            response = await self._client.get(
                f"{self.base_url}/models", headers=self._headers(), timeout=15
            )
        except httpx.TimeoutException as exc:
            raise GatewayError(
                GatewayErrorCode.TIMEOUT, "The provider did not answer in time."
            ) from exc
        except httpx.HTTPError as exc:
            raise GatewayError(
                GatewayErrorCode.NETWORK, f"Could not reach the provider ({type(exc).__name__})."
            ) from exc
        if response.status_code >= 400:
            raise self._error_from_response(response)
        try:
            return sorted(str(m["id"]) for m in response.json().get("data", []) if m.get("id"))
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise GatewayError(
                GatewayErrorCode.INVALID_RESPONSE, "Unexpected model list payload."
            ) from exc


class DeepSeekAdapter(OpenAICompatibleAdapter):
    """DeepSeek official API (OpenAI-compatible + thinking switch, cache-hit usage fields)."""

    kind = "deepseek"
    DEFAULT_BASE_URL = "https://api.deepseek.com"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 120.0,
    ) -> None:
        super().__init__(
            base_url=base_url or self.DEFAULT_BASE_URL,
            api_key=api_key,
            options=CompatOptions(
                max_tokens_param="max_tokens",
                end_user_param="user_id",
                supports_thinking_param=True,
                send_reasoning_back=True,
            ),
            client=client,
            timeout_s=timeout_s,
        )

    def _apply_reasoning(self, body: dict[str, Any], request: ChatRequest) -> None:
        if request.reasoning == "off":
            body["thinking"] = {"type": "disabled"}
            return
        body["thinking"] = {"type": "enabled"}
        if request.reasoning in ("low", "high", "max"):
            body["reasoning_effort"] = request.reasoning
        elif request.reasoning == "medium":
            body["reasoning_effort"] = "high"
