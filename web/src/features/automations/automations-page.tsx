import { ArrowRight, Bot, Plus, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useAutomations, type Automation } from "./api";
import { AutomationDialog } from "./automation-dialog";
import { describeCron } from "./cron";
import { AutomationState, FireBadge, KindIcon } from "./visual";

/** Automations: schedules and webhooks that start agents and workflows on their own. */
export function AutomationsPage() {
  const { t } = useTranslation(["automations", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const automations = useAutomations(workspace.id);
  const manage = can(detail.data, "automations:manage");
  const [creating, setCreating] = useState<null | "schedule" | "webhook">(null);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const actions = manage ? (
    <>
      <Button
        variant="secondary"
        leftIcon={<Plus aria-hidden />}
        onClick={() => setCreating("webhook")}
      >
        {t("newWebhook")}
      </Button>
      <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating("schedule")}>
        {t("newSchedule")}
      </Button>
    </>
  ) : null;

  return (
    <PageContainer wide>
      <PageHeader title={t("title")} description={t("description")} actions={actions} />
      {!manage && detail.data ? <Alert tone="info" title={t("readOnly")} className="mb-5" /> : null}
      {automations.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-card" />
          ))}
        </div>
      ) : automations.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={automations.error}
            onRetry={() => void automations.refetch()}
          />
        </Card>
      ) : automations.data.length === 0 ? (
        <Card>
          <EmptyState
            illustration="automations"
            title={t("empty")}
            description={t("emptyBody")}
            action={actions ?? undefined}
            className="py-14"
          />
        </Card>
      ) : (
        <motion.ul
          variants={staggerChildren(0.05)}
          initial="hidden"
          animate="visible"
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
        >
          {automations.data.map((automation) => (
            <AutomationCard
              key={automation.id}
              automation={automation}
              to={`${basePath}/automations/${automation.id}`}
            />
          ))}
        </motion.ul>
      )}
      {creating ? (
        <AutomationDialog
          open
          onOpenChange={(open) => !open && setCreating(null)}
          kind={creating}
          workspaceId={workspace.id}
          basePath={basePath}
        />
      ) : null}
    </PageContainer>
  );
}

function AutomationCard({ automation, to }: { automation: Automation; to: string }) {
  const { t, i18n } = useTranslation("automations");
  const { relative } = useFormatters();
  const TargetIcon = automation.target_type === "agent" ? Bot : Workflow;
  const schedule =
    automation.kind === "schedule" && automation.cron
      ? (describeCron(automation.cron, i18n.language) ?? automation.cron)
      : null;
  return (
    <motion.li variants={listItem}>
      <Link
        to={to}
        className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex items-start gap-3">
          <KindIcon kind={automation.kind} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold text-ink group-hover:text-brand-text">
              {automation.name}
            </h3>
            <p className="text-[12px] text-muted">{t(`kind.${automation.kind}`)}</p>
          </div>
          <AutomationState automation={automation} />
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-ink">
          <TargetIcon aria-hidden className="size-3.5 text-muted" />
          <span className="truncate">{automation.target_name ?? t("target.missing")}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-[13px] text-muted">
          {schedule
            ? `${schedule} · ${automation.timezone ?? "UTC"}`
            : t(`signature.${automation.signature_format}`)}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-[12px] text-muted">
          <span>
            {automation.kind === "schedule" && automation.next_run_at
              ? t("nextRun", { when: relative(automation.next_run_at) })
              : automation.last_fired_at
                ? t("lastFired", { when: relative(automation.last_fired_at) })
                : t("neverFired")}
          </span>
          <span className="inline-flex items-center gap-2">
            {automation.last_status ? <FireBadge status={automation.last_status} /> : null}
            <ArrowRight
              aria-hidden
              className="size-4 transition-transform group-hover:translate-x-0.5"
            />
          </span>
        </div>
      </Link>
    </motion.li>
  );
}
