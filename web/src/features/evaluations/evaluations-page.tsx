import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, GitCompareArrows, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/dialog";
import { Alert, Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useAgentOptions } from "@/features/agents/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { percent, useCreateSuite, useRuns, useSuites, type Run, type Suite } from "./api";
import { OutcomeBar, RunStatusBadge } from "./visual";

/** Screen S — evaluation suites and the latest runs, with two-run comparison. */
export function EvaluationsPage() {
  const { t } = useTranslation(["evaluations", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const suites = useSuites(workspace.id);
  const runs = useRuns(workspace.id);
  const write = can(detail.data, "evaluations:write");
  const [creating, setCreating] = useState(false);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  return (
    <PageContainer wide>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          write ? (
            <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              {t("newSuite")}
            </Button>
          ) : null
        }
      />
      {!write && detail.data ? <Alert tone="info" title={t("readOnly")} className="mb-5" /> : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-labelledby="suites-title">
          <h2 id="suites-title" className="mb-3 text-[15px] font-semibold text-ink">
            {t("suites.title")}
          </h2>
          {suites.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-36 rounded-card" />
              ))}
            </div>
          ) : suites.isError ? (
            <Card>
              <ErrorState
                title={t("loadError")}
                error={suites.error}
                onRetry={() => void suites.refetch()}
              />
            </Card>
          ) : suites.data.length === 0 ? (
            <Card>
              <EmptyState
                illustration="evaluations"
                title={t("suites.empty")}
                description={t("suites.emptyBody")}
                action={
                  write ? (
                    <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                      {t("newSuite")}
                    </Button>
                  ) : undefined
                }
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
              {suites.data.map((suite) => (
                <SuiteCard
                  key={suite.id}
                  suite={suite}
                  to={`${basePath}/evaluations/suites/${suite.id}`}
                />
              ))}
            </motion.ul>
          )}
        </section>
        <RecentRuns runs={runs.data} pending={runs.isPending} basePath={basePath} />
      </div>
      {write ? (
        <CreateSuiteDialog
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspace.id}
          basePath={basePath}
        />
      ) : null}
    </PageContainer>
  );
}

function SuiteCard({ suite, to }: { suite: Suite; to: string }) {
  const { t } = useTranslation("evaluations");
  const { relative } = useFormatters();
  const rate = suite.last_run?.pass_rate ?? null;
  return (
    <motion.li variants={listItem}>
      <Link
        to={to}
        className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-ink group-hover:text-brand-text">
            {suite.name}
          </h3>
          <Badge tone="outline">{t("suites.cases", { count: suite.case_count })}</Badge>
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] text-muted">
          {suite.description ||
            (suite.agent_name
              ? t("suites.agent", { agent: suite.agent_name })
              : t("suites.noAgent"))}
        </p>
        <div className="mt-auto pt-4">
          {suite.last_run ? (
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>
                {t("suites.lastRun")} · {relative(suite.last_run.created_at)}
              </span>
              <span className="font-semibold text-ink tabular-nums">{percent(rate)}</span>
            </div>
          ) : (
            <p className="text-xs text-muted">{t("suites.neverRun")}</p>
          )}
          <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <motion.span
              className="block h-full rounded-full bg-success"
              initial={{ width: 0 }}
              animate={{ width: `${(rate ?? 0) * 100}%` }}
              transition={{ duration: 0.8, ease: [0.2, 0, 0, 1] }}
            />
          </div>
        </div>
      </Link>
    </motion.li>
  );
}

function RecentRuns({
  runs,
  pending,
  basePath,
}: {
  runs: Run[] | undefined;
  pending: boolean;
  basePath: string;
}) {
  const { t } = useTranslation("evaluations");
  const { relative } = useFormatters();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-2),
    );
  const [first, second] = selected;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t("runs.title")}
        description={t("runs.compareHint")}
        actions={
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<GitCompareArrows aria-hidden />}
            disabled={!first || !second}
            onClick={() => {
              if (!first || !second) return;
              // The older run is the reference.
              const ordered = (runs ?? []).filter((r) => selected.includes(r.id)).reverse();
              const [base, candidate] = ordered.map((r) => r.id);
              void navigate(
                `${basePath}/evaluations/compare?base=${base ?? first}&candidate=${candidate ?? second}`,
              );
            }}
          >
            {t("runs.compare")}
          </Button>
        }
      />
      {pending ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : !runs || runs.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((run) => (
            <li
              key={run.id}
              className="relative flex items-center gap-3 px-5 py-3 hover:bg-surface-2/50"
            >
              <Checkbox
                checked={selected.includes(run.id)}
                onCheckedChange={() => toggle(run.id)}
                aria-label={t("runs.selectRun", { label: run.label })}
                className="relative z-10"
              />
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
                <p className="mt-0.5 truncate text-xs text-muted">
                  {run.suite_name} · {relative(run.created_at)}
                </p>
                <OutcomeBar summary={run.summary} className="mt-2" />
              </div>
              <span className="w-12 text-right text-sm font-semibold text-ink tabular-nums">
                {percent(run.summary.pass_rate)}
              </span>
              <ArrowRight aria-hidden className="size-4 text-muted" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CreateSuiteDialog({
  open,
  onOpenChange,
  workspaceId,
  basePath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const navigate = useNavigate();
  const agents = useAgentOptions(workspaceId);
  const create = useCreateSuite(workspaceId);
  const [problem, setProblem] = useState<unknown>(null);
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t("suiteForm.nameRequired")).max(120),
        description: z.string().trim().max(1000),
        agent_id: z.string(),
        pass_threshold: z.coerce.number().min(0).max(1),
      }),
    [t],
  );
  const form = useForm<{
    name: string;
    description: string;
    agent_id: string;
    pass_threshold: number;
  }>({
    resolver: zodResolver(schema) as never,
    defaultValues: { name: "", description: "", agent_id: "", pass_threshold: 1 },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      const suite = await create.mutateAsync({
        name: values.name,
        description: values.description,
        agent_id: values.agent_id || null,
        pass_threshold: values.pass_threshold,
      });
      toast.success(t("suiteForm.created", { name: suite.name }));
      onOpenChange(false);
      form.reset();
      void navigate(`${basePath}/evaluations/suites/${suite.id}`);
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "name"
          ? {
              field: "name",
              message: fieldError.code === "taken" ? t("suiteForm.nameTaken") : fieldError.message,
            }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("suiteForm.createTitle")}
      description={t("suiteForm.createDescription")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="suite-form" loading={isSubmitting}>
            {t("suiteForm.create")}
          </Button>
        </>
      }
    >
      <form
        id="suite-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5"
      >
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("suiteForm.name")} error={errors.name?.message} required>
          <Input
            maxLength={120}
            placeholder={t("suiteForm.namePlaceholder")}
            {...form.register("name")}
          />
        </Field>
        <Field label={t("suiteForm.descriptionLabel")}>
          <Textarea rows={2} maxLength={1000} {...form.register("description")} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t("suiteForm.agent")}>
            <Controller
              control={form.control}
              name="agent_id"
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                  placeholder={t("suiteForm.agentPlaceholder")}
                  options={(agents.data ?? [])
                    .filter((a) => a.status === "active")
                    .map((a) => ({ value: a.id, label: a.name }))}
                />
              )}
            />
          </Field>
          <Field
            label={t("suiteForm.threshold")}
            description={t("suiteForm.thresholdHelp")}
            error={errors.pass_threshold?.message}
          >
            <Input type="number" min={0} max={1} step={0.05} {...form.register("pass_threshold")} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
