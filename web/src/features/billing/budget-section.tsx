import { CircleAlert, Download, TriangleAlert, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { exportUrl, useAlerts, useBudget, useDismissAlert, type AlertInfo } from "./api";
import { BudgetDialog } from "./budget-dialog";

function usd(value: string | number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    Number(value),
  );
}

/** Spend this month against the budget, with the alert thresholds drawn on the bar. */
export function BudgetCard() {
  const { t } = useTranslation("billing");
  const { workspace, detail } = useCurrentWorkspace();
  const budget = useBudget(workspace.id);
  const reduced = useReducedMotion();
  const [editing, setEditing] = useState(false);
  const manage = can(detail.data, "budgets:manage");
  if (budget.isPending) return <Skeleton className="h-40 rounded-card" />;
  if (budget.isError) return null;
  const settings = budget.data.budget;
  const spent = Number(budget.data.spent);
  const limit = settings ? Number(settings.monthly_limit) : 0;
  const share = limit ? Math.min(1, spent / limit) : 0;
  const tone = share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warning" : "bg-brand";
  return (
    <Card>
      <CardHeader
        title={t("budget.title")}
        description={t("budget.description")}
        actions={
          manage ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {settings ? t("budget.edit") : t("budget.set")}
            </Button>
          ) : null
        }
      />
      <div className="px-5 pb-5">
        <p className="text-[22px] font-semibold text-ink tabular-nums">
          {usd(spent)}
          {settings ? (
            <span className="ml-1.5 text-[14px] font-normal text-muted">
              {t("budget.of", { limit: usd(limit) })}
            </span>
          ) : null}
        </p>
        {settings ? (
          <>
            <div
              role="meter"
              aria-label={t("budget.title")}
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={spent}
              className="relative mt-3 h-2 rounded-full bg-surface-2"
            >
              <motion.span
                className={cn("block h-full rounded-full", tone)}
                initial={false}
                animate={{ width: `${share * 100}%` }}
                transition={{ duration: reduced ? 0 : 0.6, ease: [0.2, 0, 0, 1] }}
              />
              {settings.thresholds
                .filter((value) => value < 100)
                .map((value) => (
                  <span
                    key={value}
                    aria-hidden
                    className="absolute -top-1 h-4 w-px bg-line-strong"
                    style={{ left: `${value}%` }}
                  />
                ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>
                {t("budget.alertsAt", {
                  list: settings.thresholds.map((v) => `${v} %`).join(", "),
                })}
              </span>
              {settings.hard_stop ? <Badge tone="warning">{t("budget.stops")}</Badge> : null}
            </div>
          </>
        ) : (
          <p className="mt-1 text-[13px] text-muted">{t("budget.none")}</p>
        )}
      </div>
      {editing ? (
        <BudgetDialog open onOpenChange={setEditing} workspaceId={workspace.id} budget={settings} />
      ) : null}
    </Card>
  );
}

/** Budget, quota and payment alerts of the last weeks; admins can dismiss them. */
export function AlertsCard() {
  const { t } = useTranslation("billing");
  const { workspace, detail } = useCurrentWorkspace();
  const alerts = useAlerts(workspace.id);
  const dismiss = useDismissAlert(workspace.id);
  const { relative } = useFormatters();
  const manage = can(detail.data, "budgets:manage");
  const active = (alerts.data ?? []).filter((alert) => !alert.dismissed_at);
  const alertText = (alert: AlertInfo) => {
    const value = (key: string) => {
      const raw = alert.data[key];
      return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    };
    if (alert.kind === "budget") {
      return t("alerts.kinds.budget", {
        percent: value("percent"),
        spent: value("spent"),
        limit: value("limit"),
      });
    }
    if (alert.kind === "quota") {
      return t("alerts.kinds.quota", {
        percent: value("percent"),
        used: value("used"),
        limit: value("limit"),
        plan: value("plan"),
      });
    }
    return t("alerts.kinds.paymentFailed", { plan: value("plan") });
  };
  if (!active.length) return null;
  return (
    <Card>
      <CardHeader title={t("alerts.title")} description={t("alerts.description")} />
      <ul className="divide-y divide-line">
        {active.map((alert) => {
          const Icon = alert.level === "danger" ? CircleAlert : TriangleAlert;
          return (
            <li key={alert.id} className="flex items-start gap-3 px-5 py-3">
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  alert.level === "danger" ? "text-danger-text" : "text-warning-text",
                )}
              />
              <div className="min-w-0 flex-1 text-[13px]">
                <p className="text-ink">{alertText(alert)}</p>
                <p className="text-[12px] text-muted">{relative(alert.created_at)}</p>
              </div>
              {manage ? (
                <IconButton
                  size="icon-sm"
                  label={t("alerts.dismiss")}
                  icon={<X aria-hidden />}
                  onClick={() => dismiss.mutate(alert.id)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** CSV downloads of runs and usage (the last 30 days). */
export function ExportButtons() {
  const { t } = useTranslation("billing");
  const { workspace, detail } = useCurrentWorkspace();
  if (!can(detail.data, "exports:create")) return null;
  return (
    <>
      <Button asChild size="sm" variant="secondary" leftIcon={<Download aria-hidden />}>
        <a href={exportUrl(workspace.id, "usage.csv")} download>
          {t("exports.usage")}
        </a>
      </Button>
      <Button asChild size="sm" variant="secondary" leftIcon={<Download aria-hidden />}>
        <a href={exportUrl(workspace.id, "executions.csv")} download>
          {t("exports.executions")}
        </a>
      </Button>
    </>
  );
}
