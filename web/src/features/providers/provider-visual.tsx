import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { Provider } from "./api";

const MARKS: Record<string, { glyph: string; className: string }> = {
  deepseek: { glyph: "DS", className: "bg-brand-soft text-brand-text" },
  anthropic: { glyph: "A", className: "bg-warning-soft text-warning-text" },
  openai_compatible: { glyph: "{ }", className: "bg-neutral-soft text-ink" },
  test: { glyph: "T", className: "bg-success-soft text-success-text" },
};

/** Square monogram for a provider kind (no third-party logos are bundled). */
export function ProviderMark({ kind, className }: { kind: string; className?: string }) {
  const mark = MARKS[kind] ?? { glyph: kind.slice(0, 2).toUpperCase(), className: "" };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-card font-mono text-[13px] font-semibold tracking-tight",
        mark.className,
        className,
      )}
    >
      {mark.glyph}
    </span>
  );
}

/** Connection state: text + icon + colour, with the last latency when known. */
export function ProviderStatus({ provider }: { provider: Provider }) {
  const { t } = useTranslation("providers");
  if (provider.status === "ok") {
    return (
      <Badge tone="success" icon={<CircleCheck aria-hidden />}>
        {t("status.ok")}
        {provider.last_test_latency_ms !== null ? (
          <span className="font-normal tabular-nums">
            · {t("card.latency", { ms: provider.last_test_latency_ms })}
          </span>
        ) : null}
      </Badge>
    );
  }
  if (provider.status === "error") {
    return (
      <Badge tone="danger" icon={<CircleAlert aria-hidden />}>
        {t("status.error")}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<CircleDashed aria-hidden />}>
      {t("status.untested")}
    </Badge>
  );
}
