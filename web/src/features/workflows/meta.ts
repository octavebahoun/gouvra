import {
  Ban,
  Bot,
  Braces,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Flag,
  GitBranch,
  LoaderCircle,
  LogIn,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { NodeType, StepStatus } from "./api";

/** One colour and one icon per kind of step, used on the canvas, in lists and in the palette. */
export const TYPE_META: Record<NodeType, { Icon: LucideIcon; accent: string }> = {
  start: { Icon: LogIn, accent: "var(--color-chart-1)" },
  agent: { Icon: Bot, accent: "var(--color-chart-4)" },
  tool: { Icon: Wrench, accent: "var(--color-chart-2)" },
  condition: { Icon: GitBranch, accent: "var(--color-chart-3)" },
  transform: { Icon: Braces, accent: "var(--color-chart-5)" },
  end: { Icon: Flag, accent: "var(--color-success)" },
};

export const STEP_META: Record<
  StepStatus,
  { Icon: LucideIcon; tone: "brand" | "success" | "danger" | "neutral" | "warning"; color: string }
> = {
  pending: { Icon: Circle, tone: "neutral", color: "var(--color-muted)" },
  running: { Icon: LoaderCircle, tone: "brand", color: "var(--color-brand)" },
  succeeded: { Icon: CircleCheck, tone: "success", color: "var(--color-success)" },
  failed: { Icon: CircleX, tone: "danger", color: "var(--color-danger)" },
  skipped: { Icon: CircleDashed, tone: "neutral", color: "var(--color-muted)" },
  cancelled: { Icon: Ban, tone: "warning", color: "var(--color-warning)" },
};

export const NODE_WIDTH = 232;

export type LinkState = "idle" | "flowing" | "taken" | "skipped" | "invalid";

const LINK_COLORS: Record<LinkState, string> = {
  idle: "var(--color-line-strong)",
  flowing: "var(--color-brand)",
  taken: "var(--color-success)",
  skipped: "var(--color-line-strong)",
  invalid: "var(--color-danger)",
};

export function linkColor(state: LinkState, selected = false): string {
  return selected && state === "idle" ? "var(--color-brand)" : LINK_COLORS[state];
}

export function stepStatus(value: string | undefined): StepStatus {
  return value && value in STEP_META ? (value as StepStatus) : "pending";
}
