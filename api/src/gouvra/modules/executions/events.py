"""Execution events: persisted (ordered by `seq`) and published live on Valkey for SSE clients.

Token deltas are published only (not persisted): the final model response is the record.
Every payload is redacted (secrets, personal data) and size-capped before leaving the worker.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import orjson
from sqlalchemy import update

from gouvra.core.db import get_sessionmaker, utcnow
from gouvra.core.logging import get_logger, redact
from gouvra.core.redis import get_redis
from gouvra.modules.executions.models import Execution, ExecutionEvent

log = get_logger(__name__)

MAX_STRING = 8_000
MAX_ITEMS = 100
DELTA_FLUSH_S = 0.06


def execution_channel(execution_id: uuid.UUID | str) -> str:
    return f"gouvra:exec:{execution_id}"


def workspace_channel(workspace_id: uuid.UUID | str) -> str:
    return f"gouvra:ws:{workspace_id}"


def cap(value: Any, *, depth: int = 0) -> Any:
    """Bound the size of event payloads (long strings and lists are truncated, with a marker)."""
    if depth > 6:
        return "[…]"
    if isinstance(value, str):
        return (
            value
            if len(value) <= MAX_STRING
            else value[:MAX_STRING] + f"… [{len(value) - MAX_STRING} more characters]"
        )
    if isinstance(value, dict):
        return {str(k): cap(v, depth=depth + 1) for k, v in list(value.items())[:MAX_ITEMS]}
    if isinstance(value, list | tuple):
        items = [cap(v, depth=depth + 1) for v in list(value)[:MAX_ITEMS]]
        if len(value) > MAX_ITEMS:
            items.append(f"[{len(value) - MAX_ITEMS} more items]")
        return items
    return value


def event_payload(event: ExecutionEvent) -> dict[str, Any]:
    return {
        "seq": event.seq,
        "type": event.type,
        "level": event.level,
        "step": event.step,
        "duration_ms": event.duration_ms,
        "data": event.data,
        "created_at": event.created_at.isoformat(),
    }


async def publish(channel: str, message: dict[str, Any]) -> None:
    try:
        await get_redis().publish(channel, orjson.dumps(message, default=str).decode())
    except Exception as exc:  # noqa: BLE001 - live updates are best-effort; DB events are the record
        log.warning("live_publish_failed", error=type(exc).__name__)


class EventEmitter:
    def __init__(self, execution_id: uuid.UUID, workspace_id: uuid.UUID, last_seq: int = 0) -> None:
        self.execution_id = execution_id
        self.workspace_id = workspace_id
        self.seq = last_seq
        self._lock = asyncio.Lock()
        self._delta_buffer: list[tuple[int | None, str, str]] = []
        self._delta_task: asyncio.Task[None] | None = None

    async def emit(
        self,
        type_: str,
        data: dict[str, Any] | None = None,
        *,
        level: str = "info",
        step: int | None = None,
        duration_ms: int | None = None,
    ) -> ExecutionEvent:
        await self.flush_deltas()
        async with self._lock, get_sessionmaker()() as db:
            # Sequence numbers are allocated by the database (row lock on the execution):
            # the API and the worker can both emit events for the same execution safely.
            seq = (
                await db.execute(
                    update(Execution)
                    .where(Execution.id == self.execution_id)
                    .values(last_event_seq=Execution.last_event_seq + 1)
                    .returning(Execution.last_event_seq)
                )
            ).scalar_one()
            event = ExecutionEvent(
                execution_id=self.execution_id,
                workspace_id=self.workspace_id,
                seq=seq,
                type=type_,
                level=level,
                step=step,
                duration_ms=duration_ms,
                data=cap(redact(data or {})),
                created_at=utcnow(),
            )
            db.add(event)
            await db.commit()
            self.seq = seq
        await publish(
            execution_channel(self.execution_id), {"kind": "event", "event": event_payload(event)}
        )
        return event

    # ------------------------------------------------------------------ live token deltas

    def delta_callback(self, step: int) -> Any:
        async def on_delta(delta: Any) -> None:
            self._delta_buffer.append((step, delta.kind, delta.text))
            if self._delta_task is None or self._delta_task.done():
                self._delta_task = asyncio.create_task(self._flush_later())

        return on_delta

    async def _flush_later(self) -> None:
        await asyncio.sleep(DELTA_FLUSH_S)
        await self._flush()

    async def _flush(self) -> None:
        if not self._delta_buffer:
            return
        buffered, self._delta_buffer = self._delta_buffer, []
        merged: list[dict[str, Any]] = []
        for step, stream, text in buffered:
            if merged and merged[-1]["step"] == step and merged[-1]["stream"] == stream:
                merged[-1]["text"] += text
            else:
                merged.append({"step": step, "stream": stream, "text": text})
        for chunk in merged:
            if not chunk["text"]:
                continue
            chunk["text"] = redact(chunk["text"])
            await publish(
                execution_channel(self.execution_id),
                {"kind": "delta", "after_seq": self.seq, **chunk},
            )

    async def flush_deltas(self) -> None:
        if self._delta_task is not None and not self._delta_task.done():
            self._delta_task.cancel()
        await self._flush()


async def append_event(
    db: Any,
    execution_id: uuid.UUID,
    workspace_id: uuid.UUID,
    type_: str,
    data: dict[str, Any],
    *,
    level: str = "info",
    extra_values: dict[str, Any] | None = None,
    only_if_status: str | None = None,
) -> ExecutionEvent | None:
    """Append an event inside the caller's transaction (atomic with other changes).

    Returns None when `only_if_status` no longer matches. Publish with `publish_event`
    after the caller commits.
    """
    statement = (
        update(Execution)
        .where(Execution.id == execution_id)
        .values(last_event_seq=Execution.last_event_seq + 1, **(extra_values or {}))
        .returning(Execution.last_event_seq)
    )
    if only_if_status is not None:
        statement = statement.where(Execution.status == only_if_status)
    seq = (await db.execute(statement)).scalar_one_or_none()
    if seq is None:
        return None
    event = ExecutionEvent(
        execution_id=execution_id,
        workspace_id=workspace_id,
        seq=seq,
        type=type_,
        level=level,
        data=cap(redact(data)),
        created_at=utcnow(),
    )
    db.add(event)
    return event


async def publish_event(event: ExecutionEvent) -> None:
    await publish(
        execution_channel(event.execution_id), {"kind": "event", "event": event_payload(event)}
    )


async def publish_status(execution: Execution) -> None:
    """Workspace-level live feed (lists, overview) — one small message per state change."""
    await publish(
        workspace_channel(execution.workspace_id),
        {
            "kind": "execution.status",
            "execution_id": str(execution.id),
            "agent_id": str(execution.agent_id) if execution.agent_id else None,
            "status": execution.status,
            "at": utcnow().isoformat(),
        },
    )
