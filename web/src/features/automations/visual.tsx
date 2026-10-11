import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Pause,
  SkipForward,
  Timer,
  Webhook,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { Automation, FireStatus } from "./api";

export function KindIcon({ kind, className }: { kind: Automation["kind"]; className?: string }) {
  const Icon = kind === "schedule" ? Timer : Webhook;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg",
        kind === "schedule" ? "bg-brand-soft text-brand-text" : "bg-success-soft text-success-text",
        className,
      )}
    >
      <Icon className="size-4.5" />
    </span>
  );
}

/** Active, paused, or active but unable to start its target. */
export function AutomationState({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  if (!automation.enabled) {
    return (
      <Badge tone="neutral" icon={<Pause aria-hidden />}>
        {t("state.paused")}
      </Badge>
    );
  }
  if (automation.target_problem) {
    return (
      <Badge tone="danger" icon={<CircleAlert aria-hidden />}>
        {t("state.problem")}
      </Badge>
    );
  }
  return (
    <Badge tone="success" icon={<CircleCheck aria-hidden />}>
      {t("state.active")}
    </Badge>
  );
}

const FIRE_TONES: Record<FireStatus, "success" | "neutral" | "danger" | "warning" | "brand"> = {
  launched: "success",
  skipped: "neutral",
  rejected: "warning",
  failed: "danger",
  pending: "brand",
};

const FIRE_ICONS = {
  launched: CircleCheck,
  skipped: SkipForward,
  rejected: CircleAlert,
  failed: CircleX,
  pending: CircleDashed,
};

export function FireBadge({ status }: { status: FireStatus }) {
  const { t } = useTranslation("automations");
  const Icon = FIRE_ICONS[status];
  return (
    <Badge tone={FIRE_TONES[status]} icon={<Icon aria-hidden />}>
      {t(`fire.status.${status}`)}
    </Badge>
  );
}
