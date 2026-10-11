import { Archive, FileJson, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { EmptyState, ErrorState, NotFoundState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  percent,
  useArchiveSuite,
  useCases,
  useDeleteCase,
  useRuns,
  useSuite,
  useUpdateSuite,
  type Case,
  type GraderSpec,
  type Suite,
} from "./api";
import { GradersEditor } from "./graders-editor";
import { graderProblem, useGraderSummary } from "./graders";
import { CaseDialog, ImportDialog, RunDialog } from "./suite-dialogs";
import { OutcomeBar, RunStatusBadge } from "./visual";

function preview(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "—";
  if (typeof value.text === "string") return value.text;
  return JSON.stringify("json" in value ? value.json : value);
}

/** Screen S (suite) — its cases and graders, its runs, its settings. */
export function SuitePage() {
  const { suiteId = "" } = useParams();
  const { t } = useTranslation(["evaluations", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const suite = useSuite(suiteId);
  const [tab, setTab] = useState("cases");
  const [running, setRunning] = useState(false);
  const write = can(detail.data, "evaluations:write");
  useDocumentTitle(suite.data ? `${suite.data.name} — ${workspace.name}` : null);

  if (suite.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-96" />
        <Skeleton className="h-96 rounded-card" />
      </PageContainer>
    );
  }
  if (suite.isError) {
    return isApiError(suite.error) && suite.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("suite.notFoundTitle")}
        description={t("suite.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={suite.error} onRetry={() => void suite.refetch()} />
        </Card>
      </PageContainer>
    );
  }
  const data = suite.data;
  return (
    <PageContainer wide>
      <PageHeader
        breadcrumbs={[
          { label: t("suite.breadcrumb"), to: `${basePath}/evaluations` },
          { label: data.name },
        ]}
        title={data.name}
        meta={
          <>
            <Badge tone="outline">{t("suites.cases", { count: data.case_count })}</Badge>
            <Badge tone="outline">{t("suite.threshold", { value: data.pass_threshold })}</Badge>
            {data.archived ? <Badge tone="neutral">{t("suites.archived")}</Badge> : null}
          </>
        }
        description={
          data.description ||
          (data.agent_name ? t("suites.agent", { agent: data.agent_name }) : undefined)
        }
        actions={
          write && !data.archived ? (
            <Button
              leftIcon={<Play aria-hidden />}
              disabled={data.case_count === 0}
              onClick={() => setRunning(true)}
            >
              {t("suite.run")}
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          value={tab}
          aria-label={data.name}
          items={[
            { value: "cases", label: t("suite.cases"), count: data.case_count },
            { value: "runs", label: t("suite.runs") },
            ...(write ? [{ value: "settings", label: t("suite.settings") }] : []),
          ]}
          className="mb-6"
        />
        <TabsContent value="cases">
          <Cases suite={data} workspaceId={workspace.id} write={write} />
        </TabsContent>
        <TabsContent value="runs">
          <SuiteRuns suite={data} workspaceId={workspace.id} basePath={basePath} />
        </TabsContent>
        {write ? (
          <TabsContent value="settings">
            <Settings suite={data} workspaceId={workspace.id} basePath={basePath} />
          </TabsContent>
        ) : null}
      </Tabs>
      {running ? (
        <RunDialog
          open
          onOpenChange={setRunning}
          workspaceId={workspace.id}
          basePath={basePath}
          suite={data}
        />
      ) : null}
    </PageContainer>
  );
}

function Cases({
  suite,
  workspaceId,
  write,
}: {
  suite: Suite;
  workspaceId: string;
  write: boolean;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const cases = useCases(suite.id);
  const remove = useDeleteCase(workspaceId, suite.id);
  const summary = useGraderSummary();
  const [editing, setEditing] = useState<{ item: Case | null; session: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<Case | null>(null);
  const open = (item: Case | null) => setEditing({ item, session: Date.now() });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t("suite.cases")}
        actions={
          write && !suite.archived ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<FileJson aria-hidden />}
                onClick={() => setImporting(true)}
              >
                {t("suite.import")}
              </Button>
              <Button size="sm" leftIcon={<Plus aria-hidden />} onClick={() => open(null)}>
                {t("suite.addCase")}
              </Button>
            </>
          ) : null
        }
      />
      {cases.isPending ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : cases.isError ? (
        <ErrorState compact error={cases.error} onRetry={() => void cases.refetch()} />
      ) : cases.data.length === 0 ? (
        <EmptyState
          compact
          illustration="evaluations"
          title={t("suite.emptyCases")}
          description={t("suite.emptyCasesBody")}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t("suite.columns.case")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("suite.columns.expected")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("suite.columns.graders")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("suite.columns.tags")}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  <span className="sr-only">{t("suite.columns.actions")}</span>
                </th>
              </tr>
            </thead>
            <motion.tbody variants={staggerChildren(0.03)} initial="hidden" animate="visible">
              {cases.data.map((item) => (
                <motion.tr
                  key={item.id}
                  variants={listItem}
                  className="border-b border-line align-top last:border-b-0"
                >
                  <th scope="row" className="max-w-80 px-5 py-3 text-left font-normal">
                    <span className="block font-medium text-ink">{item.name}</span>
                    <span className="mt-0.5 line-clamp-2 block font-mono text-xs text-muted">
                      {preview(item.input)}
                    </span>
                  </th>
                  <td className="max-w-64 px-3 py-3">
                    <span className="line-clamp-2 font-mono text-xs text-ink">
                      {preview(item.expected)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted">
                    {item.graders?.length ? (
                      summary(item.graders)
                    ) : (
                      <span className="italic">{t("suite.defaultGraderLabel")}</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <Badge key={tag} tone="outline" className="h-5 px-2 text-[11px]">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td className="px-5 py-2 text-right whitespace-nowrap">
                    {write && !suite.archived ? (
                      <>
                        <IconButton
                          size="icon-sm"
                          label={t("suite.editCase", { name: item.name })}
                          icon={<Pencil aria-hidden />}
                          onClick={() => open(item)}
                        />
                        <IconButton
                          size="icon-sm"
                          variant="danger-ghost"
                          label={t("suite.deleteCase", { name: item.name })}
                          icon={<Trash2 aria-hidden />}
                          onClick={() => setDeleting(item)}
                        />
                      </>
                    ) : null}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      )}
      {editing ? (
        <CaseDialog
          key={editing.session}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          workspaceId={workspaceId}
          suiteId={suite.id}
          existing={editing.item}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          open
          onOpenChange={setImporting}
          workspaceId={workspaceId}
          suiteId={suite.id}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={t("suite.deleteCase", { name: deleting?.name ?? "" })}
        description={t("suite.deleteCaseBody")}
        confirmLabel={t("common:actions.delete")}
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          const name = deleting.name;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.success(t("suite.caseDeleted", { name }));
            },
            onError: (error) => toast.error(error.message),
          });
        }}
      />
    </Card>
  );
}

function SuiteRuns({
  suite,
  workspaceId,
  basePath,
}: {
  suite: Suite;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation("evaluations");
  const runs = useRuns(workspaceId, suite.id, 50);
  const { relative } = useFormatters();
  if (runs.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (runs.isError) {
    return (
      <Card>
        <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      {runs.data.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.data.map((run) => (
            <li
              key={run.id}
              className="relative flex items-center gap-4 px-5 py-3 hover:bg-surface-2/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`${basePath}/evaluations/runs/${run.id}`}
                    className="truncate text-sm font-medium text-ink after:absolute after:inset-0 hover:text-brand-text"
                  >
                    {run.label}
                  </Link>
                  <RunStatusBadge status={run.status} />
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {relative(run.created_at)}
                  {run.created_by ? ` · ${run.created_by}` : ""}
                </p>
                <OutcomeBar summary={run.summary} className="mt-2 max-w-md" />
              </div>
              <span className="text-lg font-semibold text-ink tabular-nums">
                {percent(run.summary.pass_rate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Settings({
  suite,
  workspaceId,
  basePath,
}: {
  suite: Suite;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const navigate = useNavigate();
  const update = useUpdateSuite(workspaceId);
  const archive = useArchiveSuite(workspaceId);
  const [name, setName] = useState(suite.name);
  const [description, setDescription] = useState(suite.description);
  const [threshold, setThreshold] = useState(String(suite.pass_threshold));
  const [graders, setGraders] = useState<GraderSpec[]>(suite.default_graders as GraderSpec[]);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (graderProblem(graders)) {
      setError(t("caseForm.gradersHelp"));
      return;
    }
    setError(null);
    update.mutate(
      {
        id: suite.id,
        body: { name, description, pass_threshold: Number(threshold), default_graders: graders },
      },
      {
        onSuccess: (saved) => toast.success(t("suite.saved", { name: saved.name })),
        onError: (problem) =>
          setError(
            isApiError(problem)
              ? (problem.fieldErrors[0]?.message ?? problem.message)
              : problem.message,
          ),
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-5 p-5">
          <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
            <Field label={t("suiteForm.name")} required>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("suiteForm.threshold")}>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("suiteForm.descriptionLabel")}>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <fieldset>
            <legend className="mb-1 text-[13px] font-medium text-ink">
              {t("suite.defaultGraders")}
            </legend>
            <p className="mb-3 text-[13px] text-muted">{t("suite.noDefaultGraders")}</p>
            <GradersEditor workspaceId={workspaceId} value={graders} onChange={setGraders} />
          </fieldset>
          {error ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button loading={update.isPending} onClick={save}>
            {t("common:actions.save")}
          </Button>
        </div>
      </Card>
      <Card className="border-danger/30">
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-muted">{t("suite.archiveBody")}</p>
          <Button
            variant="danger-ghost"
            leftIcon={<Archive aria-hidden />}
            onClick={() => setArchiving(true)}
          >
            {t("suite.archive")}
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t("suite.archiveTitle", { name: suite.name })}
        description={t("suite.archiveBody")}
        confirmLabel={t("suite.archive")}
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate(suite.id, {
            onSuccess: () => {
              toast.success(t("suite.archived", { name: suite.name }));
              void navigate(`${basePath}/evaluations`);
            },
            onError: (problem) => toast.error(problem.message),
          })
        }
      />
    </div>
  );
}
