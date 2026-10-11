"""Cursor pagination: stable under inserts, opaque to clients."""

from __future__ import annotations

import base64
import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any

import orjson
from fastapi import Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, and_, or_
from sqlalchemy.orm import InstrumentedAttribute

from gouvra.core.errors import BadRequest

MAX_LIMIT = 100


class Page[T](BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    data: list[T]
    next_cursor: str | None = None
    has_more: bool = False


class PageParams(BaseModel):
    limit: int
    cursor: str | None


def page_params(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT, description="Page size (max 100)")] = 25,
    cursor: Annotated[
        str | None, Query(max_length=200, description="`next_cursor` of the previous page")
    ] = None,
) -> PageParams:
    return PageParams(limit=limit, cursor=cursor)


def encode_cursor(created_at: datetime, row_id: uuid.UUID) -> str:
    raw = orjson.dumps([created_at.isoformat(), str(row_id)])
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        created, row_id = orjson.loads(raw)
        return datetime.fromisoformat(created), uuid.UUID(row_id)
    except (ValueError, TypeError) as exc:
        raise BadRequest("Invalid pagination cursor.", code="invalid_cursor") from exc


def paginate_desc(
    query: Select[Any],
    params: PageParams,
    created_col: InstrumentedAttribute[datetime],
    id_col: InstrumentedAttribute[uuid.UUID],
) -> Select[Any]:
    """Newest first. Fetches one extra row to know whether another page exists."""
    if params.cursor:
        created, row_id = decode_cursor(params.cursor)
        query = query.where(
            or_(created_col < created, and_(created_col == created, id_col < row_id))
        )
    return query.order_by(created_col.desc(), id_col.desc()).limit(params.limit + 1)


def build_page[T](items: Sequence[Any], params: PageParams, convert: Any, key: Any) -> Page[T]:
    """`key(item)` returns (created_at, id) for the cursor of the last item kept."""
    has_more = len(items) > params.limit
    kept = list(items[: params.limit])
    next_cursor = encode_cursor(*key(kept[-1])) if has_more and kept else None
    return Page[T](data=[convert(i) for i in kept], next_cursor=next_cursor, has_more=has_more)
