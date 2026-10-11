import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { listItem } from "@/components/motion/presets";
import { StatusBadge } from "@/components/ui/badge";
import type { ExecutionSummary } from "./api";
import { useTriggerLabel } from "./labels";
import { CostValue } from "./cost";
import { formatDuration } from "./format";

/**
 * One execution in a list: state first (text + icon + colour), then who/what, then the numbers.
 * The whole row opens the trace; `highlight` flashes a row whose state just changed live.
 */
export function ExecutionRow({
  execution,
  to,
  showAgent = true,
  highlight = false,
  compact = false,
}: {
  execution: ExecutionSummary;
  to: string;
  showAgent?: boolean;
  highlight?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation("executions");
  const { relative, dateTime } = useFormatters();
  const triggerLabel = useTriggerLabel();
  const running = execution.status === "running" || execution.status === "queued";

  return (
    <motion.li
      variants={listItem}
      layout="position"
      className={cn(
        "group relative grid items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-surface-2/60",
        // Columns follow the width of the list (container queries), not the window.
        compact
          ? "grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[auto_minmax(0,1fr)_auto] @xl:grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_6.5rem] @4xl:grid-cols-[7.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem_6rem_7rem]",
        highlight && "animate-[gv-row-flash_1.4s_var(--ease-standard)]",
      )}
    >
      <StatusBadge status={execution.status} className="justify-self-start" />
      <div className="min-w-0">
        <Link
          to={to}
          className="block truncate text-sm font-medium text-ink after:absolute after:inset-0 hover:text-brand-text focus-visible:outline-none"
        >
          {showAgent
            ? (execution.agent?.name ?? t("deletedAgent"))
            : execution.input_preview || t("noInput")}
        </Link>
        <p className="truncate text-[13px] text-muted">
          {showAgent ? execution.input_preview || t("noInput") : triggerLabel(execution.trigger)}
        </p>
      </div>
      {compact ? (
        <span className="text-right text-xs text-muted" title={dateTime(execution.created_at)}>
          {relative(execution.created_at)}
        </span>
      ) : (
        <>
          <span className="hidden truncate text-[13px] text-muted @4xl:block">
            {triggerLabel(execution.trigger)}
            {execution.model ? (
              <span className="ml-1.5 font-mono text-xs">· {execution.model}</span>
            ) : null}
          </span>
          <span className="hidden text-right text-[13px] text-ink tabular-nums @xl:block">
            {running && execution.duration_ms === null
              ? "…"
              : formatDuration(execution.duration_ms)}
          </span>
          <span className="relative z-10 hidden justify-self-end text-[13px] @4xl:block">
            <CostValue cost={execution.cost} focusable={false} />
          </span>
          <span className="text-right text-xs text-muted" title={dateTime(execution.created_at)}>
            {relative(execution.created_at)}
          </span>
        </>
      )}
    </motion.li>
  );
}
