import { Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { staggerChildren } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Card, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAgentOptions } from "@/features/agents/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useExecutions, type ExecutionFilters, type ExecutionStatus } from "./api";
import { ExecutionRow } from "./execution-row";
import { useTriggerLabel } from "./labels";
import { useWorkspaceLive, type WorkspaceStatusMessage } from "./live";

const STATUSES: ExecutionStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];
const TRIGGERS = ["manual", "api", "retry", "schedule", "webhook", "evaluation", "workflow"];
const PERIODS = ["all", "24h", "7d", "30d"] as const;

/** Screen L — every execution, filterable, updating live as states change. */
export function ExecutionsPage() {
  const { t } = useTranslation(["executions", "common"]);
  const { workspace, basePath } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(search);
  const agents = useAgentOptions(workspace.id);
  const triggerLabel = useTriggerLabel();
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filters: ExecutionFilters = useMemo(
    () => ({
      q,
      status: (params.get("status") as ExecutionStatus | null) ?? null,
      agentId: params.get("agent"),
      trigger: params.get("trigger"),
      period: (params.get("period") as ExecutionFilters["period"] | null) ?? "all",
    }),
    [q, params],
  );
  const executions = useExecutions(workspace.id, filters);
  const rows = useMemo(
    () => executions.data?.pages.flatMap((p) => p.data) ?? [],
    [executions.data],
  );
  const active = [
    filters.status,
    filters.agentId,
    filters.trigger,
    filters.period !== "all" ? filters.period : null,
    q || null,
  ].filter(Boolean).length;

  const onStatus = useCallback((message: WorkspaceStatusMessage) => {
    const id = message.execution_id;
    setFlash((current) => new Set(current).add(id));
    window.setTimeout(() => {
      setFlash((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 1500);
  }, []);
  useWorkspaceLive(workspace.id, onStatus);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <PageContainer wide>
      <PageHeader
        title={t("title")}
        description={t("description")}
        meta={
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand-text"
            title={t("liveHint")}
          >
            <span className="relative inline-flex size-2">
              <span
                aria-hidden
                className="absolute inset-0 animate-breathe rounded-full bg-brand"
              />
              <span className="relative size-2 rounded-full bg-brand" />
            </span>
            {t("live")}
          </span>
        }
      />
      <div
        role="search"
        aria-label={t("filters.label")}
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]"
      >
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setParam("q", event.target.value || null);
            }}
            placeholder={t("filters.search")}
            aria-label={t("filters.search")}
            className="pl-9"
          />
        </div>
        <Select
          aria-label={t("filters.status")}
          value={filters.status ?? "all"}
          onValueChange={(value) => setParam("status", value === "all" ? null : value)}
          options={[
            { value: "all", label: t("filters.allStatuses") },
            ...STATUSES.map((s) => ({ value: s, label: t(`common:status.${s}`) })),
          ]}
        />
        <Select
          aria-label={t("filters.agent")}
          value={filters.agentId ?? "all"}
          onValueChange={(value) => setParam("agent", value === "all" ? null : value)}
          options={[
            { value: "all", label: t("filters.allAgents") },
            ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <Select
          aria-label={t("filters.trigger")}
          value={filters.trigger ?? "all"}
          onValueChange={(value) => setParam("trigger", value === "all" ? null : value)}
          options={[
            { value: "all", label: t("filters.allTriggers") },
            ...TRIGGERS.map((trigger) => ({ value: trigger, label: triggerLabel(trigger) })),
          ]}
        />
        <Select
          aria-label={t("filters.period")}
          value={filters.period}
          onValueChange={(value) => setParam("period", value === "all" ? null : value)}
          options={PERIODS.map((period) => ({
            value: period,
            label: t(`filters.periods.${period}`),
          }))}
        />
      </div>

      {executions.isPending ? (
        <Card className="divide-y divide-line">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3.5">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-9 flex-1" />
              <Skeleton className="hidden h-6 w-32 md:block" />
            </div>
          ))}
        </Card>
      ) : executions.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={executions.error}
            onRetry={() => void executions.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          {active > 0 ? (
            <EmptyState
              illustration="executions"
              title={t("empty.filteredTitle")}
              description={t("empty.filteredBody")}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch("");
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  {t("common:actions.clearFilters")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              illustration="executions"
              title={t("empty.title")}
              description={t("empty.body")}
              action={
                <Button asChild>
                  <Link to={`${basePath}/agents`}>{t("empty.action")}</Link>
                </Button>
              }
              className="py-16"
            />
          )}
        </Card>
      ) : (
        <Card className="@container overflow-hidden">
          <div
            aria-hidden
            className="hidden grid-cols-[7.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem_6rem_7rem] gap-4 border-b border-line bg-surface-2/50 px-5 py-2.5 text-xs font-medium text-muted @4xl:grid"
          >
            <span>{t("columns.status")}</span>
            <span>{t("columns.agent")}</span>
            <span>{t("columns.trigger")}</span>
            <span className="text-right">{t("columns.duration")}</span>
            <span className="text-right">{t("columns.cost")}</span>
            <span className="text-right">{t("columns.started")}</span>
          </div>
          <motion.ul
            variants={staggerChildren(0.02)}
            initial="hidden"
            animate="visible"
            className="divide-y divide-line"
            aria-label={t("title")}
          >
            <AnimatePresence initial={false}>
              {rows.map((execution) => (
                <ExecutionRow
                  key={execution.id}
                  execution={execution}
                  to={`${basePath}/executions/${execution.id}`}
                  highlight={flash.has(execution.id)}
                />
              ))}
            </AnimatePresence>
          </motion.ul>
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted">
            <span aria-live="polite">{t("countShown", { count: rows.length })}</span>
            {executions.hasNextPage ? (
              <Button
                variant="tertiary"
                size="sm"
                loading={executions.isFetchingNextPage}
                onClick={() => void executions.fetchNextPage()}
              >
                {t("common:actions.loadMore")}
              </Button>
            ) : null}
          </div>
        </Card>
      )}
    </PageContainer>
  );
}
