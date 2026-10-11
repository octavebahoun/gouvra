"""Built-in tools. Pure functions or SSRF-guarded HTTP — never user-supplied code."""

from __future__ import annotations

import ast
import math
import operator
import re
import secrets
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones


class ToolInputError(Exception):
    """The arguments are well-formed but cannot be processed (shown to the model)."""


ToolFn = Callable[[dict[str, Any], dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class BuiltinTool:
    key: str
    name: str
    display_name: str
    description: str
    input_schema: dict[str, Any]
    run: ToolFn
    config_schema: dict[str, Any] = field(
        default_factory=lambda: {"type": "object", "properties": {}, "additionalProperties": False}
    )
    uses_network: bool = False


# ---------------------------------------------------------------- calculator

_BIN_OPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY: dict[type[ast.unaryop], Callable[[Any], Any]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_FUNCS: dict[str, Callable[..., float]] = {
    "sqrt": math.sqrt,
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "floor": math.floor,
    "ceil": math.ceil,
    "log": math.log,
    "log10": math.log10,
    "log2": math.log2,
    "exp": math.exp,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
MAX_EXPRESSION = 300


def safe_eval(expression: str) -> float | int:
    """Arithmetic only: parsed with `ast`, whitelisted nodes, bounded powers. No `eval`."""
    if len(expression) > MAX_EXPRESSION:
        raise ToolInputError(f"Expression longer than {MAX_EXPRESSION} characters.")
    try:
        tree = ast.parse(expression.replace("^", "**"), mode="eval")
    except SyntaxError as exc:
        raise ToolInputError("The expression is not valid arithmetic.") from exc

    def walk(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, int | float)
            and not isinstance(node.value, bool)
        ):
            return node.value
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
            left, right = walk(node.left), walk(node.right)
            if isinstance(node.op, ast.Pow) and (abs(right) > 1000 or abs(left) > 1e9):
                raise ToolInputError("Exponent too large.")
            return _BIN_OPS[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            return _UNARY[type(node.op)](walk(node.operand))
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in _FUNCS
            and not node.keywords
        ):
            if len(node.args) > 10:
                raise ToolInputError("Too many arguments.")
            return _FUNCS[node.func.id](*(walk(a) for a in node.args))
        raise ToolInputError(f"Unsupported element: {type(node).__name__}.")

    try:
        result = walk(tree)
    except ZeroDivisionError as exc:
        raise ToolInputError("Division by zero.") from exc
    except (OverflowError, ValueError) as exc:
        raise ToolInputError(f"Math error: {exc}.") from exc
    if isinstance(result, float) and (math.isnan(result) or math.isinf(result)):
        raise ToolInputError("The result is not a finite number.")
    if not isinstance(result, int | float):
        raise ToolInputError("The expression did not produce a number.")
    return result


async def _calculator(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    expression = str(args["expression"])
    return {"expression": expression, "result": safe_eval(expression)}


# ---------------------------------------------------------------- time & dates


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ToolInputError(
            f"Unknown time zone {name!r}. Use an IANA name such as Europe/Paris."
        ) from exc


async def _current_time(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    zone = _zone(args.get("timezone"))
    now = datetime.now(UTC).astimezone(zone)
    return {
        "iso": now.isoformat(timespec="seconds"),
        "timezone": str(zone.key),
        "date": now.date().isoformat(),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "unix": int(now.timestamp()),
        "utc_offset": now.strftime("%z"),
    }


def _parse_date(value: str, field_name: str) -> date:
    try:
        return date.fromisoformat(value[:10])
    except ValueError as exc:
        raise ToolInputError(f"{field_name} must be an ISO date (YYYY-MM-DD).") from exc


async def _date_calc(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    start = _parse_date(str(args["date"]), "date")
    if args["operation"] == "add":
        days = int(args.get("days", 0))
        if abs(days) > 365_000:
            raise ToolInputError("days is out of range.")
        result = start + timedelta(days=days)
        return {"date": result.isoformat(), "weekday": result.strftime("%A")}
    other = _parse_date(str(args.get("other_date") or ""), "other_date")
    delta = (other - start).days
    return {"days": delta, "weeks": round(delta / 7, 2)}


# ---------------------------------------------------------------- data & text


_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


async def _json_extract(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    node: Any = args["data"]
    path = str(args["path"]).strip()
    for match in _PATH_TOKEN.finditer(path.removeprefix("$").lstrip(".")):
        key, index = match.group(1), match.group(2)
        try:
            node = node[int(index)] if index is not None else node[key]
        except (KeyError, IndexError, TypeError):
            return {"found": False, "path": path}
    return {"found": True, "path": path, "value": node}


async def _text_stats(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    text = str(args["text"])
    words = re.findall(r"\b\w+\b", text)
    sentences = [s for s in re.split(r"[.!?]+(?:\s|$)", text) if s.strip()]
    return {
        "characters": len(text),
        "words": len(words),
        "sentences": len(sentences),
        "lines": text.count("\n") + 1 if text else 0,
        "reading_time_seconds": round(len(words) / 238 * 60),
    }


async def _random(args: dict[str, Any], _: dict[str, Any]) -> dict[str, Any]:
    count = int(args.get("count", 1))
    if args.get("kind", "uuid") == "uuid":
        return {"values": [str(uuid.uuid4()) for _ in range(count)]}
    low, high = int(args.get("min", 0)), int(args.get("max", 100))
    if low > high:
        raise ToolInputError("min must be lower than or equal to max.")
    return {"values": [low + secrets.randbelow(high - low + 1) for _ in range(count)]}


async def _http_request(args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    from gouvra.modules.tools.http_client import fetch

    return await fetch(
        method=str(args.get("method", "GET")),
        url=str(args["url"]),
        headers={str(k): str(v) for k, v in (args.get("headers") or {}).items()},
        json_body=args.get("json"),
        allowed_hosts=[str(h) for h in config.get("allowed_hosts", [])],
        allowed_methods=[str(m).upper() for m in config.get("allowed_methods", ["GET"])],
        max_response_bytes=int(config.get("max_response_bytes", 65_536)),
    )


BUILTINS: dict[str, BuiltinTool] = {
    tool.key: tool
    for tool in (
        BuiltinTool(
            "calculator",
            "calculator",
            "Calculator",
            "Evaluate an arithmetic expression (+ - * / // % **, parentheses, sqrt, log, exp,"
            " sin, cos, tan, abs, round, min, max, pi, e).",
            {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_EXPRESSION,
                        "description": "e.g. (12.5 * 4) / sqrt(16)",
                    }
                },
                "required": ["expression"],
                "additionalProperties": False,
            },
            _calculator,
        ),
        BuiltinTool(
            "current_time",
            "current_time",
            "Clock",
            "Current date and time in a given IANA time zone (default UTC).",
            {
                "type": "object",
                "properties": {
                    "timezone": {
                        "type": "string",
                        "maxLength": 64,
                        "description": "IANA time zone, e.g. Europe/Paris",
                    }
                },
                "additionalProperties": False,
            },
            _current_time,
        ),
        BuiltinTool(
            "date_calc",
            "date_calc",
            "Date calculator",
            "Add days to a date, or count the days between two dates (ISO YYYY-MM-DD).",
            {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "enum": ["add", "diff"]},
                    "date": {"type": "string", "description": "ISO date"},
                    "days": {"type": "integer", "description": "Days to add (operation=add)"},
                    "other_date": {
                        "type": "string",
                        "description": "Second ISO date (operation=diff)",
                    },
                },
                "required": ["operation", "date"],
                "additionalProperties": False,
            },
            _date_calc,
        ),
        BuiltinTool(
            "json_extract",
            "json_extract",
            "JSON extract",
            "Read a value from JSON data with a path such as items[0].price.",
            {
                "type": "object",
                "properties": {
                    "data": {"description": "Any JSON value"},
                    "path": {"type": "string", "maxLength": 300},
                },
                "required": ["data", "path"],
                "additionalProperties": False,
            },
            _json_extract,
        ),
        BuiltinTool(
            "text_stats",
            "text_stats",
            "Text statistics",
            "Count characters, words, sentences and lines; estimate reading time.",
            {
                "type": "object",
                "properties": {"text": {"type": "string", "maxLength": 200_000}},
                "required": ["text"],
                "additionalProperties": False,
            },
            _text_stats,
        ),
        BuiltinTool(
            "random",
            "random",
            "Random values",
            "Generate UUIDs or random integers.",
            {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["uuid", "integer"]},
                    "count": {"type": "integer", "minimum": 1, "maximum": 20},
                    "min": {"type": "integer"},
                    "max": {"type": "integer"},
                },
                "additionalProperties": False,
            },
            _random,
        ),
        BuiltinTool(
            "http_request",
            "http_request",
            "HTTP request",
            "Call an HTTP API on an allowed host and return the status and body"
            " (JSON or text, truncated).",
            {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                    "url": {"type": "string", "format": "uri", "maxLength": 2048},
                    "headers": {
                        "type": "object",
                        "additionalProperties": {"type": "string", "maxLength": 1024},
                        "maxProperties": 20,
                    },
                    "json": {"description": "JSON body for POST/PUT/PATCH"},
                },
                "required": ["url"],
                "additionalProperties": False,
            },
            _http_request,
            config_schema={
                "type": "object",
                "properties": {
                    "allowed_hosts": {
                        "type": "array",
                        "items": {"type": "string", "maxLength": 253},
                        "minItems": 1,
                        "maxItems": 50,
                    },
                    "allowed_methods": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                        },
                    },
                    "max_response_bytes": {
                        "type": "integer",
                        "minimum": 1024,
                        "maximum": 1_048_576,
                    },
                },
                "required": ["allowed_hosts"],
                "additionalProperties": False,
            },
            uses_network=True,
        ),
    )
}

TIMEZONES = frozenset(available_timezones())
