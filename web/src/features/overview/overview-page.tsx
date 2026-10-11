import { ArrowRight, Settings, UserPlus } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { can } from "@/lib/auth/permissions";
import { useCurrentSession } from "@/lib/auth/session";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { EmptyState, Unavailable } from "@/components/ui/states";
import { OnboardingChecklist } from "@/features/onboarding/onboarding-checklist";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { workspaceAddress } from "@/features/workspaces/slug";

/**
 * Screen G — overview. Until agents run (phase 3), it shows the setup checklist, an honest
 * empty activity block and the workspace's facts — never invented numbers.
 */
export function OverviewPage() {
  const { t } = useTranslation(["shell", "common"]);
  const session = useCurrentSession();
  const { workspace, role, basePath, detail } = useCurrentWorkspace();
  const { date } = useFormatters();
  useDocumentTitle(`${t("overview.title")} — ${workspace.name}`);

  const firstName = session.user.display_name.split(/\s+/)[0] ?? session.user.display_name;

  return (
    <PageContainer>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.description", { name: firstName, workspace: workspace.name })}
        meta={workspace.is_demo ? <Badge tone="warning">{t("workspace.demo")}</Badge> : null}
      />
      <motion.div
        variants={staggerChildren(0.06)}
        initial="hidden"
        animate="visible"
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]"
      >
        <div className="flex min-w-0 flex-col gap-6">
          <motion.div variants={fadeUp}>
            <OnboardingChecklist
              workspace={workspace}
              canDismiss={can(detail.data, "workspace:update")}
            />
          </motion.div>
          <motion.div variants={fadeUp}>
            <Card>
              <CardHeader title={t("overview.activityTitle")} />
              <EmptyState
                illustration="executions"
                title={t("overview.activityEmptyTitle")}
                description={t("overview.activityEmptyBody")}
                className="py-10"
              />
            </Card>
          </motion.div>
        </div>

        <motion.aside variants={fadeUp} aria-labelledby="overview-about">
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
              <Fact label={t("overview.created")}>
                {detail.isPending ? (
                  <Skeleton className="h-4 w-24" />
                ) : detail.data ? (
                  <span className="text-ink">{date(detail.data.created_at)}</span>
                ) : (
                  <Unavailable reason={t("overview.detailsError")} />
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
            <ul className="divide-y divide-line border-t border-line">
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
