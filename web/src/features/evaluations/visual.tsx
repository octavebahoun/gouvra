import { Ban, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { Run } from "./api";

const RUN_STATUS = {
  running: { tone: "brand", Icon: LoaderCircle },
  completed: { tone: "success", Icon: CircleCheck },
  cancelled: { tone: "neutral", Icon: Ban },
  failed: { tone: "danger", Icon: CircleX },
} as const;

export function RunStatusBadge({ status }: { status: Run["status"] }) {
  const { t } = useTranslation("evaluations");
  const { tone, Icon } = RUN_STATUS[status];
  return (
    <Badge
      tone={tone}
      icon={<Icon aria-hidden className={cn(status === "running" && "animate-spin-slow")} />}
    >
      {t(`runs.status.${status}`)}
    </Badge>
  );
}

const RESULT_TONES: Record<string, "success" | "danger" | "warning" | "neutral" | "brand"> = {
  passed: "success",
  failed: "danger",
  errored: "warning",
  cancelled: "neutral",
  pending: "brand",
  grading: "brand",
};

export function ResultBadge({ status }: { status: string }) {
  const { t } = useTranslation("evaluations");
  const known = status in RESULT_TONES;
  return (
    <Badge tone={RESULT_TONES[status] ?? "neutral"}>
      {known ? t(`run.resultStatus.${status as "passed"}`) : status}
    </Badge>
  );
}

/**
 * Stacked bar of a run's outcome (passed / failed / errored / pending): it grows in, and fills
 * live while the run progresses. The numbers are always written next to it.
 */
export function OutcomeBar({
  summary,
  className,
}: {
  summary: Run["summary"];
  className?: string;
}) {
  const reduced = useReducedMotion();
  const total = Math.max(1, summary.cases);
  const parts = [
    { key: "passed", value: summary.passed, color: "bg-success" },
    { key: "failed", value: summary.failed, color: "bg-danger" },
    { key: "errored", value: summary.errored, color: "bg-warning" },
    { key: "cancelled", value: summary.cancelled, color: "bg-line-strong" },
  ];
  return (
    <div
      aria-hidden
      className={cn("flex h-2 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      {parts.map((part) => (
        <motion.span
          key={part.key}
          className={cn("h-full", part.color)}
          initial={false}
          animate={{ width: `${(part.value / total) * 100}%` }}
          transition={{ duration: reduced ? 0 : 0.6, ease: [0.2, 0, 0, 1] }}
        />
      ))}
    </div>
  );
}
