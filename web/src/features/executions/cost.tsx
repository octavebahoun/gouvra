import { BadgeCheck, Calculator, CircleSlash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/menu";
import { formatCost } from "./format";

export type CostLike = {
  amount: string | null;
  currency: string | null;
  source: "provider_reported" | "estimated" | "unavailable";
  partial: boolean;
};

const ICONS = { provider_reported: BadgeCheck, estimated: Calculator, unavailable: CircleSlash };

/**
 * A cost with its provenance, never a bare number: reported by the provider, estimated from
 * published prices (≈), or unavailable (—, not $0). Partial totals say they are a lower bound.
 */
export function CostValue({
  cost,
  className,
  showSource = false,
  focusable = true,
}: {
  cost: CostLike;
  className?: string;
  showSource?: boolean;
  /** In dense lists the provenance stays readable by screen readers without a tab stop per row. */
  focusable?: boolean;
}) {
  const { t } = useTranslation("executions");
  const Icon = ICONS[cost.source];
  const label = t(`cost.${cost.source}`);
  const note = cost.partial ? `${label} · ${t("cost.partial")}` : label;
  if (cost.source === "unavailable" || cost.amount === null) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-muted", className)}>
        <span aria-hidden>—</span>
        <span className="sr-only">{label}</span>
        {showSource ? <span className="text-xs">{label}</span> : null}
      </span>
    );
  }
  const value = `${cost.source === "estimated" ? "≈ " : ""}${formatCost(cost.amount, cost.currency)}${cost.partial ? "+" : ""}`;
  return (
    <span className={cn("inline-flex items-center gap-1.5 tabular-nums", className)}>
      <span>{value}</span>
      <Tooltip content={note}>
        {focusable ? (
          <button
            type="button"
            className="inline-flex rounded-sm text-muted focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon aria-hidden className="size-3.5" />
            <span className="sr-only">{note}</span>
          </button>
        ) : (
          <span className="inline-flex text-muted">
            <Icon aria-hidden className="size-3.5" />
            <span className="sr-only">{note}</span>
          </span>
        )}
      </Tooltip>
      {showSource ? <span className="text-xs text-muted">{label}</span> : null}
    </span>
  );
}
