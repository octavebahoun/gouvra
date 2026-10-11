import { Archive, CircleCheck, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { ProviderMark } from "@/features/providers/provider-visual";
import type { Agent } from "./api";

/** Can it run? Archived beats everything; then readiness with its reasons in the title. */
export function ReadinessBadge({ agent }: { agent: Agent }) {
  const { t } = useTranslation("agents");
  if (agent.status === "archived") {
    return (
      <Badge tone="outline" icon={<Archive aria-hidden />}>
        {t("archivedBadge")}
      </Badge>
    );
  }
  if (agent.ready) {
    return (
      <Badge tone="success" icon={<CircleCheck aria-hidden />}>
        {t("ready")}
      </Badge>
    );
  }
  const reasons = agent.readiness_issues
    .map((issue) => t(`issues.${issue as "no_version"}`, issue))
    .join(", ");
  return (
    <Badge tone="warning" icon={<TriangleAlert aria-hidden />} title={reasons}>
      {t("notReady")}
      <span className="sr-only">: {reasons}</span>
    </Badge>
  );
}

/** Provider monogram + model id: what this agent thinks with. */
export function ModelChip({ agent, className }: { agent: Agent; className?: string }) {
  const { t } = useTranslation("agents");
  const version = agent.version;
  if (!version?.model)
    return <span className={cn("text-[13px] text-muted", className)}>{t("noModel")}</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {version.provider_kind ? (
        <ProviderMark kind={version.provider_kind} className="size-6 rounded-md text-[10px]" />
      ) : null}
      <span className="truncate font-mono text-[13px] text-ink">{version.model}</span>
    </span>
  );
}
