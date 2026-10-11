import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Copy,
  Ellipsis,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { ActivityBars, RingGauge } from "@/components/ui/charts";
import { IdChip } from "@/components/ui/copy-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { EmptyState, ErrorState, NotFoundState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useExecutions } from "@/features/executions/api";
import { CostValue } from "@/features/executions/cost";
import { ExecutionRow } from "@/features/executions/execution-row";
import { formatDuration, formatTokens } from "@/features/executions/format";
import { LaunchDialog } from "@/features/executions/launch-dialog";
import { ToolMark } from "@/features/tools/tool-visual";
import {
  useAgent,
  useAgentStats,
  useAgentVersions,
  useDeleteAgent,
  useDuplicateAgent,
  useRestoreVersion,
  useSetArchived,
  type Agent,
  type AgentVersion,
} from "./api";
import { ModelChip, ReadinessBadge } from "./agent-visual";

/** Screen J — an agent: configuration, health over 30 days, recent runs and versions. */
export function AgentPage() {
  const { agentId = "" } = useParams();
  const { t } = useTranslation(["agents", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const agent = useAgent(agentId);
  const [tab, setTab] = useState("overview");
  const [launching, setLaunching] = useState(false);
  useDocumentTitle(agent.data ? `${agent.data.name} — ${workspace.name}` : null);

  if (agent.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-96" />
        <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-96 rounded-card" />
        </div>
      </PageContainer>
    );
  }
  if (agent.isError) {
    return isApiError(agent.error) && agent.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("detail.notFoundTitle")}
        description={t("detail.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />
        </Card>
      </PageContainer>
    );
  }

  const data = agent.data;
  const write = can(detail.data, "agents:write");
  const launchAllowed = can(detail.data, "executions:launch") && data.status === "active";

  return (
    <PageContainer wide>
      <PageHeader
        breadcrumbs={[{ label: t("title"), to: `${basePath}/agents` }, { label: data.name }]}
        title={data.name}
        meta={
          <>
            <ReadinessBadge agent={data} />
            {data.version ? <Badge tone="outline">v{data.version.number}</Badge> : null}
            <IdChip id={data.id} label={t("common:a11y.copyValue")} />
          </>
        }
        description={data.description || undefined}
        actions={
          <>
            {launchAllowed ? (
              <Button
                leftIcon={<Play aria-hidden />}
                disabled={!data.ready}
                onClick={() => setLaunching(true)}
              >
                {t("detail.run")}
              </Button>
            ) : null}
            {write && data.status === "active" ? (
              <Button asChild variant="secondary" leftIcon={<Pencil aria-hidden />}>
                <Link to={`${basePath}/agents/${data.id}/edit`}>{t("detail.edit")}</Link>
              </Button>
            ) : null}
            {write ? (
              <AgentMenu agent={data} workspaceId={workspace.id} basePath={basePath} />
            ) : null}
          </>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          value={tab}
          aria-label={data.name}
          items={[
            { value: "overview", label: t("detail.overview") },
            { value: "versions", label: t("detail.versions"), count: data.latest_version_number },
          ]}
          className="mb-6"
        />
        <TabsContent value="overview">
          <Overview agent={data} basePath={basePath} workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="versions">
          <Versions agent={data} workspaceId={workspace.id} write={write} />
        </TabsContent>
      </Tabs>
      {launching ? (
        <LaunchDialog
          open
          onOpenChange={setLaunching}
          agent={data}
          workspaceId={workspace.id}
          basePath={basePath}
        />
      ) : null}
    </PageContainer>
  );
}

function AgentMenu({
  agent,
  workspaceId,
  basePath,
}: {
  agent: Agent;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent(workspaceId);
  const setArchived = useSetArchived(workspaceId);
  const remove = useDeleteAgent(workspaceId);
  const [deleting, setDeleting] = useState(false);
  const archived = agent.status === "archived";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            variant="secondary"
            label={t("menu.label", { name: agent.name })}
            icon={<Ellipsis aria-hidden />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() =>
              duplicate.mutate(agent.id, {
                onSuccess: (copy) => {
                  toast.success(t("toasts.duplicated", { name: copy.name }));
                  void navigate(`${basePath}/agents/${copy.id}`);
                },
                onError: (error) => toast.error(error.message),
              })
            }
          >
            <Copy aria-hidden />
            {t("menu.duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setArchived.mutate(
                { id: agent.id, archived: !archived },
                {
                  onSuccess: (saved) =>
                    toast.success(
                      t(archived ? "toasts.restored" : "toasts.archived", { name: saved.name }),
                    ),
                  onError: (error) => toast.error(error.message),
                },
              )
            }
          >
            {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
            {archived ? t("menu.restore") : t("menu.archive")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => setDeleting(true)}>
            <Trash2 aria-hidden />
            {t("menu.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("deleteDialog.title", { name: agent.name })}
        description={t("deleteDialog.body")}
        confirmLabel={t("deleteDialog.confirm")}
        resourceName={agent.name}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(agent.id, {
            onSuccess: () => {
              toast.success(t("toasts.deleted", { name: agent.name }));
              void navigate(`${basePath}/agents`);
            },
            onError: (error) => {
              setDeleting(false);
              toast.error(
                hasErrorCode(error, "agent_has_history")
                  ? t("deleteDialog.hasRuns")
                  : error.message,
              );
            },
          })
        }
      />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function Overview({
  agent,
  basePath,
  workspaceId,
}: {
  agent: Agent;
  basePath: string;
  workspaceId: string;
}) {
  const { t } = useTranslation(["agents", "executions", "common"]);
  const [expanded, setExpanded] = useState(false);
  const version = agent.version;
  const executions = useExecutions(
    workspaceId,
    { q: "", status: null, agentId: agent.id, trigger: null, period: "all" },
    8,
  );
  const recent = executions.data?.pages[0]?.data ?? [];
  const instructions = version?.instructions ?? "";
  const long = instructions.length > 600;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <motion.div
        variants={staggerChildren(0.06)}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6"
      >
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            <CardHeader title={t("detail.instructions")} />
            <div className="px-5 py-4">
              {instructions ? (
                <>
                  <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
                    {long && !expanded ? `${instructions.slice(0, 600)}…` : instructions}
                  </pre>
                  {long ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="mt-2"
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? t("common:actions.showLess") : t("common:actions.showMore")}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="text-[13px] text-muted">{t("detail.noInstructions")}</p>
              )}
            </div>
          </Card>
        </motion.div>
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            <CardHeader title={t("detail.configuration")} />
            <dl className="divide-y divide-line px-5">
              <Fact label={t("detail.provider")}>{version?.provider_name ?? "—"}</Fact>
              <Fact label={t("detail.model")}>
                <ModelChip agent={agent} className="justify-end" />
              </Fact>
              <Fact label={t("detail.parameters")}>
                <span className="font-mono text-xs">
                  {[
                    version?.parameters.temperature !== null &&
                    version?.parameters.temperature !== undefined
                      ? `temperature ${String(version.parameters.temperature)}`
                      : null,
                    version ? `reasoning ${version.parameters.reasoning}` : null,
                    version?.parameters.response_format === "json" ? "json" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </span>
              </Fact>
              <Fact label={t("detail.tools")}>
                {version && version.tools.length > 0 ? (
                  <span className="flex flex-wrap justify-end gap-1.5">
                    {version.tools.map((tool) => (
                      <Link
                        key={tool.id}
                        to={`${basePath}/tools/${tool.id}`}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs hover:border-brand hover:text-brand-text"
                      >
                        <ToolMark kind="builtin" className="size-4 rounded-sm [&_svg]:size-3" />
                        {tool.display_name}
                        {!tool.available ? <span className="text-warning-text">!</span> : null}
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted">{t("detail.noTools")}</span>
                )}
              </Fact>
              <Fact label={t("detail.limits")}>
                {version ? (
                  <span className="text-xs text-ink">
                    {t("executions:launch.limitSteps", { count: version.limits.max_steps })} ·{" "}
                    {t("executions:launch.limitTools", {
                      count: version.limits.max_tool_calls,
                    })}{" "}
                    · {t("executions:launch.limitTime", { seconds: version.limits.timeout_s })}
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
            </dl>
          </Card>
        </motion.div>
      </motion.div>

      <motion.div
        variants={staggerChildren(0.06, 0.08)}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6"
      >
        <motion.div variants={fadeUp}>
          <StatsCard agent={agent} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            <CardHeader
              title={t("detail.recent")}
              actions={
                recent.length > 0 ? (
                  <Link
                    to={`${basePath}/executions?agent=${agent.id}`}
                    className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline"
                  >
                    {t("detail.allExecutions")}
                    <ArrowRight aria-hidden className="size-3.5" />
                  </Link>
                ) : null
              }
            />
            {executions.isPending ? (
              <div className="space-y-2 p-5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState compact illustration="executions" title={t("detail.noExecutions")} />
            ) : (
              <motion.ul
                variants={staggerChildren(0.03)}
                initial="hidden"
                animate="visible"
                className="divide-y divide-line"
              >
                {recent.map((execution) => (
                  <ExecutionRow
                    key={execution.id}
                    execution={execution}
                    to={`${basePath}/executions/${execution.id}`}
                    showAgent={false}
                    compact
                  />
                ))}
              </motion.ul>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}

function StatsCard({ agent }: { agent: Agent }) {
  const { t } = useTranslation(["agents", "executions"]);
  const stats = useAgentStats(agent.id, 30);
  if (stats.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (stats.isError) {
    return (
      <Card>
        <ErrorState compact error={stats.error} onRetry={() => void stats.refetch()} />
      </Card>
    );
  }
  const data = stats.data;
  const total = Object.values(data.executions).reduce((sum, n) => sum + n, 0);
  const points = data.series.map((p) => ({ ok: p.succeeded, failed: p.failed }));
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("detail.stats", { days: data.window_days })} />
      {total === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">{t("detail.noStats")}</p>
      ) : (
        <div className="flex flex-col gap-5 p-5">
          <div className="flex items-center gap-5">
            <RingGauge value={data.success_rate} label={t("detail.statsSuccess")} />
            <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <dt className="text-xs text-muted">{t("detail.statsExecutions")}</dt>
                <dd className="text-lg font-semibold text-ink">
                  <AnimatedNumber value={total} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t("detail.statsSuccess")}</dt>
                <dd className="text-lg font-semibold text-ink tabular-nums">
                  {data.success_rate === null ? "—" : `${Math.round(data.success_rate * 100)}%`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t("detail.statsDuration")}</dt>
                <dd className="text-sm font-medium text-ink tabular-nums">
                  {formatDuration(data.duration.p50_ms ?? null)}
                  <span className="ml-1.5 text-xs font-normal text-muted">
                    {t("detail.statsP95", { value: formatDuration(data.duration.p95_ms ?? null) })}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t("detail.statsCost")}</dt>
                <dd className="text-sm font-medium text-ink">
                  <CostValue cost={data.cost} />
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <ActivityBars points={points} />
            <p className="mt-1 text-xs text-muted">
              {t("detail.statsTokens")}: {formatTokens(data.tokens.input_tokens)} →{" "}
              {formatTokens(data.tokens.output_tokens)}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function Versions({
  agent,
  workspaceId,
  write,
}: {
  agent: Agent;
  workspaceId: string;
  write: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const versions = useAgentVersions(agent.id);
  const restore = useRestoreVersion(workspaceId);
  const { relative, dateTime } = useFormatters();
  const [restoring, setRestoring] = useState<AgentVersion | null>(null);

  if (versions.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (versions.isError) {
    return (
      <Card>
        <ErrorState compact error={versions.error} onRetry={() => void versions.refetch()} />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <motion.ol
        variants={staggerChildren(0.04)}
        initial="hidden"
        animate="visible"
        className="relative divide-y divide-line"
      >
        {versions.data.map((version) => (
          <motion.li
            key={version.id}
            variants={fadeUp}
            className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink tabular-nums">
                v{version.number}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  <span className="font-medium">
                    {version.change_note ?? t("detail.versionNoNote")}
                  </span>
                  {version.is_current ? (
                    <Badge tone="brand">{t("detail.currentVersion")}</Badge>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[13px] text-muted">
                  <span className="font-mono">{version.model || "—"}</span>
                  {version.created_by ? ` · ${version.created_by}` : ""} ·{" "}
                  <span title={dateTime(version.created_at)}>{relative(version.created_at)}</span>
                </p>
              </div>
            </div>
            {write && !version.is_current && agent.status === "active" ? (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RotateCcw aria-hidden />}
                aria-label={t("detail.restoreLabel", { number: version.number })}
                onClick={() => setRestoring(version)}
              >
                {t("detail.restoreVersion")}
              </Button>
            ) : null}
          </motion.li>
        ))}
      </motion.ol>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        tone="primary"
        title={t("detail.restoreTitle", { number: restoring?.number ?? 0 })}
        description={t("detail.restoreBody")}
        confirmLabel={t("detail.restoreVersion")}
        pending={restore.isPending}
        onConfirm={() => {
          if (!restoring) return;
          const from = restoring.number;
          restore.mutate(
            { id: agent.id, number: from },
            {
              onSuccess: (saved) => {
                setRestoring(null);
                toast.success(
                  t("toasts.versionRestored", { from, version: saved.latest_version_number }),
                );
              },
              onError: (error) => toast.error(error.message),
            },
          );
        }}
      />
    </Card>
  );
}
