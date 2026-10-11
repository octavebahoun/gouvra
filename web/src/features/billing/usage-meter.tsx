import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

/** Used against a plan limit: the bar turns amber at 80% and red at 100%. */
export function UsageMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null | undefined;
}) {
  const { t } = useTranslation("billing");
  const reduced = useReducedMotion();
  const share = limit ? Math.min(1, used / limit) : 0;
  const tone = share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warning" : "bg-brand";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-ink">{label}</span>
        <span className="text-muted tabular-nums">
          {limit ? t("meter.of", { used, limit }) : t("meter.unlimited", { used })}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? used}
        aria-valuenow={used}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        {limit ? (
          <motion.span
            className={cn("block h-full rounded-full", tone)}
            initial={false}
            animate={{ width: `${share * 100}%` }}
            transition={{ duration: reduced ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
          />
        ) : null}
      </div>
    </div>
  );
}
