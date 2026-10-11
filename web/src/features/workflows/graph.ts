import type { Graph, GraphEdge, GraphNode, Issue, NodeType } from "./api";

/** Steps the palette can add (a workflow has exactly one input step). */
export const ADDABLE_TYPES = ["agent", "tool", "condition", "transform", "end"] as const;
export type AddableType = (typeof ADDABLE_TYPES)[number];

export const OPERATORS = [
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
] as const;
export type Operator = (typeof OPERATORS)[number];
export const UNARY_OPERATORS = new Set<Operator>(["is_empty", "not_empty"]);

export const LAYER_GAP = 124;
export const COLUMN_GAP = 280;

/** A step id usable in templates: lower case, digits and underscores, starting with a letter. */
export function slug(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!base) return "step";
  return /^[a-z]/.test(base) ? base : `step_${base}`.slice(0, 32);
}

export function uniqueId(graph: Graph, label: string): string {
  const taken = new Set(graph.nodes?.map((n) => n.id));
  const base = slug(label);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function edgeId(source: string, target: string, branch?: string | null): string {
  return branch ? `${source}-${target}-${branch}` : `${source}-${target}`;
}

export function nodesOf(graph: Graph): GraphNode[] {
  return graph.nodes ?? [];
}

export function edgesOf(graph: Graph): GraphEdge[] {
  return graph.edges ?? [];
}

export function findNode(graph: Graph, id: string): GraphNode | undefined {
  return nodesOf(graph).find((n) => n.id === id);
}

export function canHaveInputs(type: NodeType): boolean {
  return type !== "start";
}

export function canHaveOutputs(type: NodeType): boolean {
  return type !== "end";
}

/** Whether a link may be drawn (structural rules only; the server checks everything else). */
export function canConnect(
  graph: Graph,
  source: string,
  target: string,
  branch: string | null = null,
): boolean {
  if (source === target) return false;
  const from = findNode(graph, source);
  const to = findNode(graph, target);
  if (!from || !to || !canHaveOutputs(from.type) || !canHaveInputs(to.type)) return false;
  if ((from.type === "condition") !== (branch !== null)) return false;
  const duplicate = edgesOf(graph).some(
    (e) => e.source === source && e.target === target && (e.branch ?? null) === branch,
  );
  return !duplicate && !reaches(graph, target, source);
}

/** Is `to` reachable from `from` (a new link to→from would close a loop)? */
export function reaches(graph: Graph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  let current: string | undefined;
  while ((current = queue.shift()) !== undefined) {
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edgesOf(graph)) if (edge.source === current) queue.push(edge.target);
  }
  return false;
}

export function ancestors(graph: Graph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const queue = edgesOf(graph)
    .filter((e) => e.target === nodeId)
    .map((e) => e.source);
  let current: string | undefined;
  while ((current = queue.shift()) !== undefined) {
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edgesOf(graph)) if (edge.target === current) queue.push(edge.source);
  }
  return seen;
}

/** Steps in a stable order: by layer from the input, then left to right. */
export function ordered(graph: Graph): GraphNode[] {
  const depth = depths(graph);
  return [...nodesOf(graph)].sort(
    (a, b) =>
      (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
      (a.position?.x ?? 0) - (b.position?.x ?? 0),
  );
}

export type Reference = { path: string; nodeId: string | null; field: "input" | "output" | "json" };

/** What a step's templates may use: the run input and every step that runs before it. */
export function references(graph: Graph, nodeId: string): Reference[] {
  const upstream = ancestors(graph, nodeId);
  const list: Reference[] = [{ path: "input", nodeId: null, field: "input" }];
  for (const node of ordered(graph)) {
    if (!upstream.has(node.id) || node.type === "start") continue;
    list.push({ path: `steps.${node.id}.output`, nodeId: node.id, field: "output" });
    list.push({ path: `steps.${node.id}.json`, nodeId: node.id, field: "json" });
  }
  return list;
}

/** Longest distance from the steps without inputs (the input step) to each step. */
export function depths(graph: Graph): Map<string, number> {
  const nodes = nodesOf(graph);
  const edges = edgesOf(graph);
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges)
    if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let current: string | undefined;
  while ((current = queue.shift()) !== undefined) {
    for (const e of edges) {
      if (e.source !== current || !indegree.has(e.target)) continue;
      depth.set(e.target, Math.max(depth.get(e.target) ?? 0, (depth.get(current) ?? 0) + 1));
      indegree.set(e.target, (indegree.get(e.target) ?? 0) - 1);
      if (indegree.get(e.target) === 0) queue.push(e.target);
    }
  }
  return depth;
}

/** Arrange the steps in layers from top to bottom, each layer centred under its parents. */
export function tidy(graph: Graph): Graph {
  const depth = depths(graph);
  const layers = new Map<number, GraphNode[]>();
  for (const node of nodesOf(graph)) {
    const d = depth.get(node.id) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), node]);
  }
  const x = new Map<string, number>();
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(d) ?? [];
    const centre = (node: GraphNode) => {
      const parents = edgesOf(graph)
        .filter((e) => e.target === node.id && x.has(e.source))
        .map((e) => {
          // Branches of a condition open to each side, leaving room for the links between.
          const base = x.get(e.source) ?? 0;
          const shift = COLUMN_GAP / 2;
          return e.branch === "true" ? base - shift : e.branch === "false" ? base + shift : base;
        });
      return parents.length
        ? parents.reduce((a, b) => a + b, 0) / parents.length
        : (node.position?.x ?? 0);
    };
    layer.sort((a, b) => centre(a) - centre(b));
    const middle = layer.length
      ? layer.reduce((sum, node) => sum + centre(node), 0) / layer.length
      : 0;
    layer.forEach((node, i) => {
      x.set(node.id, Math.round(middle + (i - (layer.length - 1) / 2) * COLUMN_GAP));
    });
  }
  return {
    ...graph,
    nodes: nodesOf(graph).map((node) => ({
      ...node,
      position: { x: x.get(node.id) ?? 0, y: (depth.get(node.id) ?? 0) * LAYER_GAP },
    })),
  };
}

export function issuesByTarget(issues: Issue[]): {
  nodes: Map<string, Issue[]>;
  edges: Map<string, Issue[]>;
  general: Issue[];
} {
  const nodes = new Map<string, Issue[]>();
  const edges = new Map<string, Issue[]>();
  const general: Issue[] = [];
  for (const issue of issues) {
    if (issue.node_id) nodes.set(issue.node_id, [...(nodes.get(issue.node_id) ?? []), issue]);
    else if (issue.edge_id) edges.set(issue.edge_id, [...(edges.get(issue.edge_id) ?? []), issue]);
    else general.push(issue);
  }
  return { nodes, edges, general };
}

export function withoutNode(graph: Graph, nodeId: string): Graph {
  return {
    ...graph,
    nodes: nodesOf(graph).filter((n) => n.id !== nodeId),
    edges: edgesOf(graph).filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
}

export function updateNode(graph: Graph, nodeId: string, patch: Partial<GraphNode>): Graph {
  return {
    ...graph,
    nodes: nodesOf(graph).map((n) => (n.id === nodeId ? ({ ...n, ...patch } as GraphNode) : n)),
  };
}

export function addEdge(
  graph: Graph,
  source: string,
  target: string,
  branch: string | null,
): Graph {
  const edge: GraphEdge = { id: edgeId(source, target, branch), source, target };
  if (branch === "true" || branch === "false") edge.branch = branch;
  return { ...graph, edges: [...edgesOf(graph), edge] };
}

/** Rough JSON skeleton for a JSON Schema object, to start a tool's arguments or a run input. */
export function skeleton(schema: unknown): Record<string, unknown> {
  const properties =
    schema && typeof schema === "object" && "properties" in schema
      ? ((schema as { properties?: Record<string, { type?: string }> }).properties ?? {})
      : {};
  const sample: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(properties)) {
    sample[name] =
      spec.type === "number" || spec.type === "integer"
        ? 0
        : spec.type === "boolean"
          ? false
          : spec.type === "array"
            ? []
            : spec.type === "object"
              ? {}
              : "";
  }
  return sample;
}

export type StepDefaults = { label: string; agentId?: string; toolId?: string };

/**
 * A new step, placed under `anchor` (or under the lowest step) and linked from it when possible:
 * building a chain is one click per step. Templates start from the anchor's result.
 */
export function buildStep(
  graph: Graph,
  type: AddableType,
  defaults: StepDefaults,
  anchorId: string | null,
): { graph: Graph; id: string } | null {
  const id = uniqueId(graph, defaults.label);
  const nodes = nodesOf(graph);
  const anchor =
    (anchorId ? findNode(graph, anchorId) : undefined) ??
    [...ordered(graph)].reverse().find((n) => n.type !== "end");
  const source = anchor && canHaveOutputs(anchor.type) ? anchor : undefined;
  const previous =
    source && source.type !== "start" ? `{{steps.${source.id}.output}}` : "{{input}}";
  let x = Math.round(source?.position?.x ?? 0);
  const y = Math.round((source?.position?.y ?? -LAYER_GAP) + LAYER_GAP);
  while (
    nodes.some(
      (n) => Math.abs((n.position?.x ?? 0) - x) < 120 && Math.abs((n.position?.y ?? 0) - y) < 80,
    )
  ) {
    x += COLUMN_GAP;
  }
  const base = { id, label: defaults.label, position: { x, y } };
  let node: GraphNode;
  switch (type) {
    case "agent":
      if (!defaults.agentId) return null;
      node = { ...base, type, agent_id: defaults.agentId, input: previous };
      break;
    case "tool":
      if (!defaults.toolId) return null;
      node = { ...base, type, tool_id: defaults.toolId, arguments: {} };
      break;
    case "condition":
      node = { ...base, type, value: previous, operator: "contains", operand: "" };
      break;
    case "transform":
      node = { ...base, type, template: previous, output: "text" };
      break;
    case "end":
      node = { ...base, type, output: "" };
      break;
  }
  let next: Graph = { ...graph, nodes: [...nodes, node] };
  if (source) {
    const used = new Set(
      edgesOf(graph)
        .filter((e) => e.source === source.id)
        .map((e) => e.branch),
    );
    const branch = source.type === "condition" ? (used.has("true") ? "false" : "true") : null;
    if (canConnect(next, source.id, id, branch)) next = addEdge(next, source.id, id, branch);
  }
  return { graph: next, id };
}

export type Template = "blank" | "agent" | "branch";
export type TemplateLabels = Record<
  "input" | "output" | "answer" | "check" | "escalate" | "escalation",
  string
>;

/** Starting points offered when a workflow is created (laid out with `tidy`). */
export function templateGraph(template: Template, labels: TemplateLabels, agentId?: string): Graph {
  const start: GraphNode = { id: "input", type: "start", label: labels.input };
  const end: GraphNode = { id: "output", type: "end", label: labels.output, output: "" };
  if (template === "blank" || !agentId) {
    return tidy({
      nodes: [start, end],
      edges: [{ id: "input-output", source: "input", target: "output" }],
    });
  }
  const answer: GraphNode = {
    id: "answer",
    type: "agent",
    label: labels.answer,
    agent_id: agentId,
    input: "{{input}}",
  };
  if (template === "agent") {
    return tidy({
      nodes: [start, answer, end],
      edges: [
        { id: "input-answer", source: "input", target: "answer" },
        { id: "answer-output", source: "answer", target: "output" },
      ],
    });
  }
  const check: GraphNode = {
    id: "check",
    type: "condition",
    label: labels.check,
    value: "{{steps.answer.output}}",
    operator: "contains",
    operand: labels.escalate,
  };
  const escalation: GraphNode = {
    id: "escalation",
    type: "transform",
    label: labels.escalation,
    template: `${labels.escalation}: {{steps.answer.output}}`,
    output: "text",
  };
  return tidy({
    nodes: [start, answer, check, escalation, end],
    edges: [
      { id: "input-answer", source: "input", target: "answer" },
      { id: "answer-check", source: "answer", target: "check" },
      { id: "check-escalation-true", source: "check", target: "escalation", branch: "true" },
      { id: "escalation-output", source: "escalation", target: "output" },
      { id: "check-output-false", source: "check", target: "output", branch: "false" },
    ],
  });
}
