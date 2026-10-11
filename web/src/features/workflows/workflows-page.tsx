import { ArrowRight, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Alert, Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { formatDuration } from "@/features/executions/format";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  useWorkflowRuns,
  useWorkflows,
  type RunStatus,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "./api";
import { CreateWorkflowDialog } from "./dialogs";
import { StepsBar } from "./visual";

/** Screen T — workflows of the workspace and their latest runs. */
export function WorkflowsPage() {
  const { t } = useTranslation(["workflows", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const [archived, setArchived] = useState(false);
  const workflows = useWorkflows(workspace.id, archived);
  const runs = useWorkflowRuns(workspace.id);
  const write = can(detail.data, "workflows:write");
  const [creating, setCreating] = useState(false);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const create = write ? (
    <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      {t("newWorkflow")}
    </Button>
  ) : null;

  return (
    <PageContainer wide>
      <PageHeader title={t("title")} description={t("description")} actions={create} />
      {!write && detail.data ? <Alert tone="info" title={t("readOnly")} className="mb-5" /> : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section aria-labelledby="workflows-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="workflows-title" className="text-[15px] font-semibold text-ink">
              {t("list.title")}
            </h2>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              {t("list.showArchived")}
              <Switch checked={archived} onCheckedChange={setArchived} />
            </label>
          </div>
          {workflows.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-36 rounded-card" />
              ))}
            </div>
          ) : workflows.isError ? (
            <Card>
              <ErrorState
                title={t("loadError")}
                error={workflows.error}
                onRetry={() => void workflows.refetch()}
              />
            </Card>
          ) : workflows.data.length === 0 ? (
            <Card>
              <EmptyState
                illustration="workflows"
                title={t("list.empty")}
                description={t("list.emptyBody")}
                action={create ?? undefined}
                className="py-14"
              />
            </Card>
          ) : (
            <motion.ul
              variants={staggerChildren(0.05)}
              initial="hidden"
              animate="visible"
              className="grid gap-3 sm:grid-cols-2"
            >
              {workflows.data.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  to={`${basePath}/workflows/${workflow.id}`}
                />
              ))}
            </motion.ul>
          )}
        </section>
        <RecentRuns
          runs={runs.data}
          pending={runs.isPending}
          basePath={basePath}
          title={t("runs.title")}
        />
      </div>
      {write ? (
        <CreateWorkflowDialog
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspace.id}
          basePath={basePath}
        />
      ) : null}
    </PageContainer>
  );
}

function WorkflowCard({ workflow, to }: { workflow: WorkflowSummary; to: string }) {
  const { t } = useTranslation("workflows");
  const { relative } = useFormatters();
  return (
    <motion.li variants={listItem}>
      <Link
        to={to}
        className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-ink group-hover:text-brand-text">
            {workflow.name}
          </h3>
          {workflow.archived ? (
            <Badge tone="outline">{t("list.archived")}</Badge>
          ) : workflow.current_version ? (
            <Badge tone="brand">{t("list.published", { version: workflow.current_version })}</Badge>
          ) : (
            <Badge tone="outline">{t("list.draftOnly")}</Badge>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] text-muted">
          {workflow.description || t("list.noDescription")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>{t("list.steps", { count: workflow.node_count })}</span>
          <span aria-hidden>·</span>
          <span>{t("list.agents", { count: workflow.agent_count })}</span>
          {workflow.current_version && workflow.has_unpublished_changes ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-warning-text">{t("list.unpublished")}</span>
            </>
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-[12px] text-muted">
          {workflow.last_run ? (
            <span className="inline-flex items-center gap-2">
              <StatusBadge status={workflow.last_run.status as RunStatus} />
              {relative(workflow.last_run.created_at)}
            </span>
          ) : (
            <span>{t("list.never")}</span>
          )}
          <ArrowRight
            aria-hidden
            className="size-4 text-muted transition-transform group-hover:translate-x-0.5"
          />
        </div>
      </Link>
    </motion.li>
  );
}

export function RecentRuns({
  runs,
  pending,
  basePath,
  title,
  showWorkflow = true,
}: {
  runs: WorkflowRunSummary[] | undefined;
  pending: boolean;
  basePath: string;
  title: string;
  showWorkflow?: boolean;
}) {
  const { t } = useTranslation("workflows");
  const { relative } = useFormatters();
  return (
    <Card>
      <CardHeader title={title} description={t("runs.subtitle")} />
      {pending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : !runs?.length ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                to={`${basePath}/workflows/runs/${run.id}`}
                className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {showWorkflow ? run.workflow_name : run.input_preview || run.id.slice(0, 8)}
                    </span>
                    <StatusBadge status={run.status as RunStatus} />
                    <Badge tone="outline">
                      {run.version ? t("runs.version", { version: run.version }) : t("runs.draft")}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <StepsBar
                      done={run.steps_done}
                      total={run.steps_total}
                      status={run.status}
                      className="max-w-48"
                    />
                    <span className="shrink-0 text-[12px] text-muted tabular-nums">
                      {t("runs.progress", { done: run.steps_done, total: run.steps_total })}
                      {run.duration_ms !== null ? ` · ${formatDuration(run.duration_ms)}` : ""}
                      {` · ${relative(run.created_at)}`}
                    </span>
                  </div>
                </div>
                <ArrowRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
