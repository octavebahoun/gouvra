import {
  Activity,
  ArrowRight,
  ChartColumn,
  CircleAlert,
  KeyRound,
  Plus,
  Settings,
  UserPlus,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { can } from "@/lib/auth/permissions";
import { useCurrentSession } from "@/lib/auth/session";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { fadeUp, listItem, staggerChildren } from "@/components/motion/presets";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { RingGauge } from "@/components/ui/charts";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState, Unavailable } from "@/components/ui/states";
import { CostValue } from "@/features/executions/cost";
import { useDiagnosis } from "@/features/executions/diagnosis";
import { ExecutionRow } from "@/features/executions/execution-row";
import { formatDuration, formatTokens } from "@/features/executions/format";
import { useWorkspaceLive } from "@/features/executions/live";
import { OnboardingChecklist } from "@/features/onboarding/onboarding-checklist";
import { useOverview, type Overview } from "@/features/usage/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { workspaceAddress } from "@/features/workspaces/slug";

/**
 * Screen G — overview: only figures whose source is known, each one linked to the lists or
 * traces behind it; recent executions update live.
 */
export function OverviewPage() {
  const { t } = useTranslation(["shell", "usage", "common"]);
  const session = useCurrentSession();
  const { workspace, role, basePath, detail } = useCurrentWorkspace();
  const overview = useOverview(workspace.id);
  const { date } = useFormatters();
  useWorkspaceLive(workspace.id);
  useDocumentTitle(`${t("overview.title")} — ${workspace.name}`);
  const firstName = session.user.display_name.split(/\s+/)[0] ?? session.user.display_name;

  return (
    <PageContainer wide>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.description", { name: firstName, workspace: workspace.name })}
        meta={workspace.is_demo ? <Badge tone="warning">{t("workspace.demo")}</Badge> : null}
      />
      {overview.isPending ? (
        <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-card" />
          ))}
        </div>
      ) : overview.isError ? (
        <Card className="mb-6">
          <ErrorState compact error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      ) : (
        <Metrics data={overview.data} basePath={basePath} />
      )}

      <motion.div
        variants={staggerChildren(0.06)}
        initial="hidden"
        animate="visible"
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <div className="flex min-w-0 flex-col gap-6">
          <motion.div variants={fadeUp}>
            <OnboardingChecklist
              workspace={workspace}
              canDismiss={can(detail.data, "workspace:update")}
            />
          </motion.div>
          <motion.div variants={fadeUp}>
            <Card className="overflow-hidden">
              <CardHeader
                title={t("usage:overview.recent")}
                actions={
                  overview.data && overview.data.recent_executions.length > 0 ? (
                    <Link
                      to={`${basePath}/executions`}
                      className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline"
                    >
                      {t("usage:overview.seeAll")}
                      <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  ) : null
                }
              />
              {overview.isPending ? (
                <div className="space-y-2 p-5">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              ) : !overview.data || overview.data.recent_executions.length === 0 ? (
                <EmptyState
                  illustration="executions"
                  title={t("usage:overview.recentEmpty")}
                  description={t("usage:overview.recentEmptyBody")}
                  className="py-10"
                />
              ) : (
                <motion.ul
                  variants={staggerChildren(0.03)}
                  initial="hidden"
                  animate="visible"
                  className="@container divide-y divide-line"
                >
                  {overview.data.recent_executions.map((execution) => (
                    <ExecutionRow
                      key={execution.id}
                      execution={execution}
                      to={`${basePath}/executions/${execution.id}`}
                    />
                  ))}
                </motion.ul>
              )}
            </Card>
          </motion.div>
          {overview.data && overview.data.recent_failures.length > 0 ? (
            <motion.div variants={fadeUp}>
              <Failures data={overview.data} basePath={basePath} />
            </motion.div>
          ) : null}
        </div>

        <motion.aside
          variants={fadeUp}
          aria-labelledby="overview-about"
          className="flex flex-col gap-6"
        >
          <Card>
            <div className="flex items-center gap-3 border-b border-line px-5 py-4">
              <Avatar name={workspace.name} square size="md" />
              <div className="min-w-0">
                <h2 id="overview-about" className="truncate text-[15px] font-semibold text-ink">
                  {workspace.name}
                </h2>
                <p className="text-xs text-muted">{t("overview.aboutTitle")}</p>
              </div>
            </div>
            <dl className="divide-y divide-line text-[13px]">
              <Fact label={t("overview.yourRole")}>
                <Badge tone="brand">{t(`common:workspace.role.${role}`)}</Badge>
              </Fact>
              <Fact label={t("overview.members")}>
                {detail.isPending ? (
                  <Skeleton className="h-4 w-6" />
                ) : detail.data ? (
                  <span className="font-medium text-ink tabular-nums">
                    {detail.data.member_count}
                  </span>
                ) : (
                  <Unavailable reason={t("overview.detailsError")} />
                )}
              </Fact>
              {overview.data ? (
                <Fact label={t("common:nav.providers")}>
                  <span className="text-ink">
                    {t("usage:overview.providers", { count: overview.data.providers_configured })}
                    {overview.data.providers_in_error > 0 ? (
                      <span className="ml-1.5 text-danger-text">
                        ·{" "}
                        {t("usage:overview.providersInError", {
                          count: overview.data.providers_in_error,
                        })}
                      </span>
                    ) : null}
                  </span>
                </Fact>
              ) : null}
              <Fact label={t("overview.created")}>
                {detail.data ? (
                  <span className="text-ink">{date(detail.data.created_at)}</span>
                ) : (
                  <Skeleton className="h-4 w-24" />
                )}
              </Fact>
              <Fact label={t("overview.url")}>
                <span
                  className="min-w-0 truncate font-mono text-xs text-ink"
                  title={workspaceAddress(workspace.slug)}
                >
                  /w/{workspace.slug}
                </span>
              </Fact>
            </dl>
          </Card>
          <Card>
            <h2 className="border-b border-line px-5 py-3.5 text-[15px] font-semibold text-ink">
              {t("usage:overview.shortcuts")}
            </h2>
            <ul className="divide-y divide-line">
              {can(detail.data, "agents:write") ? (
                <li>
                  <QuickLink to={`${basePath}/agents/new`} icon={<Plus aria-hidden />}>
                    {t("usage:overview.newAgent")}
                  </QuickLink>
                </li>
              ) : null}
              {can(detail.data, "providers:manage") ? (
                <li>
                  <QuickLink to={`${basePath}/providers`} icon={<KeyRound aria-hidden />}>
                    {t("usage:overview.addProvider")}
                  </QuickLink>
                </li>
              ) : null}
              <li>
                <QuickLink to={`${basePath}/usage`} icon={<ChartColumn aria-hidden />}>
                  {t("usage:overview.openUsage")}
                </QuickLink>
              </li>
              {can(detail.data, "invitations:manage") ? (
                <li>
                  <QuickLink to={`${basePath}/settings/members`} icon={<UserPlus aria-hidden />}>
                    {t("overview.manageMembers")}
                  </QuickLink>
                </li>
              ) : null}
              <li>
                <QuickLink to={`${basePath}/settings/general`} icon={<Settings aria-hidden />}>
                  {t("overview.openSettings")}
                </QuickLink>
              </li>
            </ul>
          </Card>
        </motion.aside>
      </motion.div>
    </PageContainer>
  );
}

function MetricCard({
  label,
  to,
  children,
  footer,
  icon,
}: {
  label: string;
  to: string;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <motion.li variants={listItem}>
      <Link
        to={to}
        className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
          {label}
          {icon}
        </span>
        <span className="mt-2 flex-1">{children}</span>
        {footer ? <span className="mt-2 block text-xs text-muted">{footer}</span> : null}
      </Link>
    </motion.li>
  );
}

function Metrics({ data, basePath }: { data: Overview; basePath: string }) {
  const { t } = useTranslation("usage");
  const day = data.executions_24h;
  const total24 = Object.values(day).reduce((sum, n) => sum + n, 0);
  const failed24 = (day.failed ?? 0) + (day.timed_out ?? 0);
  return (
    <motion.ul
      variants={staggerChildren(0.05)}
      initial="hidden"
      animate="visible"
      className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <MetricCard
        label={t("overview.executions24h")}
        to={`${basePath}/executions?period=24h`}
        footer={
          <>
            {t("overview.succeeded", { count: day.succeeded ?? 0 })}
            {failed24 > 0 ? (
              <span className="text-danger-text">
                {" "}
                · {t("overview.failed", { count: failed24 })}
              </span>
            ) : null}
          </>
        }
      >
        <span className="text-3xl font-semibold tracking-tight text-ink">
          <AnimatedNumber value={total24} />
        </span>
      </MetricCard>
      <MetricCard
        label={t("overview.successRate")}
        to={`${basePath}/executions?period=7d`}
        footer={
          data.success_rate_7d === null
            ? t("overview.noFinished")
            : t("overview.medianDuration", {
                value: formatDuration(data.duration_7d.p50_ms ?? null),
              })
        }
      >
        <span className="flex items-center gap-4">
          <RingGauge value={data.success_rate_7d} label={t("overview.successRate")} size={64} />
        </span>
      </MetricCard>
      <MetricCard
        label={t("overview.runningNow")}
        to={`${basePath}/executions?status=running`}
        icon={
          data.running_now > 0 ? (
            <span className="relative inline-flex size-2.5">
              <span
                aria-hidden
                className="absolute inset-0 animate-breathe rounded-full bg-brand"
              />
              <span className="relative size-2.5 rounded-full bg-brand" />
            </span>
          ) : (
            <Activity aria-hidden className="size-4" />
          )
        }
        footer={
          data.queued_now > 0
            ? t("overview.queued", { count: data.queued_now })
            : t("overview.nothingRunning")
        }
      >
        <span className="text-3xl font-semibold tracking-tight text-ink">
          <AnimatedNumber value={data.running_now} />
        </span>
      </MetricCard>
      <MetricCard
        label={t("overview.monthCost")}
        to={`${basePath}/usage`}
        footer={t("overview.monthTokens", {
          tokens: formatTokens(data.month_tokens.input_tokens + data.month_tokens.output_tokens),
        })}
      >
        <span className="text-2xl font-semibold tracking-tight text-ink">
          <CostValue cost={data.month_cost} focusable={false} />
        </span>
      </MetricCard>
    </motion.ul>
  );
}

function Failures({ data, basePath }: { data: Overview; basePath: string }) {
  const { t } = useTranslation("usage");
  const diagnose = useDiagnosis();
  const { relative } = useFormatters();
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("overview.failures")} />
      <ul className="divide-y divide-line">
        {data.recent_failures.map((execution) => {
          const why = diagnose(execution.error_code ?? "internal_error");
          return (
            <li
              key={execution.id}
              className="relative flex items-start gap-3 px-5 py-3 hover:bg-surface-2/60"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger-text" />
              <div className="min-w-0 flex-1">
                <Link
                  to={`${basePath}/executions/${execution.id}`}
                  className="block truncate text-sm font-medium text-ink after:absolute after:inset-0 hover:text-brand-text"
                >
                  {why.title}
                </Link>
                <p className="truncate text-[13px] text-muted">
                  {execution.agent?.name ?? "—"} · {relative(execution.created_at)}
                </p>
              </div>
              <span className="shrink-0 text-xs font-medium text-brand-text">
                {t("overview.openTrace")}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function QuickLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="group flex min-h-11 items-center gap-3 px-5 py-3 text-sm font-medium text-ink transition-colors last:rounded-b-card hover:bg-surface-2 [&>svg]:size-4 [&>svg]:text-muted"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <ArrowRight
        aria-hidden
        className="text-muted transition-transform duration-150 group-hover:translate-x-0.5"
      />
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-5 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 justify-end">{children}</dd>
    </div>
  );
}
