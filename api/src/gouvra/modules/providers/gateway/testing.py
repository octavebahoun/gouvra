"""Deterministic, offline model adapter for tests, demos and CI.

The last user message (or the tool results) drives the behaviour through directives:
  [tool:NAME {"json": "args"}]   call tool NAME with these arguments (repeatable)
  [fail:CODE]                     raise the GatewayError CODE (e.g. provider_rate_limited)
  [sleep:MS]                      take MS milliseconds, streaming as it goes
  [json]                          answer with a JSON object
  [think]                         emit a short reasoning trace first
Without directives it answers "Echo: <input>". Same input, same output — every time.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from typing import Any

from gouvra.modules.providers.gateway.types import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    GatewayError,
    GatewayErrorCode,
    OnDelta,
    StreamDelta,
    ToolCall,
    Usage,
)

TOOL_RE = re.compile(r"\[tool:([a-zA-Z0-9_\-]+)\s*(\{.*?\})?\]", re.DOTALL)
FAIL_RE = re.compile(r"\[fail:([a-z_]+)\]")
SLEEP_RE = re.compile(r"\[sleep:(\d{1,6})\]")
MODELS = ["gouvra-test-1"]


def _words(text: str) -> int:
    return len(text.split())


def _strip(text: str) -> str:
    return re.sub(r"\[(?:tool|fail|sleep|json|think)[^\]]*\]", "", text).strip()


class ScriptedModelAdapter:
    kind = "test"

    def __init__(self, *, api_key: str = "", base_url: str | None = None) -> None:
        self.api_key = api_key

    async def aclose(self) -> None:
        return None

    async def list_models(self) -> list[str]:
        if self.api_key == "invalid":
            raise GatewayError(
                GatewayErrorCode.AUTH, "Invalid API key (test provider).", status_code=401
            )
        return list(MODELS)

    async def chat(self, request: ChatRequest, on_delta: OnDelta | None = None) -> ChatResponse:
        started = time.perf_counter()
        if self.api_key == "invalid":
            raise GatewayError(
                GatewayErrorCode.AUTH, "Invalid API key (test provider).", status_code=401
            )
        if request.model not in MODELS:
            raise GatewayError(
                GatewayErrorCode.MODEL_NOT_FOUND,
                f"Model {request.model!r} does not exist.",
                status_code=404,
            )
        user_text = next(
            (m.content or "" for m in reversed(request.messages) if m.role == "user"), ""
        )
        tool_results = self._pending_tool_results(request.messages)

        if failure := FAIL_RE.search(user_text):
            try:
                code = GatewayErrorCode(failure.group(1))
            except ValueError:
                code = GatewayErrorCode.BAD_REQUEST
            raise GatewayError(
                code,
                f"Simulated failure: {code.value}",
                status_code=503 if code == GatewayErrorCode.UNAVAILABLE else 400,
            )

        reasoning = None
        if "[think]" in user_text and request.reasoning != "off":
            reasoning = "Let me look at the request and decide which tools are needed."
            if on_delta:
                for word in reasoning.split(" "):
                    await on_delta(StreamDelta("reasoning", word + " "))

        calls: list[ToolCall] = []
        content = ""
        if tool_results is None:
            # Directives are followed literally, even for tools the agent may not use: this is
            # how tests simulate a model that hallucinates a tool name.
            calls = [
                ToolCall(id=f"call_{i + 1}", name=name, arguments=args or "{}")
                for i, (name, args) in enumerate(TOOL_RE.findall(user_text))
            ]
        if not calls:
            content = self._answer(request, user_text, tool_results)
        if sleep := SLEEP_RE.search(user_text):
            total_ms = int(sleep.group(1))
            steps = max(1, total_ms // 100)
            for i in range(steps):
                await asyncio.sleep(total_ms / steps / 1000)
                if on_delta and i % 5 == 0:
                    await on_delta(StreamDelta("text", ""))
        if on_delta:
            for call in calls:
                await on_delta(StreamDelta("tool_call", call.name))
            for token in re.findall(r"\S+\s*", content):
                await on_delta(StreamDelta("text", token))
        prompt_words = sum(_words(m.content or "") for m in request.messages) + sum(
            _words(t.description) for t in request.tools
        )
        return ChatResponse(
            content=content,
            reasoning=reasoning,
            tool_calls=calls,
            finish_reason="tool_calls" if calls else "stop",
            raw_finish_reason="tool_calls" if calls else "stop",
            usage=Usage(
                input_tokens=max(1, round(prompt_words * 1.3)),
                output_tokens=max(1, round((_words(content) + 4 * len(calls)) * 1.3)),
                reasoning_tokens=_words(reasoning or ""),
            ),
            model=request.model,
            provider_request_id="test-" + hashlib.sha256(user_text.encode()).hexdigest()[:12],
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    @staticmethod
    def _pending_tool_results(messages: list[ChatMessage]) -> list[ChatMessage] | None:
        """Tool results that follow the last assistant turn, if the conversation is mid-loop."""
        results: list[ChatMessage] = []
        for message in reversed(messages):
            if message.role == "tool":
                results.append(message)
            else:
                break
        return list(reversed(results)) or None

    @staticmethod
    def _answer(
        request: ChatRequest, user_text: str, tool_results: list[ChatMessage] | None
    ) -> str:
        if tool_results is not None:
            summary = "; ".join(
                f"{r.tool_name or 'tool'} → {(r.content or '')[:200]}" for r in tool_results
            )
            text = f"Done. Tool results: {summary}"
        else:
            text = f"Echo: {_strip(user_text)}"
        if "[json]" in user_text or request.response_format == "json":
            payload: dict[str, Any] = {"answer": text, "words": _words(text)}
            return json.dumps(payload)
        return text
