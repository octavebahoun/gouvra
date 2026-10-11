"""Strict JSON Schema handling for tool inputs (Draft 2020-12)."""

from __future__ import annotations

import copy
import json
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError

from gouvra.core.errors import ValidationFailed

MAX_SCHEMA_BYTES = 32_768
MAX_ERRORS = 5


def check_input_schema(schema: dict[str, Any], field: str = "input_schema") -> dict[str, Any]:
    """A tool schema must be a valid Draft 2020-12 object schema without remote references."""
    problems: list[str] = []
    if len(json.dumps(schema)) > MAX_SCHEMA_BYTES:
        problems.append(f"The schema is larger than {MAX_SCHEMA_BYTES // 1024} KB.")
    if schema.get("type") != "object":
        problems.append('The top-level schema must have "type": "object".')
    if '"$ref": "http' in json.dumps(schema) or "$dynamicRef" in json.dumps(schema):
        problems.append("Remote references are not allowed.")
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        problems.append(f"Invalid JSON Schema: {exc.message}")
    if problems:
        raise ValidationFailed(
            errors=[{"field": field, "code": "invalid_schema", "message": p} for p in problems]
        )
    return schema


def strict(schema: dict[str, Any]) -> dict[str, Any]:
    """Objects reject unknown properties unless the schema explicitly allows them."""
    out = copy.deepcopy(schema)

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if (
                node.get("type") == "object"
                and "additionalProperties" not in node
                and "properties" in node
            ):
                node["additionalProperties"] = False
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(out)
    return out


def validate_arguments(schema: dict[str, Any], arguments: Any) -> list[str]:
    """Return human-readable validation errors (empty when valid)."""
    validator = Draft202012Validator(strict(schema), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(arguments), key=lambda e: list(e.path))
    out: list[str] = []
    for error in errors[:MAX_ERRORS]:
        location = "/".join(str(p) for p in error.path) or "(root)"
        out.append(f"{location}: {error.message}")
    return out
