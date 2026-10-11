"""Workflow graphs: nodes, edges, validation, templates and conditions.

A workflow is a directed acyclic graph. Data moves along edges through templates such as
`{{input}}`, `{{steps.classify.output}}` or `{{steps.lookup.json.order.id}}`, rendered by a
small substitution engine: no expression language, no code, nothing to inject into.
"""

from __future__ import annotations

import json
import re
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

import regex
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, Field, StringConstraints

MAX_NODES = 60
MAX_EDGES = 150
MAX_TEMPLATE = 20_000
CONDITION_REGEX_TIMEOUT_S = 0.2
DEFAULT_TIMEOUT_S = 900
STEP_FIELDS = ("output", "json", "status", "error")

NodeId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Template = Annotated[str, StringConstraints(max_length=MAX_TEMPLATE)]


class Position(BaseModel):
    x: float = 0
    y: float = 0


class _Node(BaseModel):
    id: NodeId
    label: Label
    position: Position = Field(default_factory=Position)


class StartNode(_Node):
    type: Literal["start"] = "start"
    input_schema: dict[str, Any] | None = Field(
        default=None, description="Optional JSON Schema the run input must match"
    )


class AgentNode(_Node):
    type: Literal["agent"] = "agent"
    agent_id: uuid.UUID
    version: int | None = Field(default=None, ge=1, description="Pinned version (else current)")
    input: Template = "{{input}}"
    retries: int = Field(default=0, ge=0, le=3, description="Relaunches after a retryable error")
    on_error: Literal["fail", "continue"] = "fail"


class ToolNode(_Node):
    type: Literal["tool"] = "tool"
    tool_id: uuid.UUID
    arguments: dict[str, Any] = Field(default_factory=dict)
    on_error: Literal["fail", "continue"] = "fail"


Operator = Literal[
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "matches",
    "is_empty",
    "not_empty",
    "gt",
    "gte",
    "lt",
    "lte",
]


class ConditionNode(_Node):
    type: Literal["condition"] = "condition"
    value: Template
    operator: Operator = "contains"
    operand: Annotated[str, StringConstraints(max_length=2_000)] = ""
    case_sensitive: bool = False


class TransformNode(_Node):
    type: Literal["transform"] = "transform"
    template: Template
    output: Literal["text", "json"] = "text"


class EndNode(_Node):
    type: Literal["end"] = "end"
    output: Template = Field(default="", description="Defaults to the output of the step before")


Node = Annotated[
    StartNode | AgentNode | ToolNode | ConditionNode | TransformNode | EndNode,
    Field(discriminator="type"),
]
AnyNode = StartNode | AgentNode | ToolNode | ConditionNode | TransformNode | EndNode


class Edge(BaseModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    source: NodeId
    target: NodeId
    branch: Literal["true", "false"] | None = None


class GraphSettings(BaseModel):
    timeout_s: int = Field(default=DEFAULT_TIMEOUT_S, ge=10, le=3600)


class Graph(BaseModel):
    nodes: list[Node] = Field(default_factory=list, max_length=MAX_NODES)
    edges: list[Edge] = Field(default_factory=list, max_length=MAX_EDGES)
    settings: GraphSettings = Field(default_factory=GraphSettings)


def starter_graph() -> Graph:
    return Graph(
        nodes=[
            StartNode(id="start", label="Input", position=Position(x=0, y=0)),
            EndNode(id="end", label="Output", position=Position(x=0, y=240)),
        ],
        edges=[Edge(id="start-end", source="start", target="end")],
    )


# ---------------------------------------------------------------- validation


@dataclass
class Issue:
    code: str
    message: str
    severity: Literal["error", "warning"] = "error"
    node_id: str | None = None
    edge_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
            "node_id": self.node_id,
            "edge_id": self.edge_id,
        }


@dataclass
class Analysis:
    nodes: dict[str, AnyNode]
    order: list[str]
    parents: dict[str, list[Edge]]
    children: dict[str, list[Edge]]
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    def ancestors(self, node_id: str) -> set[str]:
        seen: set[str] = set()
        queue = deque(edge.source for edge in self.parents.get(node_id, []))
        while queue:
            current = queue.popleft()
            if current not in seen:
                seen.add(current)
                queue.extend(edge.source for edge in self.parents.get(current, []))
        return seen


TEMPLATE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_\-]+)*)\s*\}\}")


def references(template: str) -> list[list[str]]:
    return [match.group(1).split(".") for match in TEMPLATE_RE.finditer(template)]


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def templates_of(node: AnyNode) -> list[str]:
    if isinstance(node, AgentNode):
        return [node.input]
    if isinstance(node, ToolNode):
        return _strings(node.arguments)
    if isinstance(node, ConditionNode):
        return [node.value, node.operand]
    if isinstance(node, TransformNode):
        return [node.template]
    if isinstance(node, EndNode):
        return [node.output]
    return []


def _check_structure(graph: Graph, analysis: Analysis) -> None:
    issues = analysis.issues
    starts = [n for n in graph.nodes if isinstance(n, StartNode)]
    if not starts:
        issues.append(Issue("missing_start", "Add an input step: every workflow starts there."))
    elif len(starts) > 1:
        for extra in starts[1:]:
            issues.append(
                Issue("multiple_starts", "A workflow has a single input step.", node_id=extra.id)
            )
    if not any(isinstance(n, EndNode) for n in graph.nodes):
        issues.append(Issue("missing_end", "Add an output step to return a result."))
    seen_pairs: set[tuple[str, str, str | None]] = set()
    for edge in graph.edges:
        if edge.source not in analysis.nodes or edge.target not in analysis.nodes:
            issues.append(
                Issue("unknown_endpoint", "This link points to a missing step.", edge_id=edge.id)
            )
            continue
        if edge.source == edge.target:
            issues.append(Issue("self_loop", "A step cannot feed itself.", edge_id=edge.id))
            continue
        pair = (edge.source, edge.target, edge.branch)
        if pair in seen_pairs:
            issues.append(
                Issue("duplicate_edge", "These steps are already linked.", edge_id=edge.id)
            )
            continue
        seen_pairs.add(pair)
        source, target = analysis.nodes[edge.source], analysis.nodes[edge.target]
        if isinstance(source, ConditionNode) and edge.branch is None:
            issues.append(
                Issue(
                    "missing_branch",
                    "Say whether this link is the “true” or the “false” branch.",
                    edge_id=edge.id,
                )
            )
        if not isinstance(source, ConditionNode) and edge.branch is not None:
            issues.append(
                Issue("unexpected_branch", "Only conditions have branches.", edge_id=edge.id)
            )
        if isinstance(target, StartNode):
            issues.append(
                Issue("start_has_input", "Nothing can lead into the input step.", edge_id=edge.id)
            )
        if isinstance(source, EndNode):
            issues.append(Issue("end_has_output", "An output step ends its path.", edge_id=edge.id))
        analysis.children[edge.source].append(edge)
        analysis.parents[edge.target].append(edge)


def _check_order(graph: Graph, analysis: Analysis) -> None:
    indegree = {node_id: len(analysis.parents[node_id]) for node_id in analysis.nodes}
    queue = deque(node.id for node in graph.nodes if indegree[node.id] == 0)
    while queue:
        current = queue.popleft()
        analysis.order.append(current)
        for edge in analysis.children[current]:
            indegree[edge.target] -= 1
            if indegree[edge.target] == 0:
                queue.append(edge.target)
    if len(analysis.order) != len(analysis.nodes):
        looping = [n for n in analysis.nodes if n not in analysis.order]
        for node_id in looping:
            analysis.issues.append(
                Issue(
                    "cycle", "This step is part of a loop; workflows run forward.", node_id=node_id
                )
            )
        analysis.order.extend(looping)


def _check_reachability(analysis: Analysis) -> None:
    starts = [n for n in analysis.nodes.values() if isinstance(n, StartNode)]
    if not starts:
        return
    reached: set[str] = set()
    queue = deque([starts[0].id])
    while queue:
        current = queue.popleft()
        if current in reached:
            continue
        reached.add(current)
        queue.extend(edge.target for edge in analysis.children[current])
    for node_id, node in analysis.nodes.items():
        if node_id not in reached:
            analysis.issues.append(
                Issue("unreachable", "No path from the input reaches this step.", node_id=node_id)
            )
        elif not isinstance(node, EndNode) and not analysis.children[node_id]:
            analysis.issues.append(
                Issue(
                    "dead_end",
                    "Nothing uses this step's result.",
                    severity="warning",
                    node_id=node_id,
                )
            )
        if isinstance(node, ConditionNode):
            branches = {edge.branch for edge in analysis.children[node_id]}
            for branch in ("true", "false"):
                if branch not in branches:
                    analysis.issues.append(
                        Issue(
                            f"no_{branch}_branch",
                            f"Nothing follows the “{branch}” branch: those runs stop here.",
                            severity="warning",
                            node_id=node_id,
                        )
                    )


def _check_templates(analysis: Analysis) -> None:
    for node_id, node in analysis.nodes.items():
        upstream = analysis.ancestors(node_id)
        for template in templates_of(node):
            for path in references(template):
                if path[0] == "input":
                    continue
                if path[0] != "steps" or len(path) < 2:
                    analysis.issues.append(
                        Issue(
                            "unknown_reference",
                            f"Unknown reference “{'.'.join(path)}”: use input or steps.<id>.",
                            node_id=node_id,
                        )
                    )
                elif path[1] not in upstream:
                    analysis.issues.append(
                        Issue(
                            "unavailable_reference",
                            f"“steps.{path[1]}” does not run before this step.",
                            node_id=node_id,
                        )
                    )
                elif len(path) > 2 and path[2] not in STEP_FIELDS:
                    analysis.issues.append(
                        Issue(
                            "unknown_field",
                            f"Use output, json, status or error after steps.{path[1]}.",
                            node_id=node_id,
                        )
                    )
        if isinstance(node, StartNode) and node.input_schema is not None:
            try:
                Draft202012Validator.check_schema(node.input_schema)
            except SchemaError as exc:
                analysis.issues.append(
                    Issue("invalid_input_schema", f"Invalid schema: {exc.message}", node_id=node_id)
                )
        if isinstance(node, ConditionNode) and node.operator == "matches":
            try:
                regex.compile(node.operand)
            except regex.error as exc:
                analysis.issues.append(
                    Issue("invalid_pattern", f"Invalid pattern: {exc}", node_id=node_id)
                )


def analyse(graph: Graph) -> Analysis:
    analysis = Analysis(nodes={}, order=[], parents={}, children={})
    for node in graph.nodes:
        if node.id in analysis.nodes:
            analysis.issues.append(
                Issue("duplicate_id", f"Two steps are called “{node.id}”.", node_id=node.id)
            )
            continue
        analysis.nodes[node.id] = node
        analysis.parents[node.id] = []
        analysis.children[node.id] = []
    _check_structure(graph, analysis)
    _check_order(graph, analysis)
    _check_reachability(analysis)
    _check_templates(analysis)
    return analysis


# ---------------------------------------------------------------- templates at run time


@dataclass
class StepValue:
    output: str | None = None
    json: Any = None
    status: str = "pending"
    error: str | None = None


@dataclass
class RunContext:
    input: dict[str, Any]
    steps: dict[str, StepValue] = field(default_factory=dict)


def _walk(value: Any, path: list[str]) -> Any:
    for key in path:
        if isinstance(value, dict):
            value = value.get(key)
        elif isinstance(value, list) and key.isdigit() and int(key) < len(value):
            value = value[int(key)]
        else:
            return None
    return value


def lookup(context: RunContext, path: list[str]) -> Any:
    if path[0] == "input":
        if "json" in context.input:
            return _walk(context.input["json"], path[1:])
        return context.input.get("text") if len(path) == 1 else None
    if path[0] != "steps" or len(path) < 2:
        return None
    step = context.steps.get(path[1])
    if step is None:
        return None
    attribute = path[2] if len(path) > 2 else "output"
    if attribute == "json":
        return _walk(step.json, path[3:])
    if attribute == "status":
        return step.status
    if attribute == "error":
        return step.error
    return step.output


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def render(template: str, context: RunContext) -> str:
    return TEMPLATE_RE.sub(lambda m: stringify(lookup(context, m.group(1).split("."))), template)


def render_value(value: Any, context: RunContext) -> Any:
    """Render templates inside JSON; a string that is exactly one placeholder keeps its type."""
    if isinstance(value, str):
        whole = TEMPLATE_RE.fullmatch(value.strip())
        if whole:
            return lookup(context, whole.group(1).split("."))
        return render(value, context)
    if isinstance(value, dict):
        return {k: render_value(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [render_value(v, context) for v in value]
    return value


def parse_json(text: str | None) -> Any:
    """JSON hidden in a text answer (bare or fenced), or None."""
    if not text:
        return None
    candidate = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1).strip()
    if not candidate.startswith(("{", "[")):
        return None
    try:
        return json.loads(candidate)
    except ValueError:
        return None


class ConditionError(ValueError):
    pass


def evaluate(node: ConditionNode, context: RunContext) -> tuple[bool, str]:
    """The branch to follow and the value that was tested (shown in the trace)."""
    left = render(node.value, context)
    right = render(node.operand, context)
    a, b = (left, right) if node.case_sensitive else (left.casefold(), right.casefold())
    operator = node.operator
    if operator == "contains":
        return b in a, left
    if operator == "not_contains":
        return b not in a, left
    if operator == "equals":
        return a.strip() == b.strip(), left
    if operator == "not_equals":
        return a.strip() != b.strip(), left
    if operator == "is_empty":
        return not left.strip(), left
    if operator == "not_empty":
        return bool(left.strip()), left
    if operator == "matches":
        try:
            flags = 0 if node.case_sensitive else regex.IGNORECASE
            found = regex.search(right, left, flags=flags, timeout=CONDITION_REGEX_TIMEOUT_S)
        except regex.error as exc:
            raise ConditionError(f"Invalid pattern: {exc}") from exc
        except TimeoutError as exc:
            raise ConditionError("The pattern took too long to evaluate.") from exc
        return found is not None, left
    try:
        x, y = float(left.strip()), float(right.strip())
    except ValueError as exc:
        raise ConditionError(
            f"Cannot compare “{left[:60]}” with “{right[:60]}” as numbers."
        ) from exc
    result = {"gt": x > y, "gte": x >= y, "lt": x < y, "lte": x <= y}[operator]
    return result, left
