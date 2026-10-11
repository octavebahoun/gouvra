import "@xyflow/react/dist/base.css";
import "./flow.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";
import { formatDuration } from "@/features/executions/format";
import type { Graph, GraphEdge, GraphNode, Issue, WorkflowStep } from "./api";
import {
  addEdge,
  canConnect,
  edgesOf,
  findNode,
  issuesByTarget,
  nodesOf,
  UNARY_OPERATORS,
  updateNode,
  withoutNode,
  type Operator,
} from "./graph";
import { linkColor, stepStatus, type LinkState } from "./meta";
import { LinkEdge, StepNode, type LinkFlowEdge, type StepFlowNode } from "./nodes";

const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { link: LinkEdge };

export type Selection = { kind: "node" | "edge"; id: string };
export type Names = { agents: Map<string, string>; tools: Map<string, string> };

type Props = {
  graph: Graph;
  names: Names;
  label: string;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  /** Editing: `commit` is false while a step is being dragged (one undo step per drag). */
  onChange?: (graph: Graph, commit: boolean) => void;
  issues?: Issue[];
  /** Run view: the steps of a run, drawn on the graph it executed. */
  steps?: WorkflowStep[];
  className?: string;
};

function shorten(text: string, size = 22): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
}

function continues(node: GraphNode | undefined): boolean {
  return Boolean(node && "on_error" in node && node.on_error === "continue");
}

function linkState(
  graph: Graph,
  edge: GraphEdge,
  steps: Map<string, WorkflowStep>,
  invalid: boolean,
): LinkState {
  if (steps.size === 0) return invalid ? "invalid" : "idle";
  const source = steps.get(edge.source);
  const target = steps.get(edge.target);
  if (!source || source.status === "pending" || source.status === "running") return "idle";
  const active =
    source.status === "succeeded"
      ? !edge.branch || edge.branch === source.branch
      : source.status === "failed" && continues(findNode(graph, edge.source));
  if (!active || target?.status === "skipped") return "skipped";
  return target?.status === "running" ? "flowing" : "taken";
}

function summarize(node: GraphNode, names: Names, t: TFunction<"workflows">): string {
  switch (node.type) {
    case "start":
      return node.input_schema ? t("summary.validated") : t("summary.anyInput");
    case "agent": {
      const name = names.agents.get(node.agent_id) ?? t("summary.unknownAgent");
      return node.version ? `${name} · v${node.version}` : name;
    }
    case "tool":
      return names.tools.get(node.tool_id) ?? t("summary.unknownTool");
    case "condition": {
      const operator: Operator = node.operator ?? "contains";
      const test = t(`operatorsShort.${operator}`);
      return UNARY_OPERATORS.has(operator)
        ? `${shorten(node.value, 18)} ${test}`
        : `${test} “${shorten(node.operand ?? "", 14)}”`;
    }
    case "transform":
      return node.output === "json" ? t("summary.json") : t("summary.text");
    case "end":
      return node.output ? t("summary.template") : t("summary.previous");
  }
}

function footer(step: WorkflowStep, t: TFunction<"workflows">): string | undefined {
  if (step.status === "pending" || step.status === "skipped") return undefined;
  const parts: string[] = [];
  if (step.status === "running") parts.push(t("run.inProgress"));
  else if (step.duration_ms !== null) parts.push(formatDuration(step.duration_ms));
  if (step.branch) {
    parts.push(t(step.branch === "true" ? "inspector.branchTrue" : "inspector.branchFalse"));
  }
  if (step.attempt > 1) parts.push(t("run.attempt", { count: step.attempt }));
  if (step.input_tokens + step.output_tokens > 0) {
    parts.push(t("run.tokenCount", { count: step.input_tokens + step.output_tokens }));
  }
  return parts.join(" · ") || undefined;
}

/**
 * The workflow drawn as a graph. In the editor, steps can be moved, linked and removed; in a run,
 * each step shows its state and the links show the path the run took, with data flowing into
 * the step that is running.
 */
export function WorkflowCanvas({
  graph,
  names,
  label,
  selection,
  onSelect,
  onChange,
  issues,
  steps,
  className,
}: Props) {
  const { t } = useTranslation("workflows");
  const { resolved } = useTheme();
  const editable = Boolean(onChange);
  const byTarget = useMemo(() => issuesByTarget(issues ?? []), [issues]);
  const runSteps = useMemo(() => new Map((steps ?? []).map((s) => [s.node_id, s])), [steps]);

  const nodes = useMemo<StepFlowNode[]>(
    () =>
      nodesOf(graph).map((node) => {
        const found = byTarget.nodes.get(node.id) ?? [];
        const errors = found.filter((i) => i.severity === "error").length;
        const warnings = found.length - errors;
        const step = runSteps.get(node.id);
        const status = steps ? stepStatus(step?.status) : undefined;
        const kind = t(`types.${node.type}`);
        const parts = [`${kind} “${node.label}”`];
        if (status) parts.push(t(`run.stepStatus.${status}`));
        if (errors) parts.push(t("editor.problems", { count: errors }));
        else if (warnings) parts.push(t("editor.warnings", { count: warnings }));
        return {
          id: node.id,
          type: "step",
          position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
          data: {
            node,
            kind,
            summary: summarize(node, names, t),
            errors,
            warnings,
            status,
            footer: step ? footer(step, t) : undefined,
            linked: new Set(
              edgesOf(graph)
                .filter((e) => e.source === node.id && e.branch)
                .map((e) => e.branch ?? ""),
            ),
          },
          selected: selection?.kind === "node" && selection.id === node.id,
          deletable: editable && node.type !== "start",
          draggable: editable,
          ariaLabel: parts.join(", "),
        };
      }),
    [graph, byTarget, runSteps, steps, selection, editable, names, t],
  );

  const edges = useMemo<LinkFlowEdge[]>(
    () =>
      edgesOf(graph).map((edge) => {
        const state = linkState(graph, edge, runSteps, byTarget.edges.has(edge.id));
        const selected = selection?.kind === "edge" && selection.id === edge.id;
        const from = findNode(graph, edge.source);
        const to = findNode(graph, edge.target);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.branch ?? null,
          type: "link",
          animated: state === "flowing",
          selected,
          deletable: editable,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: linkColor(state, selected),
          },
          data: {
            state,
            label: edge.branch
              ? t(edge.branch === "true" ? "inspector.branchTrue" : "inspector.branchFalse")
              : undefined,
          },
          ariaLabel: t("inspector.linkFrom", {
            source: from?.label ?? edge.source,
            target: to?.label ?? edge.target,
          }),
        };
      }),
    [graph, runSteps, byTarget, selection, editable, t],
  );

  function onNodesChange(changes: NodeChange<StepFlowNode>[]) {
    let next = graph;
    let changed = false;
    let commit = false;
    for (const change of changes) {
      if (change.type === "select") {
        if (change.selected) onSelect({ kind: "node", id: change.id });
      } else if (!onChange) {
        continue;
      } else if (change.type === "position") {
        if (change.position) {
          const position = { x: Math.round(change.position.x), y: Math.round(change.position.y) };
          next = updateNode(next, change.id, { position });
        }
        changed = true;
        commit ||= change.dragging === false;
      } else if (change.type === "remove") {
        if (findNode(next, change.id)?.type === "start") continue;
        next = withoutNode(next, change.id);
        changed = commit = true;
        if (selection?.id === change.id) onSelect(null);
      }
    }
    if (changed && onChange) onChange(next, commit);
  }

  function onEdgesChange(changes: EdgeChange<LinkFlowEdge>[]) {
    let next = graph;
    let changed = false;
    for (const change of changes) {
      if (change.type === "select") {
        if (change.selected) onSelect({ kind: "edge", id: change.id });
      } else if (change.type === "remove" && onChange) {
        next = { ...next, edges: edgesOf(next).filter((e) => e.id !== change.id) };
        changed = true;
        if (selection?.id === change.id) onSelect(null);
      }
    }
    if (changed && onChange) onChange(next, true);
  }

  function branchOf(handle: string | null | undefined): string | null {
    return handle === "true" || handle === "false" ? handle : null;
  }

  function onConnect(connection: Connection) {
    const branch = branchOf(connection.sourceHandle);
    if (!onChange || !canConnect(graph, connection.source, connection.target, branch)) return;
    onChange(addEdge(graph, connection.source, connection.target, branch), true);
  }

  return (
    <div className={cn("gv-flow relative min-h-0", className)}>
      <ReactFlow<StepFlowNode, LinkFlowEdge>
        aria-label={label}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(c) =>
          canConnect(graph, c.source, c.target, branchOf(c.sourceHandle ?? null))
        }
        onPaneClick={() => onSelect(null)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        snapToGrid
        snapGrid={[8, 8]}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        colorMode={resolved}
        attributionPosition="bottom-left"
        ariaLabelConfig={{
          "node.a11yDescription.default": t("a11y.node"),
          "node.a11yDescription.keyboardDisabled": t("a11y.nodeReadOnly"),
          "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
            t("a11y.moved", { direction, x: Math.round(x), y: Math.round(y) }),
          "edge.a11yDescription.default": t("a11y.edge"),
          "controls.ariaLabel": t("a11y.controls"),
          "controls.zoomIn.ariaLabel": t("a11y.zoomIn"),
          "controls.zoomOut.ariaLabel": t("a11y.zoomOut"),
          "controls.fitView.ariaLabel": t("a11y.fitView"),
          "controls.interactive.ariaLabel": t("a11y.interactive"),
          "minimap.ariaLabel": t("a11y.minimap"),
          "handle.ariaLabel": t("a11y.handle"),
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1.3}
          color="var(--color-line-strong)"
        />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
