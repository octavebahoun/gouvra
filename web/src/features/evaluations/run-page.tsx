import { Ban, ChevronDown, ExternalLink, GitCompareArrows } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import {
  duration as motionDuration,
  ease,
  fadeUp,
  staggerChildren,
} from "@/components/motion/presets";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RingGauge } from "@/components/ui/charts";
import { Select } from "@/components/ui/controls";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { ErrorState, NotFoundState } from "@/components/ui/states";
import { CostValue } from "@/features/executions/cost";
import { formatCost, formatDuration } from "@/features/executions/format";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useCancelRun, useRun, useRuns, type Result, type RunDetail } from "./api";
import { OutcomeBar, ResultBadge, RunStatusBadge } from "./visual";

/** Screen S (run) — a suite run on one version or variant, with per-case results arriving live. */
export function RunPage() {
  const { runId = "" } = useParams();
  const { t } = useTranslation(["evaluations", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const run = useRun(runId);
  useDocumentTitle(run.data ? `${run.data.label} — ${workspace.name}` : null);

  if (run.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-96" />
        <Skeleton className="mb-6 h-32 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </PageContainer>
    );
  }
  if (run.isError) {
    return isApiError(run.error) && run.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("run.notFoundTitle")}
        description={t("run.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={run.error} onRetry={() => void run.refetch()} />
        </Card>
      </PageContainer>
    );
  }
  const data = run.data;
  return (
    <PageContainer wide>
      <Header
        run={data}
        basePath={basePath}
        workspaceId={workspace.id}
        canCancel={can(detail.data, "evaluations:write")}
      />
      <Summary run={data} />
      <Results run={data} basePath={basePath} />
    </PageContainer>
  );
}

function Header({
  run,
  basePath,
  workspaceId,
  canCancel,
}: {
  run: RunDetail;
  basePath: string;
  workspaceId: string;
  canCancel: boolean;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const cancel = useCancelRun(workspaceId);
  const changes = Object.entries(run.overrides).map(([key, value]) =>
    key === "model"
      ? t("run.overrides.model", { value: String(value) })
      : key === "provider_id"
        ? t("run.overrides.provider_id")
        : t("run.overrides.instructions"),
  );
  return (
    <PageHeader
      breadcrumbs={[
        { label: t("run.breadcrumb"), to: `${basePath}/evaluations` },
        { label: run.suite_name, to: `${basePath}/evaluations/suites/${run.suite_id}` },
        { label: run.label },
      ]}
      title={run.label}
      meta={
        <>
          <RunStatusBadge status={run.status} />
          {run.agent_version ? <Badge tone="outline">v{run.agent_version}</Badge> : null}
          {run.model ? (
            <Badge tone="outline" className="font-mono">
              {run.model}
            </Badge>
          ) : null}
        </>
      }
      description={
        changes.length
          ? t("run.variant", { changes: changes.join(", ") })
          : (run.agent_name ?? undefined)
      }
      actions={
        <>
          {run.status === "running" && canCancel ? (
            <Button
              variant="secondary"
              leftIcon={<Ban aria-hidden />}
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(run.id, {
                  onSuccess: () => toast.success(t("run.cancelled")),
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {t("run.cancel")}
            </Button>
          ) : null}
          <CompareWith run={run} basePath={basePath} workspaceId={workspaceId} />
        </>
      }
    />
  );
}

function CompareWith({
  run,
  basePath,
  workspaceId,
}: {
  run: RunDetail;
  basePath: string;
  workspaceId: string;
}) {
  const { t } = useTranslation("evaluations");
  const runs = useRuns(workspaceId, run.suite_id, 50);
  const others = (runs.data ?? []).filter((r) => r.id !== run.id);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label={t("run.compareWith")}
        placeholder={t("run.compareWith")}
        value={choice}
        onValueChange={setChoice}
        className="w-56"
        options={others.map((r) => ({ value: r.id, label: r.label }))}
      />
      <Button
        asChild={Boolean(choice)}
        variant="secondary"
        leftIcon={<GitCompareArrows aria-hidden />}
        disabled={!choice}
      >
        {choice ? (
          <Link to={`${basePath}/evaluations/compare?base=${choice}&candidate=${run.id}`}>
            {t("runs.compare")}
          </Link>
        ) : (
          t("runs.compare")
        )}
      </Button>
    </div>
  );
}

function Metric({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-card border border-line bg-surface px-4 py-3 shadow-sm"
    >
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-ink tabular-nums">{children}</dd>
      {sub ? <dd className="mt-0.5 text-xs text-muted">{sub}</dd> : null}
    </motion.div>
  );
}

function Summary({ run }: { run: RunDetail }) {
  const { t } = useTranslation("evaluations");
  const s = run.summary;
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
      <Card className="flex items-center gap-5 px-5 py-4">
        <RingGauge value={s.pass_rate} label={t("run.passRate")} size={88} />
        <div>
          <p className="text-xs text-muted">{t("run.passRate")}</p>
          <p className="mt-1 text-sm text-ink">
            <span className="text-success-text">
              {t("run.passed")} {s.passed}
            </span>
            {" · "}
            <span className="text-danger-text">
              {t("run.failed")} {s.failed}
            </span>
            {s.errored ? (
              <span className="text-warning-text">
                {" "}
                · {t("run.errored")} {s.errored}
              </span>
            ) : null}
            {s.pending ? (
              <span className="text-brand-text">
                {" "}
                · {t("run.pending")} {s.pending}
              </span>
            ) : null}
          </p>
          <OutcomeBar summary={s} className="mt-2 w-56" />
        </div>
      </Card>
      <motion.dl
        variants={staggerChildren(0.04)}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        <Metric label={t("run.avgScore")}>
          {s.avg_score === null ? (
            "—"
          ) : (
            <AnimatedNumber value={s.avg_score} format={(v) => v.toFixed(2)} />
          )}
        </Metric>
        <Metric
          label={t("run.duration")}
          sub={
            s.p95_duration_ms !== null
              ? t("run.p95", { value: formatDuration(s.p95_duration_ms) })
              : undefined
          }
        >
          {formatDuration(s.avg_duration_ms)}
        </Metric>
        <Metric
          label={t("run.cost")}
          sub={
            s.judge_cost_amount
              ? t("run.judgeCost", {
                  value: formatCost(s.judge_cost_amount, s.cost_currency ?? "USD"),
                })
              : undefined
          }
        >
          <CostValue
            cost={{
              amount: s.cost_amount,
              currency: s.cost_currency,
              source: s.cost_source,
              partial: s.cost_partial,
            }}
          />
        </Metric>
        <Metric label={t("suite.cases")}>
          <AnimatedNumber value={s.cases} />
        </Metric>
      </motion.dl>
    </div>
  );
}

function Results({ run, basePath }: { run: RunDetail; basePath: string }) {
  const { t } = useTranslation("evaluations");
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("run.results")} />
      <ul className="divide-y divide-line">
        {run.results.map((result) => (
          <ResultRow key={result.id} result={result} basePath={basePath} />
        ))}
      </ul>
    </Card>
  );
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

function ResultRow({ result, basePath }: { result: Result; basePath: string }) {
  const { t } = useTranslation("evaluations");
  const [open, setOpen] = useState(false);
  const graders = result.grader_results as {
    type: string;
    passed: boolean;
    score: number;
    details: string;
    error?: string | null;
  }[];
  return (
    <li>
      <div className="flex items-center gap-3 px-5 py-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {result.case_name}
          </span>
        </button>
        <motion.span
          key={result.status}
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        >
          <ResultBadge status={result.status} />
        </motion.span>
        <span
          className="hidden w-28 items-center gap-2 sm:flex"
          aria-label={`${t("run.score")} ${result.score ?? "—"}`}
        >
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <motion.span
              className={cn(
                "block h-full rounded-full",
                result.status === "passed" ? "bg-success" : "bg-danger",
              )}
              initial={{ width: 0 }}
              animate={{ width: `${(result.score ?? 0) * 100}%` }}
              transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
            />
          </span>
          <span className="w-8 text-right text-xs text-ink tabular-nums">
            {result.score === null ? "—" : result.score.toFixed(2)}
          </span>
        </span>
        <span className="hidden w-20 text-right text-xs text-muted tabular-nums md:block">
          {formatDuration(result.duration_ms)}
        </span>
        {result.execution_id ? (
          <Link
            to={`${basePath}/executions/${result.execution_id}`}
            aria-label={t("run.openTrace", { name: result.case_name })}
            className="inline-flex size-8 items-center justify-center rounded-field text-muted hover:bg-surface-2 hover:text-ink"
          >
            <ExternalLink aria-hidden className="size-4" />
          </Link>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: "auto",
              opacity: 1,
              transition: { duration: motionDuration.base, ease: ease.standard },
            }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="grid gap-4 border-t border-line bg-surface-2/30 px-5 py-4 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-medium text-muted">{t("run.graderDetails")}</p>
                <ul className="flex flex-col gap-2">
                  {graders.map((grader, index) => (
                    <li
                      key={index}
                      className="rounded-field border border-line bg-surface px-3 py-2 text-[13px]"
                    >
                      <span className="flex items-center gap-2">
                        <Badge
                          tone={grader.error ? "warning" : grader.passed ? "success" : "danger"}
                          className="h-5 px-2 text-[11px]"
                        >
                          {t(`graders.types.${grader.type as "exact"}`, grader.type)}
                        </Badge>
                        <span className="ml-auto text-xs text-muted tabular-nums">
                          {grader.score.toFixed(2)}
                        </span>
                      </span>
                      <span className="mt-1 block text-muted">{grader.details}</span>
                    </li>
                  ))}
                  {result.error ? (
                    <li className="rounded-field bg-danger-soft px-3 py-2 text-[13px] text-danger-text">
                      <span className="font-mono text-xs">{textOf(result.error.code)}</span> —{" "}
                      {textOf(result.error.message)}
                    </li>
                  ) : null}
                </ul>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-muted">{t("run.output")}</p>
                <p className="max-h-56 overflow-auto rounded-field border border-line bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink">
                  {(result.output_text ?? "").length > 0 ? result.output_text : t("run.noOutput")}
                </p>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
