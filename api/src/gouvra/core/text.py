"""Text rules shared by request schemas."""

from __future__ import annotations

import re

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def single_line(value: str) -> str:
    """Names travel into e-mail subjects and logs: no line break or other control character."""
    if _CONTROL.search(value):
        raise ValueError("Use a single line, without control characters.")
    return value
