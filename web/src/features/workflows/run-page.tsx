import { ReactFlowProvider } from "@xyflow/react";
import { ArrowLeft, ExternalLink, Pencil, RotateCcw, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { prettyJson } from "@/lib/json";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Alert, Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { useAnnounce } from "@/components/ui/live-region";
import { ErrorState, NotFoundState } from "@/components/ui/states";
import { useAgentOptions } from "@/features/agents/api";
import { CostValue } from "@/features/executions/cost";
import { formatDuration, formatTokens } from "@/features/executions/format";
import { useTools } from "@/features/tools/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  asGraph,
  useCancelRun,
  useStartRun,
  useWorkflowRun,
  type RunStatus,
  type WorkflowRun,
  type WorkflowStep,
} from "./api";
import { WorkflowCanvas, type Names, type Selection } from "./canvas";
import { useLiveRun } from "./live";
import { stepStatus } from "./meta";
import { StepsBar, StepStatusBadge, TypeIcon } from "./visual";

function textOf(value: unknown): string | null {
  return value && typeof value === "object" && "text" in value && typeof value.text === "string"
    ? value.text
    : null;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** One workflow run, live: the graph with each step's state, progress, result and step details. */
export function WorkflowRunPage() {
  const { runId = "" } = useParams();
  const { t } = useTranslation(["workflows", "common"]);
  const run = useWorkflowRun(runId);
  if (run.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-80" />
        <div className="mb-6 grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-[480px] rounded-card" />
      </PageContainer>
    );
  }
  if (run.isError) {
    return isApiError(run.error) && run.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("run.notFound")}
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
  return (
    <ReactFlowProvider>
      <RunView run={run.data} />
    </ReactFlowProvider>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
      <p className="text-[12px] text-muted">{label}</p>
      <div className="mt-1.5 text-[20px] leading-tight font-semibold text-ink tabular-nums">
        {children}
      </div>
    </div>
  );
}

function RunView({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation(["workflows", "common"]);
  const navigate = useNavigate();
  const announce = useAnnounce();
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const live = useLiveRun(run.id, run.status);
  const running = run.status === "running";
  const now = useNow(running);
  const cancel = useCancelRun(run.id);
  const again = useStartRun(workspace.id, run.workflow_id ?? "");
  const agents = useAgentOptions(workspace.id);
  const tools = useTools(workspace.id);
  const [selection, setSelection] = useState<Selection | null>(null);
  const graph = useMemo(() => asGraph(run.graph), [run.graph]);
  const previous = useRef(run.status);
  useDocumentTitle(`${run.workflow_name} — ${t("run.title")}`);

  useEffect(() => {
    if (previous.current === "running" && run.status !== "running") {
      announce(t("run.finished", { status: t(`runs.status.${run.status as RunStatus}`) }));
    }
    previous.current = run.status;
  }, [run.status, announce, t]);

  const names = useMemo<Names>(
    () => ({
      agents: new Map((agents.data ?? []).map((a) => [a.id, a.name])),
      tools: new Map((tools.data ?? []).map((tool) => [tool.id, tool.display_name])),
    }),
    [agents.data, tools.data],
  );
  const steps = [...run.steps].sort((a, b) => a.position - b.position);
  const selected =
    selection?.kind === "node" ? steps.find((s) => s.node_id === selection.id) : undefined;
  const started = run.started_at ? new Date(run.started_at).getTime() : null;
  const elapsed = running && started ? Math.max(0, now - started) : run.duration_ms;
  const canCancel = can(detail.data, "executions:cancel") && running;
  const canRunAgain =
    Boolean(run.workflow_id) &&
    can(detail.data, "executions:launch") &&
    (run.version !== null || can(detail.data, "workflows:write"));
  const failedStep = run.error?.step ? steps.find((s) => s.node_id === run.error?.step) : undefined;

  async function runAgain() {
    const input =
      "json" in run.input ? (run.input.json as Record<string, unknown>) : (textOf(run.input) ?? "");
    try {
      const next = await again.mutateAsync({
        input,
        version: run.version ?? null,
        draft: run.version === null,
      });
      toast.success(t("runDialog.started"));
      void navigate(`${basePath}/workflows/runs/${next.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <PageContainer wide>
      <PageHeader
        breadcrumbs={[
          { label: t("title"), to: `${basePath}/workflows` },
          {
            label: run.workflow_name,
            to: run.workflow_id ? `${basePath}/workflows/${run.workflow_id}` : undefined,
          },
          { label: t("run.title") },
        ]}
        title={run.workflow_name}
        meta={
          <>
            <StatusBadge status={run.status as RunStatus} />
            <Badge tone="outline">
              {run.version ? t("runs.version", { version: run.version }) : t("runs.draft")}
            </Badge>
            {live ? (
              <Badge
                tone="brand"
                icon={<span className="size-1.5 animate-breathe rounded-full bg-brand" />}
              >
                {t("run.live")}
              </Badge>
            ) : null}
          </>
        }
        description={t("run.startedBy", {
          trigger: t(`run.trigger.${run.trigger}`, { defaultValue: run.trigger }),
          who: run.created_by ?? t("run.someone"),
        })}
        actions={
          <>
            {canCancel ? (
              <Button
                variant="secondary"
                leftIcon={<Square aria-hidden />}
                loading={cancel.isPending}
                disabled={Boolean(run.cancel_requested_at)}
                onClick={() =>
                  cancel.mutate(undefined, {
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                {run.cancel_requested_at ? t("run.cancelling") : t("run.cancel")}
              </Button>
            ) : null}
            {run.workflow_id ? (
              <Button asChild variant="secondary" leftIcon={<Pencil aria-hidden />}>
                <Link to={`${basePath}/workflows/${run.workflow_id}`}>{t("run.openEditor")}</Link>
              </Button>
            ) : null}
            {canRunAgain && !running ? (
              <Button
                leftIcon={<RotateCcw aria-hidden />}
                loading={again.isPending}
                onClick={() => void runAgain()}
              >
                {t("run.again")}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t("run.progress")}>
          <span>{t("runs.progress", { done: run.steps_done, total: run.steps_total })}</span>
          <StepsBar
            done={run.steps_done}
            total={run.steps_total}
            status={run.status}
            className="mt-2.5"
          />
        </Metric>
        <Metric label={t("run.duration")}>{formatDuration(elapsed)}</Metric>
        <Metric label={t("run.tokens")}>
          {formatTokens(run.input_tokens + run.output_tokens)}
          <span className="ml-1.5 text-[12px] font-normal text-muted">
            {t("run.tokensSplit", {
              input: formatTokens(run.input_tokens),
              output: formatTokens(run.output_tokens),
            })}
          </span>
        </Metric>
        <Metric label={t("run.cost")}>
          <CostValue
            cost={{
              amount: run.cost_amount,
              currency: "USD",
              source: run.cost_source,
              partial: run.cost_partial,
            }}
            showSource
          />
        </Metric>
      </div>

      <AnimatePresence initial={false}>
        {run.status === "failed" || run.status === "timed_out" ? (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            <Alert
              tone="danger"
              title={t("run.error")}
              className="mb-6"
              action={
                failedStep ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSelection({ kind: "node", id: failedStep.node_id })}
                  >
                    {t("run.showStep")}
                  </Button>
                ) : undefined
              }
            >
              {typeof run.error?.message === "string" ? run.error.message : t("run.noDetails")}
            </Alert>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <WorkflowCanvas
            graph={graph}
            names={names}
            steps={run.steps}
            label={t("editor.runCanvasLabel")}
            selection={selection}
            onSelect={setSelection}
            className="h-[min(64vh,640px)] min-h-[380px] bg-canvas"
          />
        </Card>
        <div className="space-y-6">
          {selected ? (
            <StepDetail step={selected} basePath={basePath} onBack={() => setSelection(null)} />
          ) : (
            <StepList
              steps={steps}
              graphTypes={graph}
              onSelect={(id) => setSelection({ kind: "node", id })}
            />
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("run.input")} />
          <Payload value={run.input} />
        </Card>
        <Card>
          <CardHeader
            title={t("run.output")}
            description={running ? t("run.outputPending") : undefined}
          />
          {run.output ? (
            <Payload value={run.output} />
          ) : (
            <p className="px-5 pb-5 text-[13px] text-muted">
              {running ? t("run.inProgress") : t("run.noOutput")}
            </p>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}

/** Text as text, JSON as formatted JSON (read-only). */
function Payload({ value }: { value: Record<string, unknown> }) {
  const { t } = useTranslation("workflows");
  const json =
    "json" in value && value.json !== null && value.json !== undefined ? value.json : null;
  const text = textOf(value);
  if (json !== null) {
    return (
      <div className="px-5 pb-5">
        <CodeEditor
          value={prettyJson(json)}
          readOnly
          aria-label={t("run.json")}
          maxHeight="320px"
        />
      </div>
    );
  }
  return (
    <pre className="mx-5 mb-5 max-h-80 overflow-auto rounded-field bg-surface-2 p-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
      {text ?? "—"}
    </pre>
  );
}

function StepList({
  steps,
  graphTypes,
  onSelect,
}: {
  steps: WorkflowStep[];
  graphTypes: { nodes?: { id: string; type: string }[] };
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useTranslation("workflows");
  return (
    <Card>
      <CardHeader title={t("run.steps")} description={t("run.selectStep")} />
      <ol className="divide-y divide-line">
        {steps.map((step) => {
          const status = stepStatus(step.status);
          const type = (graphTypes.nodes?.find((n) => n.id === step.node_id)?.type ??
            step.node_type) as Parameters<typeof TypeIcon>[0]["type"];
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onSelect(step.node_id)}
                className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
              >
                <TypeIcon type={type} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {step.label}
                  </span>
                  <span className="block text-[12px] text-muted tabular-nums">
                    {t(`types.${type}`)}
                    {step.duration_ms !== null ? ` · ${formatDuration(step.duration_ms)}` : ""}
                  </span>
                </span>
                <StepStatusBadge status={status} />
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function StepDetail({
  step,
  basePath,
  onBack,
}: {
  step: WorkflowStep;
  basePath: string;
  onBack: () => void;
}) {
  const { t } = useTranslation("workflows");
  const { dateTime } = useFormatters();
  const status = stepStatus(step.status);
  const error = step.error as { code?: string; message?: string } | null;
  return (
    <Card>
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <Button
          size="sm"
          variant="tertiary"
          leftIcon={<ArrowLeft aria-hidden />}
          onClick={onBack}
          className="-ml-2"
        >
          {t("run.allSteps")}
        </Button>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{step.label}</h2>
          <StepStatusBadge status={status} />
          {step.branch ? (
            <Badge tone={step.branch === "true" ? "success" : "neutral"}>
              {t("run.branchTaken", {
                branch: t(
                  step.branch === "true" ? "inspector.branchTrue" : "inspector.branchFalse",
                ),
              })}
            </Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted">{t("run.duration")}</dt>
          <dd className="text-ink tabular-nums">{formatDuration(step.duration_ms)}</dd>
          {step.started_at ? (
            <>
              <dt className="text-muted">{t("run.startedAt")}</dt>
              <dd className="text-ink">{dateTime(step.started_at)}</dd>
            </>
          ) : null}
          {step.attempt > 1 ? (
            <>
              <dt className="text-muted">{t("run.attempts")}</dt>
              <dd className="text-ink">{step.attempt}</dd>
            </>
          ) : null}
          {step.input_tokens + step.output_tokens > 0 ? (
            <>
              <dt className="text-muted">{t("run.tokens")}</dt>
              <dd className="text-ink tabular-nums">
                {formatTokens(step.input_tokens + step.output_tokens)}
              </dd>
            </>
          ) : null}
        </dl>
        {error?.message ? (
          <Alert tone="danger" title={t("run.stepError")}>
            {error.message}
            {error.code ? (
              <code className="ml-1 text-[12px] opacity-80">({error.code})</code>
            ) : null}
          </Alert>
        ) : null}
        {step.execution_id ? (
          <Button asChild variant="secondary" size="sm" leftIcon={<ExternalLink aria-hidden />}>
            <Link to={`${basePath}/executions/${step.execution_id}`}>{t("run.openTrace")}</Link>
          </Button>
        ) : null}
        {step.input !== null && step.input !== undefined ? (
          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">
              {t("run.stepInput")}
            </h3>
            <pre className="max-h-56 overflow-auto rounded-field bg-surface-2 p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
              {textOf(step.input) ?? prettyJson(step.input)}
            </pre>
          </section>
        ) : null}
        {step.output ? (
          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">
              {t("run.stepOutput")}
            </h3>
            <pre className="max-h-72 overflow-auto rounded-field bg-surface-2 p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
              {step.output.json !== null && step.output.json !== undefined
                ? prettyJson(step.output.json)
                : (textOf(step.output) ?? "")}
            </pre>
          </section>
        ) : null}
      </div>
    </Card>
  );
}
