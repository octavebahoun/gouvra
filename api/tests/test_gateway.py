"""Contract tests of the ModelGateway adapters.

Provider HTTP is mocked; tests calling a real provider are marked `real`.
"""

from __future__ import annotations

import json
import os

import anthropic
import httpx
import httpx2
import pytest
import respx

from gouvra.modules.providers.catalog import find_model
from gouvra.modules.providers.gateway.anthropic_adapter import (
    AnthropicAdapter,
    convert_messages,
    reasoning_params,
)
from gouvra.modules.providers.gateway.openai_compatible import (
    DeepSeekAdapter,
    OpenAICompatibleAdapter,
)
from gouvra.modules.providers.gateway.testing import ScriptedModelAdapter
from gouvra.modules.providers.gateway.types import (
    ChatMessage,
    ChatRequest,
    GatewayError,
    GatewayErrorCode,
    StreamDelta,
    ToolCall,
    ToolSpec,
)

CALC = ToolSpec(
    name="calculator",
    description="math",
    parameters={"type": "object", "properties": {"expression": {"type": "string"}}},
)


def _request(**kwargs: object) -> ChatRequest:
    return ChatRequest(
        model="deepseek-flash", messages=[ChatMessage(role="user", content="2+2?")], **kwargs
    )  # type: ignore[arg-type]


# ---------------------------------------------------------------- OpenAI-compatible / DeepSeek


@respx.mock
async def test_deepseek_tool_call_completion_and_body() -> None:
    route = respx.post("https://api.deepseek.com/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "req-1",
                "model": "deepseek-flash",
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "reasoning_content": "Need the calculator.",
                            "tool_calls": [
                                {
                                    "id": "c1",
                                    "type": "function",
                                    "function": {
                                        "name": "calculator",
                                        "arguments": '{"expression":"2+2"}',
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 12,
                    "prompt_cache_hit_tokens": 20,
                    "completion_tokens_details": {"reasoning_tokens": 5},
                },
            },
        )
    )
    adapter = DeepSeekAdapter(api_key="sk-test-0123456789abcdef")
    response = await adapter.chat(_request(tools=[CALC], reasoning="off", max_output_tokens=500))
    await adapter.aclose()
    body = json.loads(route.calls[0].request.content)
    assert body["thinking"] == {"type": "disabled"}
    assert body["max_tokens"] == 500
    assert body["tools"][0]["function"]["name"] == "calculator"
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test-0123456789abcdef"
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls == [
        ToolCall(id="c1", name="calculator", arguments='{"expression":"2+2"}')
    ]
    assert (
        response.usage.input_tokens,
        response.usage.cached_input_tokens,
        response.usage.reasoning_tokens,
    ) == (50, 20, 5)
    assert response.provider_state == {"reasoning_content": "Need the calculator."}


@respx.mock
async def test_streaming_assembles_content_reasoning_and_tool_calls() -> None:
    chunks = [
        {"choices": [{"delta": {"reasoning_content": "think "}}]},
        {"choices": [{"delta": {"content": "Hello "}}]},
        {"choices": [{"delta": {"content": "world"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "c9",
                                "function": {"name": "calculator", "arguments": '{"expr'},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'ession":"1"}'}}]}}
            ]
        },
        {
            "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 3},
        },
    ]
    sse = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    route = respx.post("https://api.deepseek.com/chat/completions").mock(
        return_value=httpx.Response(
            200, content=sse.encode(), headers={"content-type": "text/event-stream"}
        )
    )
    deltas: list[StreamDelta] = []

    async def collect(delta: StreamDelta) -> None:
        deltas.append(delta)

    adapter = DeepSeekAdapter(api_key="sk-test-0123456789abcdef")
    response = await adapter.chat(_request(reasoning="high"), on_delta=collect)
    body = json.loads(route.calls[0].request.content)
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["reasoning_effort"] == "high"
    assert response.content == "Hello world"
    assert response.reasoning == "think "
    assert response.tool_calls[0].arguments == '{"expression":"1"}'
    assert response.usage.output_tokens == 3
    assert [d.kind for d in deltas][:3] == ["reasoning", "text", "text"]


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (401, {"error": {"message": "Authentication Fails"}}, GatewayErrorCode.AUTH),
        (402, {"error": {"message": "Insufficient Balance"}}, GatewayErrorCode.QUOTA),
        (404, {"error": {"message": "Model Not Exist"}}, GatewayErrorCode.MODEL_NOT_FOUND),
        (
            400,
            {"error": {"message": "This model's maximum context length is 1000000 tokens"}},
            GatewayErrorCode.CONTEXT_LENGTH,
        ),
        (422, {"error": {"message": "bad"}}, GatewayErrorCode.BAD_REQUEST),
    ],
)
@respx.mock
async def test_error_mapping(status: int, body: dict[str, object], code: GatewayErrorCode) -> None:
    respx.post("https://api.deepseek.com/chat/completions").mock(
        return_value=httpx.Response(status, json=body)
    )
    adapter = DeepSeekAdapter(api_key="sk-test-0123456789abcdef")
    with pytest.raises(GatewayError) as error:
        await adapter.chat(_request())
    assert error.value.code == code
    assert error.value.attempts == 1
    assert "sk-test" not in error.value.message


@respx.mock
async def test_retries_rate_limits_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(
        "gouvra.modules.providers.gateway.openai_compatible.asyncio.sleep", no_sleep
    )
    route = respx.post("https://example.test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(429, json={"error": {"message": "slow"}}, headers={"retry-after": "1"}),
        httpx.Response(503, json={"error": {"message": "busy"}}),
        httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"content": "ok"}}],
                "usage": {},
            },
        ),
    ]
    adapter = OpenAICompatibleAdapter(base_url="https://example.test/v1", api_key="k")
    response = await adapter.chat(_request())
    assert response.content == "ok"
    assert response.attempts == 3


@respx.mock
async def test_retries_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(
        "gouvra.modules.providers.gateway.openai_compatible.asyncio.sleep", no_sleep
    )
    respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(500, json={})
    )
    adapter = OpenAICompatibleAdapter(base_url="https://example.test/v1", api_key="k")
    with pytest.raises(GatewayError) as error:
        await adapter.chat(_request())
    assert error.value.code == GatewayErrorCode.UNAVAILABLE
    assert error.value.attempts == 3


@respx.mock
async def test_network_failures_are_normalised() -> None:
    respx.post("https://example.test/v1/chat/completions").mock(
        side_effect=httpx.ConnectError("boom")
    )
    respx.get("https://example.test/v1/models").mock(side_effect=httpx.ReadTimeout("slow"))
    adapter = OpenAICompatibleAdapter(base_url="https://example.test/v1", api_key="k")
    with pytest.raises(GatewayError) as error:
        await adapter.chat(_request())
    assert error.value.code == GatewayErrorCode.NETWORK
    with pytest.raises(GatewayError) as timeout:
        await adapter.list_models()
    assert timeout.value.code == GatewayErrorCode.TIMEOUT


def test_openai_message_conversion_replays_reasoning_only_for_same_provider() -> None:
    adapter = DeepSeekAdapter(api_key="k")
    assistant = ChatMessage(
        role="assistant",
        content=None,
        tool_calls=[ToolCall("c1", "calculator", "{}")],
        provider_state={"reasoning_content": "r"},
        provider_kind="deepseek",
    )
    body = adapter.build_body(
        ChatRequest(
            model="m",
            messages=[assistant, ChatMessage(role="tool", content="4", tool_call_id="c1")],
        ),
        stream=False,
    )
    assert body["messages"][0]["reasoning_content"] == "r"
    assert body["messages"][1] == {"role": "tool", "tool_call_id": "c1", "content": "4"}
    foreign = ChatMessage(
        role="assistant",
        content="x",
        provider_state={"reasoning_content": "r"},
        provider_kind="anthropic",
    )
    assert (
        "reasoning_content"
        not in adapter.build_body(ChatRequest(model="m", messages=[foreign]), stream=False)[
            "messages"
        ][0]
    )


# ------------------------------------------------ Anthropic (official SDK over httpx2)


def _anthropic_with(handler: object) -> AnthropicAdapter:
    client = anthropic.AsyncAnthropic(
        api_key="sk-ant-test",
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        max_retries=0,  # type: ignore[arg-type]
    )
    return AnthropicAdapter(api_key="sk-ant-test", client=client)


async def test_anthropic_tool_use_round_trip() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-5-5",
                "content": [
                    {"type": "thinking", "thinking": "Use the tool.", "signature": "sig"},
                    {
                        "type": "tool_use",
                        "id": "tu_1",
                        "name": "calculator",
                        "input": {"expression": "2+2"},
                    },
                ],
                "stop_reason": "tool_use",
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 30,
                    "output_tokens": 10,
                    "cache_read_input_tokens": 70,
                    "cache_creation_input_tokens": 0,
                },
            },
        )

    adapter = _anthropic_with(handler)
    request = ChatRequest(
        model="claude-sonnet-5-5",
        messages=[
            ChatMessage(role="system", content="Be exact."),
            ChatMessage(role="user", content="2+2?"),
        ],
        tools=[CALC],
        reasoning="medium",
        temperature=0.2,
    )
    response = await adapter.chat(request)
    body = seen[0]
    assert body["system"] == "Be exact."
    assert body["tools"][0]["input_schema"]["type"] == "object"  # type: ignore[index]
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert body["output_config"] == {"effort": "medium"}
    assert "temperature" not in body  # sampling parameters are rejected by this model
    assert response.finish_reason == "tool_calls"
    assert response.reasoning == "Use the tool."
    assert response.tool_calls[0].name == "calculator"
    assert json.loads(response.tool_calls[0].arguments) == {"expression": "2+2"}
    assert (response.usage.input_tokens, response.usage.cached_input_tokens) == (100, 70)
    assert response.provider_state[0]["type"] == "thinking"  # replayed unchanged next turn

    # Next turn: thinking + tool_use blocks are replayed verbatim; results grouped in one user turn.
    follow = ChatRequest(
        model="claude-sonnet-5-5",
        messages=[
            ChatMessage(role="user", content="2+2?"),
            ChatMessage(
                role="assistant",
                tool_calls=response.tool_calls,
                provider_state=response.provider_state,
                provider_kind="anthropic",
            ),
            ChatMessage(role="tool", content="4", tool_call_id="tu_1"),
        ],
    )
    _, messages = convert_messages(follow.messages)
    assert messages[1]["content"][0]["type"] == "thinking"
    assert messages[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "tu_1", "content": "4", "is_error": False}
        ],
    }


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, GatewayErrorCode.AUTH),
        (403, GatewayErrorCode.PERMISSION),
        (404, GatewayErrorCode.MODEL_NOT_FOUND),
        (429, GatewayErrorCode.RATE_LIMITED),
        (529, GatewayErrorCode.UNAVAILABLE),
    ],
)
async def test_anthropic_error_mapping(status: int, code: GatewayErrorCode) -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            status,
            json={"type": "error", "error": {"type": "x", "message": "nope"}},
            headers={"request-id": "req_9"},
        )

    with pytest.raises(GatewayError) as error:
        await _anthropic_with(handler).chat(
            ChatRequest(model="claude-haiku-5-5", messages=[ChatMessage(role="user", content="hi")])
        )
    assert error.value.code == code


def test_anthropic_reasoning_translation() -> None:
    opus = find_model("anthropic", "claude-opus-5-5")
    sonnet = find_model("anthropic", "claude-sonnet-5-5")
    haiku4 = find_model("anthropic", "claude-haiku-4-5")
    assert reasoning_params(opus, "off") == {
        "output_config": {"effort": "low"}
    }  # cannot be disabled
    assert reasoning_params(sonnet, "off") == {"thinking": {"type": "between_tools"}}
    assert reasoning_params(haiku4, "high") == {
        "thinking": {"type": "enabled", "budget_tokens": 8192}
    }
    assert reasoning_params(None, "high") == {}


# ---------------------------------------------------------------- deterministic test adapter


async def test_test_adapter_is_deterministic_and_scriptable() -> None:
    adapter = ScriptedModelAdapter()
    request = ChatRequest(
        model="gouvra-test-1",
        messages=[
            ChatMessage(role="user", content='Compute [tool:calculator {"expression": "6*7"}]')
        ],
        tools=[CALC],
    )
    first, second = await adapter.chat(request), await adapter.chat(request)
    assert (
        first.tool_calls
        == second.tool_calls
        == [ToolCall("call_1", "calculator", '{"expression": "6*7"}')]
    )
    assert first.usage == second.usage
    follow = ChatRequest(
        model="gouvra-test-1",
        messages=[
            *request.messages,
            ChatMessage(role="assistant", tool_calls=first.tool_calls),
            ChatMessage(
                role="tool", content='{"result": 42}', tool_call_id="call_1", tool_name="calculator"
            ),
        ],
        tools=[CALC],
    )
    final = await adapter.chat(follow)
    assert "42" in final.content
    with pytest.raises(GatewayError) as error:
        await adapter.chat(
            ChatRequest(
                model="gouvra-test-1",
                messages=[ChatMessage(role="user", content="[fail:provider_rate_limited]")],
            )
        )
    assert error.value.code == GatewayErrorCode.RATE_LIMITED
    assert await ScriptedModelAdapter().list_models() == ["gouvra-test-1"]


# ------------------------------------------------ real provider (DeepSeek official API)


@pytest.mark.real
async def test_deepseek_real_tool_calling_with_and_without_thinking() -> None:
    from gouvra.core.config import get_settings

    key = get_settings().deepseek_api_key.get_secret_value() or os.environ.get(
        "DEEPSEEK_API_KEY", ""
    )
    if not key:
        pytest.skip("DEEPSEEK_API_KEY not configured")
    adapter = DeepSeekAdapter(api_key=key)
    models = await adapter.list_models()
    assert "deepseek-flash" in models
    for reasoning in ("off", "auto"):
        messages = [
            ChatMessage(
                role="user",
                content=(
                    "What is 1234 * 5678? Use the calculator tool,"
                    " then answer with the number only."
                ),
            )
        ]
        first = await adapter.chat(
            ChatRequest(
                model="deepseek-flash",
                messages=messages,
                tools=[CALC],
                reasoning=reasoning,
                max_output_tokens=2000,
            )
        )  # type: ignore[arg-type]
        assert first.tool_calls, f"no tool call with reasoning={reasoning}"
        call = first.tool_calls[0]
        messages += [
            ChatMessage(
                role="assistant",
                content=first.content or None,
                tool_calls=first.tool_calls,
                provider_state=first.provider_state,
                provider_kind="deepseek",
            ),
            ChatMessage(
                role="tool",
                content=json.dumps({"result": 7006652}),
                tool_call_id=call.id,
                tool_name=call.name,
            ),
        ]
        streamed: list[StreamDelta] = []

        async def collect(delta: StreamDelta, sink: list[StreamDelta] = streamed) -> None:
            sink.append(delta)

        final = await adapter.chat(
            ChatRequest(
                model="deepseek-flash",
                messages=messages,
                tools=[CALC],
                reasoning=reasoning,
                max_output_tokens=2000,
            ),
            on_delta=collect,
        )  # type: ignore[arg-type]
        assert "7006652" in final.content.replace(",", "").replace(" ", "")
        assert final.usage.input_tokens > 0
        assert final.usage.output_tokens > 0
        assert any(d.kind == "text" for d in streamed)
    await adapter.aclose()
