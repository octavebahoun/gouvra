import { Braces, Globe, Sparkles, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";

const ICONS = { builtin: Sparkles, http: Globe, code: Braces } as const;
const TONES = {
  builtin: "bg-brand-soft text-brand-text",
  http: "bg-warning-soft text-warning-text",
  code: "bg-success-soft text-success-text",
} as const;

export function ToolMark({ kind, className }: { kind: string; className?: string }) {
  const key = (kind in ICONS ? kind : "builtin") as keyof typeof ICONS;
  const Icon = ICONS[key];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-card",
        TONES[key],
        className,
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  );
}

/** Whether calling the tool leaves the instance: always spelled out, never colour alone. */
export function NetworkBadge({ usesNetwork }: { usesNetwork: boolean }) {
  const { t } = useTranslation("tools");
  return usesNetwork ? (
    <Badge tone="warning" icon={<Globe aria-hidden />}>
      {t("network")}
    </Badge>
  ) : (
    <Badge tone="outline" icon={<WifiOff aria-hidden />}>
      {t("offline")}
    </Badge>
  );
}
