"""The agent loop: model turns, tool calls, limits, cancellation, timeouts — every step traced.

Runs only in the worker process. Tools of kind `code` are delegated to the sandbox service.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy import select, update

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.logging import get_logger
from gouvra.modules.agents.models import AgentVersion
from gouvra.modules.executions.events import (
    EventEmitter,
    append_event,
    publish_event,
    publish_status,
)
from gouvra.modules.executions.models import Execution, ExecutionStatus, UsageRecord
from gouvra.modules.providers.catalog import find_model
from gouvra.modules.providers.gateway.types import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    GatewayError,
    ModelAdapter,
    ToolSpec,
)
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.providers.pricing import Cost, CostSource, combine, estimate
from gouvra.modules.providers.service import adapter_for
from gouvra.modules.tools.models import Tool
from gouvra.modules.tools.runtime import ToolResult, run_tool
from gouvra.modules.tools.schema_rules import strict

log = get_logger(__name__)

PREVIEW = 2_000


class ExecutionFailure(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "details": self.details,
        }


@dataclass
class VersionConfig:
    """What actually runs: the agent version, plus evaluation overrides when present."""

    number: int
    model: str
    instructions: str
    parameters: dict[str, Any]
    limits: dict[str, Any]
    tool_ids: list[str]
    provider_config_id: uuid.UUID | None
    overridden: list[str] = field(default_factory=list)

    @classmethod
    def build(cls, version: AgentVersion, overrides: dict[str, Any] | None) -> VersionConfig:
        overrides = overrides or {}
        provider = overrides.get("provider_id")
        config = cls(
            number=version.number,
            model=str(overrides.get("model") or version.model),
            instructions=str(overrides["instructions"])
            if "instructions" in overrides
            else version.instructions,
            parameters={**(version.parameters or {}), **(overrides.get("parameters") or {})},
            limits=dict(version.limits or {}),
            tool_ids=list(version.tool_ids or []),
            provider_config_id=uuid.UUID(str(provider)) if provider else version.provider_config_id,
        )
        config.overridden = sorted(
            k for k in ("model", "provider_id", "instructions", "parameters") if k in overrides
        )
        return config


@dataclass
class RunState:
    execution: Execution
    version: VersionConfig
    provider: ProviderConfig
    tools: dict[str, Tool]
    emitter: EventEmitter
    costs: list[Cost] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    model_calls: int = 0
    tool_calls: int = 0
    steps: int = 0

    @property
    def limits(self) -> dict[str, Any]:
        return self.version.limits or {}


def _input_text(payload: dict[str, Any]) -> str:
    if "text" in payload and isinstance(payload["text"], str):
        return payload["text"]
    return json.dumps(payload.get("json", payload), ensure_ascii=False)


def _preview(text: str | None) -> str | None:
    if text is None:
        return None
    return text if len(text) <= PREVIEW else text[:PREVIEW] + "…"


async def _load(
    execution_id: uuid.UUID,
) -> tuple[Execution, VersionConfig, ProviderConfig, dict[str, Tool]]:
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, execution_id)
        if execution is None:
            raise ExecutionFailure("not_found", "Execution not found.")
        version = (
            await db.get(AgentVersion, execution.agent_version_id)
            if execution.agent_version_id
            else None
        )
        if version is None:
            raise ExecutionFailure(
                "agent_version_missing", "The agent version of this execution no longer exists."
            )
        config = VersionConfig.build(version, execution.config_overrides)
        provider = (
            await db.get(ProviderConfig, config.provider_config_id)
            if config.provider_config_id
            else None
        )
        if provider is not None and provider.workspace_id != execution.workspace_id:
            provider = None  # an override can never reach another workspace's credentials
        if provider is None or provider.archived_at is not None:
            raise ExecutionFailure(
                "provider_missing",
                "The agent has no usable provider. Choose a provider in the agent settings.",
            )
        tool_ids = [uuid.UUID(t) for t in config.tool_ids]
        tools = (
            list(
                (
                    await db.execute(
                        select(Tool).where(
                            Tool.id.in_(tool_ids), Tool.workspace_id == execution.workspace_id
                        )
                    )
                ).scalars()
            )
            if tool_ids
            else []
        )
        return (
            execution,
            config,
            provider,
            {t.name: t for t in tools if t.status == "active" and t.archived_at is None},
        )


async def _cancel_requested(execution_id: uuid.UUID) -> bool:
    async with get_sessionmaker()() as db:
        value = (
            await db.execute(
                select(Execution.cancel_requested_at).where(Execution.id == execution_id)
            )
        ).scalar_one_or_none()
        return value is not None


async def _record_usage(state: RunState, response: ChatResponse, cost: Cost) -> None:
    state.input_tokens += response.usage.input_tokens
    state.output_tokens += response.usage.output_tokens
    state.cached_tokens += response.usage.cached_input_tokens
    state.reasoning_tokens += response.usage.reasoning_tokens
    state.model_calls += 1
    state.costs.append(cost)
    total = combine(state.costs)
    execution = state.execution
    async with get_sessionmaker()() as db:
        db.add(
            UsageRecord(
                workspace_id=execution.workspace_id,
                execution_id=execution.id,
                agent_id=execution.agent_id,
                provider_config_id=state.provider.id,
                provider_kind=state.provider.kind,
                model=state.version.model,
                kind="model_call",
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cached_tokens=response.usage.cached_input_tokens,
                reasoning_tokens=response.usage.reasoning_tokens,
                cost_amount=cost.amount,
                cost_currency=cost.currency,
                cost_source=cost.source.value,
                price_period=cost.price_period,
            )
        )
        await db.execute(
            update(Execution)
            .where(Execution.id == execution.id)
            .values(
                input_tokens=state.input_tokens,
                output_tokens=state.output_tokens,
                cached_tokens=state.cached_tokens,
                reasoning_tokens=state.reasoning_tokens,
                model_calls=state.model_calls,
                cost_amount=total.amount,
                cost_currency=total.currency,
                cost_source=total.source.value,
                cost_partial=total.partial,
            )
        )
        await db.commit()


def _cost_dict(cost: Cost) -> dict[str, Any]:
    return {
        "amount": str(cost.amount) if cost.amount is not None else None,
        "currency": cost.currency,
        "source": cost.source.value,
        "period": cost.price_period,
        "pricing_as_of": cost.pricing_as_of.isoformat() if cost.pricing_as_of else None,
        "partial": cost.partial,
    }


def _check_budget(state: RunState) -> None:
    limits = state.limits
    max_tokens = limits.get("max_total_tokens")
    if max_tokens and state.input_tokens + state.output_tokens >= int(max_tokens):
        raise ExecutionFailure(
            "limit_exceeded",
            f"The execution used {state.input_tokens + state.output_tokens} tokens;"
            f" the agent allows {max_tokens}.",
            details={"limit": "max_total_tokens", "value": int(max_tokens)},
        )
    max_cost = limits.get("max_cost_usd")
    total = combine(state.costs)
    if max_cost and total.amount is not None and total.amount >= Decimal(str(max_cost)):
        raise ExecutionFailure(
            "limit_exceeded",
            f"The execution cost reached {total.amount} {total.currency};"
            f" the agent allows {max_cost}.",
            details={"limit": "max_cost_usd", "value": str(max_cost)},
        )


async def _run_tool_call(
    state: RunState, step: int, call_id: str, name: str, raw_arguments: str
) -> ToolResult:
    tool = state.tools.get(name)
    try:
        arguments: Any = json.loads(raw_arguments or "{}")
    except json.JSONDecodeError:
        arguments = None
    await state.emitter.emit(
        "tool.call",
        {
            "call_id": call_id,
            "tool": name,
            "tool_id": str(tool.id) if tool else None,
            "arguments": arguments if arguments is not None else raw_arguments,
        },
        step=step,
    )
    if tool is None:
        result = ToolResult(
            False,
            error_code="tool_not_allowed",
            error_message=f"The tool {name!r} is not allowed for this agent.",
        )
    elif arguments is None:
        result = ToolResult(
            False, error_code="invalid_arguments", error_message="The arguments are not valid JSON."
        )
    else:
        result = await run_tool(tool, arguments)
    for_model = result.for_model()
    await state.emitter.emit(
        "tool.result",
        {
            "call_id": call_id,
            "tool": name,
            "ok": result.ok,
            "output": result.output if result.ok else None,
            "error_code": result.error_code,
            "error_message": result.error_message,
            "truncated": result.truncated,
            "model_sees_chars": len(for_model),
        },
        level="info" if result.ok else "warning",
        step=step,
        duration_ms=result.duration_ms,
    )
    result.output = for_model
    return result


async def _agent_loop(state: RunState, adapter: ModelAdapter) -> dict[str, Any]:
    version, execution = state.version, state.execution
    parameters = version.parameters or {}
    model_info = find_model(state.provider.kind, version.model)
    messages: list[ChatMessage] = []
    if version.instructions.strip():
        messages.append(ChatMessage(role="system", content=version.instructions))
    messages.append(ChatMessage(role="user", content=_input_text(execution.input)))
    tool_specs = [
        ToolSpec(name=t.name, description=t.description, parameters=strict(t.input_schema))
        for t in state.tools.values()
    ]
    max_steps = int(state.limits.get("max_steps", 8))
    max_tool_calls = int(state.limits.get("max_tool_calls", 20))

    for step in range(1, max_steps + 1):
        state.steps = step
        if await _cancel_requested(execution.id):
            raise asyncio.CancelledError
        _check_budget(state)
        request = ChatRequest(
            model=version.model,
            messages=messages,
            tools=tool_specs,
            temperature=parameters.get("temperature"),
            top_p=parameters.get("top_p"),
            max_output_tokens=parameters.get("max_output_tokens"),
            response_format=parameters.get("response_format", "text"),
            reasoning=parameters.get("reasoning", "auto"),
            timeout_s=float(execution.timeout_s),
            end_user_id=str(execution.workspace_id),
        )
        await state.emitter.emit(
            "model.request",
            {
                "model": version.model,
                "provider": state.provider.kind,
                "messages": len(messages),
                "tools": [t.name for t in tool_specs],
                "reasoning": request.reasoning,
            },
            step=step,
        )
        try:
            response = await adapter.chat(request, on_delta=state.emitter.delta_callback(step))
        except GatewayError as exc:
            await state.emitter.emit(
                "model.error", {"error": exc.as_dict()}, level="error", step=step
            )
            raise ExecutionFailure(
                exc.code.value, exc.message, retryable=exc.retryable, details=exc.as_dict()
            ) from exc
        cost = estimate(model_info, response.usage, utcnow())
        await _record_usage(state, response, cost)
        await state.emitter.emit(
            "model.response",
            {
                "finish_reason": response.finish_reason,
                "raw_finish_reason": response.raw_finish_reason,
                "content": _preview(response.content),
                "reasoning": _preview(response.reasoning),
                "tool_calls": [{"id": c.id, "name": c.name} for c in response.tool_calls],
                # The list above is capped in events; the count is always exact.
                "tool_call_count": len(response.tool_calls),
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                    "cached_input_tokens": response.usage.cached_input_tokens,
                    "reasoning_tokens": response.usage.reasoning_tokens,
                },
                "cost": _cost_dict(cost),
                "model": response.model,
                "provider_request_id": response.provider_request_id,
                "attempts": response.attempts,
            },
            step=step,
            duration_ms=response.latency_ms,
        )
        if response.finish_reason == "refusal":
            raise ExecutionFailure(
                "model_refused",
                "The model declined this request.",
                details={"category": response.refusal_category},
            )
        if response.tool_calls:
            messages.append(
                ChatMessage(
                    role="assistant",
                    content=response.content or None,
                    tool_calls=response.tool_calls,
                    provider_state=response.provider_state,
                    provider_kind=state.provider.kind,
                )
            )
            for call in response.tool_calls:
                if state.tool_calls >= max_tool_calls:
                    raise ExecutionFailure(
                        "limit_exceeded",
                        f"The agent tried more than {max_tool_calls} tool calls.",
                        details={"limit": "max_tool_calls", "value": max_tool_calls},
                    )
                state.tool_calls += 1
                result = await _run_tool_call(state, step, call.id, call.name, call.arguments)
                messages.append(
                    ChatMessage(
                        role="tool",
                        content=str(result.output),
                        tool_call_id=call.id,
                        tool_name=call.name,
                        is_error=not result.ok,
                    )
                )
            async with get_sessionmaker()() as db:
                await db.execute(
                    update(Execution)
                    .where(Execution.id == execution.id)
                    .values(tool_calls=state.tool_calls, steps=step)
                )
                await db.commit()
            continue
        if response.finish_reason == "length" and not response.content:
            raise ExecutionFailure(
                "output_truncated",
                "The model hit its output limit before answering."
                " Raise max output tokens or simplify the request.",
            )
        output: dict[str, Any] = {"text": response.content}
        if response.finish_reason == "length":
            output["truncated"] = True
            await state.emitter.emit(
                "log",
                {"message": "The answer was cut by the output token limit."},
                level="warning",
                step=step,
            )
        if parameters.get("response_format") == "json":
            try:
                output["json"] = json.loads(response.content)
            except json.JSONDecodeError:
                await state.emitter.emit(
                    "log",
                    {"message": "JSON output was requested but the answer is not valid JSON."},
                    level="warning",
                    step=step,
                )
        return output
    raise ExecutionFailure(
        "limit_exceeded",
        f"The agent did not finish within {max_steps} model turns.",
        details={"limit": "max_steps", "value": max_steps},
    )


async def _finish(
    state: RunState | None,
    execution_id: uuid.UUID,
    status: ExecutionStatus,
    *,
    output: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    """Terminal state and terminal event are committed together: a finished execution always
    has its closing event, and the event never precedes the state."""
    if state is not None:
        await state.emitter.flush_deltas()
    now = utcnow()
    async with get_sessionmaker()() as db:
        execution = await db.get(Execution, execution_id, with_for_update=True)
        if execution is None or execution.status not in (
            ExecutionStatus.RUNNING,
            ExecutionStatus.QUEUED,
        ):
            return  # already finalised (cancelled in queue, reaped...)
        execution.status = status
        execution.output = output
        execution.error = error
        execution.finished_at = now
        execution.duration_ms = int((now - (execution.started_at or now)).total_seconds() * 1000)
        execution.lease_expires_at = None
        if state is not None:
            execution.steps = state.steps
            execution.tool_calls = state.tool_calls
        payload: dict[str, Any] = {
            "duration_ms": execution.duration_ms,
            "usage": {
                "input_tokens": execution.input_tokens,
                "output_tokens": execution.output_tokens,
                "cached_tokens": execution.cached_tokens,
                "reasoning_tokens": execution.reasoning_tokens,
            },
            "cost": {
                "amount": str(execution.cost_amount) if execution.cost_amount is not None else None,
                "currency": execution.cost_currency,
                "source": execution.cost_source,
                "partial": execution.cost_partial,
            },
            "model_calls": execution.model_calls,
            "tool_calls": execution.tool_calls,
        }
        if output is not None:
            payload["output"] = {
                "text": _preview(output.get("text")),
                "has_json": "json" in output,
                "truncated": bool(output.get("truncated")),
            }
        if error is not None:
            payload["error"] = error
        level = (
            "info"
            if status == ExecutionStatus.SUCCEEDED
            else ("warning" if status == ExecutionStatus.CANCELLED else "error")
        )
        await db.flush()
        event = await append_event(
            db,
            execution.id,
            execution.workspace_id,
            f"execution.{status.value}",
            payload,
            level=level,
        )
        if event is not None:
            event.duration_ms = execution.duration_ms
        await db.commit()
        await db.refresh(execution)
        snapshot = execution
    if event is not None:
        await publish_event(event)
    await publish_status(snapshot)
    if snapshot.trigger == "evaluation":
        from gouvra.modules.evaluations.service import notify_evaluations

        await notify_evaluations()
    if snapshot.workflow_run_id is not None:
        from gouvra.modules.workflows.orchestrator import notify_workflows

        await notify_workflows(snapshot.workflow_run_id)
    if snapshot.agent_id is not None:
        from gouvra.modules.agents.models import Agent

        async with get_sessionmaker()() as db:
            await db.execute(
                update(Agent).where(Agent.id == snapshot.agent_id).values(last_execution_at=now)
            )
            await db.commit()


async def run_execution(
    execution_id: uuid.UUID, *, worker_id: str, shutting_down: asyncio.Event | None = None
) -> None:
    state: RunState | None = None
    adapter: ModelAdapter | None = None
    try:
        execution, version, provider, tools = await _load(execution_id)
        emitter = EventEmitter(execution.id, execution.workspace_id, execution.last_event_seq)
        state = RunState(
            execution=execution, version=version, provider=provider, tools=tools, emitter=emitter
        )
        await publish_status(execution)
        await emitter.emit(
            "execution.started",
            {
                "worker": worker_id,
                "attempt": execution.attempt,
                "agent_version": version.number,
                "overrides": version.overridden,
                "model": version.model,
                "provider": provider.kind,
                "provider_name": provider.name,
                "tools": sorted(tools),
                "limits": version.limits,
                "timeout_s": execution.timeout_s,
            },
        )
        try:
            adapter = await adapter_for(provider, timeout_s=float(execution.timeout_s))
        except GatewayError as exc:
            raise ExecutionFailure(exc.code.value, exc.message, details=exc.as_dict()) from exc
        async with asyncio.timeout(execution.timeout_s):
            output = await _agent_loop(state, adapter)
        await _finish(state, execution_id, ExecutionStatus.SUCCEEDED, output=output)
    except TimeoutError:
        await _finish(
            state,
            execution_id,
            ExecutionStatus.TIMED_OUT,
            error={
                "code": "timeout",
                "message": "The execution exceeded its time limit"
                f" ({state.execution.timeout_s if state else '?'} s).",
                "retryable": True,
            },
        )
    except asyncio.CancelledError:
        task = asyncio.current_task()
        if task is not None:
            task.uncancel()
        if (
            shutting_down is not None
            and shutting_down.is_set()
            and not await _cancel_requested(execution_id)
        ):
            await _finish(
                state,
                execution_id,
                ExecutionStatus.FAILED,
                error={
                    "code": "worker_shutdown",
                    "message": "The worker stopped during this execution. Retry it.",
                    "retryable": True,
                },
            )
        else:
            await _finish(
                state,
                execution_id,
                ExecutionStatus.CANCELLED,
                error={"code": "cancelled", "message": "Cancelled on request.", "retryable": False},
            )
    except ExecutionFailure as failure:
        await _finish(state, execution_id, ExecutionStatus.FAILED, error=failure.as_dict())
    except Exception:
        log.exception("execution_internal_error", execution_id=str(execution_id))
        await _finish(
            state,
            execution_id,
            ExecutionStatus.FAILED,
            error={
                "code": "internal_error",
                "message": "Gouvra hit an internal error while running this execution.",
                "retryable": True,
            },
        )
    finally:
        if adapter is not None:
            with contextlib.suppress(Exception):
                await adapter.aclose()
        if state is not None:
            await state.emitter.flush_deltas()


__all__ = ["CostSource", "ExecutionFailure", "run_execution"]
