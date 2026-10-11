import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { NodeType, StepStatus } from "./api";
import { STEP_META, TYPE_META } from "./meta";

export function StepStatusBadge({ status }: { status: StepStatus }) {
  const { t } = useTranslation("workflows");
  const { tone, Icon } = STEP_META[status];
  return (
    <Badge
      tone={tone}
      icon={<Icon aria-hidden className={cn(status === "running" && "animate-spin-slow")} />}
    >
      {t(`run.stepStatus.${status}`)}
    </Badge>
  );
}

export function TypeIcon({ type, className }: { type: NodeType; className?: string }) {
  const { Icon, accent } = TYPE_META[type];
  return (
    <span
      aria-hidden
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg", className)}
      style={{ background: `color-mix(in oklab, ${accent} 15%, transparent)`, color: accent }}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** How far a run got: done steps fill the bar, live, with the numbers next to it. */
export function StepsBar({
  done,
  total,
  status,
  className,
}: {
  done: number;
  total: number;
  status: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const share = total ? Math.min(1, done / total) : 0;
  const color =
    status === "succeeded"
      ? "bg-success"
      : status === "failed" || status === "timed_out"
        ? "bg-danger"
        : status === "cancelled"
          ? "bg-line-strong"
          : "bg-brand";
  return (
    <div
      aria-hidden
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      <motion.span
        className={cn("block h-full rounded-full", color)}
        initial={false}
        animate={{ width: `${share * 100}%` }}
        transition={{ duration: reduced ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
      />
    </div>
  );
}
