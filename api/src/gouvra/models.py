"""Import every ORM model so that Alembic and the metadata see the whole schema."""

from __future__ import annotations

from gouvra.core.db import Base

__all__ = ["Base"]
