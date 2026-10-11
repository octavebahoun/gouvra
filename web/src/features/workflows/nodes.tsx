import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { GraphNode, StepStatus } from "./api";
import { canHaveInputs, canHaveOutputs } from "./graph";
import { linkColor, NODE_WIDTH, STEP_META, TYPE_META, type LinkState } from "./meta";

export type StepNodeData = {
  node: GraphNode;
  kind: string;
  summary: string;
  errors: number;
  warnings: number;
  /** Run view only. */
  status?: StepStatus;
  footer?: string;
  /** Branches of a condition that already lead somewhere (their link carries the label). */
  linked?: Set<string>;
};
export type StepFlowNode = Node<StepNodeData, "step">;

export type LinkEdgeData = { label?: string; state: LinkState };
export type LinkFlowEdge = Edge<LinkEdgeData, "link">;

/** A step on the canvas: its kind, its name, a one-line summary, then its state in a run. */
export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation("workflows");
  const reduced = useReducedMotion();
  const { node, status } = data;
  const { Icon, accent } = TYPE_META[node.type];
  const StatusIcon = status ? STEP_META[status].Icon : null;
  const issueCount = data.errors || data.warnings;
  return (
    <div
      style={{ "--accent": accent, width: NODE_WIDTH } as CSSProperties}
      className={cn(
        "relative rounded-xl border bg-surface text-left shadow-sm transition-[border-color,box-shadow,opacity,background-color] duration-300",
        selected
          ? "border-brand shadow-[var(--gv-glow-brand)]"
          : status === "failed"
            ? "border-danger bg-danger-soft"
            : status === "succeeded"
              ? "border-success"
              : status === "cancelled"
                ? "border-warning"
                : !status && data.errors
                  ? "border-danger"
                  : "border-line",
        status === "skipped" && "border-dashed opacity-50",
        status === "pending" && "opacity-80",
      )}
    >
      {canHaveInputs(node.type) ? (
        <Handle type="target" position={Position.Top} className="gv-handle" />
      ) : null}
      <span
        aria-hidden
        className="absolute inset-y-2 left-0 w-[3px] rounded-r-full"
        style={{ background: "var(--accent)" }}
      />
      <div className="flex items-start gap-2.5 py-2.5 pr-3 pl-3.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-lg"
          style={{
            background: "color-mix(in oklab, var(--accent) 15%, transparent)",
            color: "var(--accent)",
          }}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5 font-semibold text-ink">
            {node.label}
          </span>
          <span className="block truncate text-[12px] leading-4 text-muted">
            {data.summary || data.kind}
          </span>
        </span>
        {status && StatusIcon ? (
          <StatusIcon
            aria-hidden
            className={cn("mt-0.5 size-4 shrink-0", status === "running" && "animate-spin")}
            style={{ color: STEP_META[status].color }}
          />
        ) : issueCount ? (
          <span
            aria-hidden
            className={cn(
              "mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1 text-[11px] font-semibold",
              data.errors ? "bg-danger-soft text-danger-text" : "bg-warning-soft text-warning-text",
            )}
          >
            {issueCount}
          </span>
        ) : null}
      </div>
      {data.footer ? (
        <div className="border-t border-line/70 px-3.5 py-1.5 text-[11px] text-muted tabular-nums">
          {data.footer}
        </div>
      ) : null}
      {status === "running" && !reduced ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] rounded-[15px] border-2 border-brand"
          initial={{ opacity: 0.2 }}
          animate={{ opacity: [0.85, 0.15, 0.85] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : null}
      {node.type === "condition" ? (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            className="gv-handle gv-handle-true"
            style={{ left: "30%" }}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Bottom}
            className="gv-handle gv-handle-false"
            style={{ left: "70%" }}
          />
          {data.linked?.has("true") ? null : (
            <span
              aria-hidden
              className="pointer-events-none absolute top-full left-[30%] mt-1.5 -translate-x-1/2 text-[10px] font-semibold text-success-text"
            >
              {t("inspector.branchTrue")}
            </span>
          )}
          {data.linked?.has("false") ? null : (
            <span
              aria-hidden
              className="pointer-events-none absolute top-full left-[70%] mt-1.5 -translate-x-1/2 text-[10px] font-semibold text-muted"
            >
              {t("inspector.branchFalse")}
            </span>
          )}
        </>
      ) : canHaveOutputs(node.type) ? (
        <Handle type="source" position={Position.Bottom} className="gv-handle" />
      ) : null}
    </div>
  );
}

/** A link between two steps; in a run it shows the path taken, and data flowing into a step. */
export function LinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<LinkFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 18,
  });
  const state = data?.state ?? "idle";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={{
          stroke: linkColor(state, selected),
          strokeWidth: selected || state === "taken" || state === "flowing" ? 2.25 : 1.6,
          opacity: state === "skipped" ? 0.35 : 1,
          strokeDasharray: state === "skipped" ? "4 5" : undefined,
          transition: "stroke 300ms, opacity 300ms",
        }}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <span
            aria-hidden
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={cn(
              "nodrag nopan pointer-events-none absolute rounded-full border bg-surface px-1.5 py-px text-[10px] font-semibold",
              state === "skipped"
                ? "border-line text-muted opacity-60"
                : "border-line-strong text-ink",
            )}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
