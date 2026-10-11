"""Graders: exact, contains, regex (time-boxed), JSON Schema, LLM judge.

Every grader returns a score in [0, 1] and a pass/fail verdict, with details a person can read.
A grader that cannot run (bad pattern, judge failure) reports `error` instead of guessing.
"""

from __future__ import annotations

import json
import re as std_re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Annotated, Any, Literal

import regex
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, Field, TypeAdapter

REGEX_TIMEOUT_S = 0.5
MAX_GRADED_CHARS = 100_000


class ExactGrader(BaseModel):
    type: Literal["exact"] = "exact"
    expected: str | None = Field(
        default=None, max_length=20_000, description="Defaults to the case's expected text"
    )
    case_sensitive: bool = False
    trim: bool = True
    weight: float = Field(default=1.0, gt=0, le=10)


class ContainsGrader(BaseModel):
    type: Literal["contains"] = "contains"
    values: list[Annotated[str, Field(min_length=1, max_length=2_000)]] = Field(
        min_length=1, max_length=20
    )
    mode: Literal["all", "any", "none"] = "all"
    case_sensitive: bool = False
    weight: float = Field(default=1.0, gt=0, le=10)


class RegexGrader(BaseModel):
    type: Literal["regex"] = "regex"
    pattern: str = Field(min_length=1, max_length=500)
    ignore_case: bool = False
    should_match: bool = True
    weight: float = Field(default=1.0, gt=0, le=10)


class JsonSchemaGrader(BaseModel):
    type: Literal["json_schema"] = "json_schema"
    json_schema: dict[str, Any] = Field(alias="schema")
    weight: float = Field(default=1.0, gt=0, le=10)

    model_config = {"populate_by_name": True}


class LlmJudgeGrader(BaseModel):
    type: Literal["llm_judge"] = "llm_judge"
    provider_id: str
    model: str = Field(min_length=1, max_length=120)
    rubric: str = Field(min_length=10, max_length=8_000)
    pass_threshold: float = Field(default=0.7, ge=0, le=1)
    weight: float = Field(default=1.0, gt=0, le=10)


GraderSpec = Annotated[
    ExactGrader | ContainsGrader | RegexGrader | JsonSchemaGrader | LlmJudgeGrader,
    Field(discriminator="type"),
]
GRADERS_ADAPTER: TypeAdapter[list[GraderSpec]] = TypeAdapter(list[GraderSpec])


@dataclass
class GraderResult:
    type: str
    passed: bool
    score: float
    details: str
    error: str | None = None
    weight: float = 1.0
    cost: Decimal | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "passed": self.passed,
            "score": round(self.score, 4),
            "details": self.details,
            "error": self.error,
            "weight": self.weight,
            **({"cost": str(self.cost)} if self.cost is not None else {}),
            **self.extra,
        }


def _normalise(text: str, *, case_sensitive: bool, trim: bool = True) -> str:
    value = text.strip() if trim else text
    value = std_re.sub(r"\s+", " ", value) if trim else value
    return value if case_sensitive else value.casefold()


def grade_exact(spec: ExactGrader, output: str, expected: dict[str, Any] | None) -> GraderResult:
    target = spec.expected if spec.expected is not None else (expected or {}).get("text")
    if target is None:
        return GraderResult(
            "exact",
            False,
            0.0,
            "No expected text for this case.",
            error="missing_expected",
            weight=spec.weight,
        )
    ok = _normalise(output, case_sensitive=spec.case_sensitive, trim=spec.trim) == _normalise(
        str(target), case_sensitive=spec.case_sensitive, trim=spec.trim
    )
    return GraderResult(
        "exact",
        ok,
        1.0 if ok else 0.0,
        "Output equals the expected text." if ok else "Output differs from the expected text.",
        weight=spec.weight,
    )


def grade_contains(spec: ContainsGrader, output: str) -> GraderResult:
    haystack = output if spec.case_sensitive else output.casefold()
    found = [v for v in spec.values if (v if spec.case_sensitive else v.casefold()) in haystack]
    if spec.mode == "all":
        ok, score = len(found) == len(spec.values), len(found) / len(spec.values)
    elif spec.mode == "any":
        ok = bool(found)
        score = 1.0 if ok else 0.0
    else:
        ok = not found
        score = 1.0 if ok else 0.0
    missing = [v for v in spec.values if v not in found]
    details = f"Found {len(found)}/{len(spec.values)}" + (
        f"; missing: {', '.join(missing[:5])}" if missing and spec.mode != "none" else ""
    )
    return GraderResult("contains", ok, score, details, weight=spec.weight)


def grade_regex(spec: RegexGrader, output: str) -> GraderResult:
    try:
        compiled = regex.compile(spec.pattern, flags=regex.IGNORECASE if spec.ignore_case else 0)
        match = compiled.search(output[:MAX_GRADED_CHARS], timeout=REGEX_TIMEOUT_S)
    except regex.error as exc:
        return GraderResult(
            "regex",
            False,
            0.0,
            f"Invalid pattern: {exc}",
            error="invalid_pattern",
            weight=spec.weight,
        )
    except TimeoutError:
        return GraderResult(
            "regex",
            False,
            0.0,
            "The pattern took too long to evaluate.",
            error="regex_timeout",
            weight=spec.weight,
        )
    ok = (match is not None) == spec.should_match
    details = ("Pattern matched" if match else "Pattern did not match") + (
        f": {match.group(0)[:120]!r}" if match else ""
    )
    return GraderResult("regex", ok, 1.0 if ok else 0.0, details, weight=spec.weight)


def _output_json(output: str, output_json: Any) -> Any:
    if output_json is not None:
        return output_json
    text = output.strip()
    fenced = std_re.search(r"```(?:json)?\s*(.*?)```", text, std_re.DOTALL)
    if fenced:
        text = fenced.group(1)
    return json.loads(text)


def grade_json_schema(spec: JsonSchemaGrader, output: str, output_json: Any) -> GraderResult:
    try:
        Draft202012Validator.check_schema(spec.json_schema)
    except SchemaError as exc:
        return GraderResult(
            "json_schema",
            False,
            0.0,
            f"Invalid schema: {exc.message}",
            error="invalid_schema",
            weight=spec.weight,
        )
    try:
        data = _output_json(output, output_json)
    except (json.JSONDecodeError, ValueError):
        return GraderResult(
            "json_schema", False, 0.0, "The output is not valid JSON.", weight=spec.weight
        )
    errors = list(
        Draft202012Validator(spec.json_schema, format_checker=FormatChecker()).iter_errors(data)
    )
    if errors:
        first = errors[0]
        where = "/".join(str(p) for p in first.path) or "(root)"
        return GraderResult(
            "json_schema",
            False,
            0.0,
            f"{len(errors)} violation(s); first at {where}: {first.message}",
            weight=spec.weight,
        )
    return GraderResult(
        "json_schema", True, 1.0, "The output matches the schema.", weight=spec.weight
    )


JUDGE_SYSTEM = (
    "You are a strict, fair evaluator. Grade the RESPONSE against the RUBRIC. "
    "Reply with a single JSON object: "
    '{"score": <number between 0 and 1>, "reasoning": "<one or two sentences>"}.'
)


def judge_prompt(rubric: str, case_input: str, output: str, expected: dict[str, Any] | None) -> str:
    parts = [f"RUBRIC:\n{rubric}", f"INPUT:\n{case_input[:8000]}", f"RESPONSE:\n{output[:16000]}"]
    if expected and expected.get("text"):
        parts.append(f"REFERENCE ANSWER:\n{str(expected['text'])[:8000]}")
    return "\n\n".join(parts)


def parse_judge(text: str) -> tuple[float, str]:
    data = _output_json(text, None)
    score = float(data["score"])
    if score > 1 and score <= 10:
        score /= 10
    if not 0 <= score <= 1:
        raise ValueError("score out of range")
    return score, str(data.get("reasoning", ""))[:500]


def combine(results: list[GraderResult], pass_threshold: float) -> tuple[str, float | None]:
    """Weighted mean score.

    A case passes when every grader passes and the score clears the threshold.
    """
    if not results:
        return "errored", None
    if any(r.error for r in results):
        return "errored", None
    total_weight = sum(r.weight for r in results)
    score = sum(r.score * r.weight for r in results) / total_weight
    passed = all(r.passed for r in results) and score >= pass_threshold - 1e-9
    return ("passed" if passed else "failed"), round(score, 4)
